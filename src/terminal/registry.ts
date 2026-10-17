// Terminal registry: the single owner of xterm.js instances, outside React.
//
// Lifecycle
//   - One entry per session, created lazily the first time a <TerminalView> for it mounts.
//   - The entry owns a persistent host <div>. Mounting appends it into the view's container; unmounting
//     moves it into a hidden parking container (display:none). Reparenting keeps the full terminal state.
//     xterm keeps PARSING output while parked (its IntersectionObserver pauses rendering).
//   - `Terminal.open()` runs once, the first time the container is laid out with a non-zero size.
//   - disposeTerminal() is the only real teardown (also triggered automatically when the session's
//     metadata disappears from the store, i.e. the pane was closed or its workspace deleted).
//
// Output (no terminal bytes ever touch React state)
//   - ipc.sessionAttach(id, Channel) on creation and on every (re)start (startedAt changed). Each attach
//     bumps a generation counter; messages from stale channels are ignored.
//   - DATA frame -> term.write(bytes, cb); cb feeds an AckBatcher (ack ≥64 KiB or 30 ms after last parse).
//   - RESET frame (every attach, and when the view fell behind the ring) -> term.reset() queued behind
//     already-pending writes; starts a new ack epoch (the backend zeroed its unacked counter).
//   - Query replies (e.g. ESC[6n -> CPR) flow untouched via onData -> sessionWrite; the backend filters
//     queries out of replayed bytes, so replays never trigger stale replies.
//
// Rendering
//   - WebGL only for terminals that are visible; at most MAX_WEBGL contexts (webglBudget.ts); others DOM.
//   - Context loss -> dispose addon, DOM fallback, retry after 3 s while visible; give up after 3 losses.

import { Channel } from "@tauri-apps/api/core";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type IDisposable } from "@xterm/xterm";
import { isAppShortcut } from "../keybindings";
import { ipc } from "../lib/ipc";
import { FRAME_DATA, FRAME_RESET, type SessionId, type SessionInfo, type Settings } from "../lib/types";
import { isLive, useApp } from "../store/appStore";
import { AckBatcher } from "./ackBatcher";
import { confirmDialogEx, useUi } from "../store/uiStore";
import { checkPaste, pasteTitle } from "./pasteGuard";
import { PRESENTATION_FONT_BOOST, getSearchDecorations, getTerminalTheme } from "./theme";
import { MAX_WEBGL, allocateWebgl, type WebglCandidate } from "./webglBudget";
import { splitForWrite } from "./writeChunks";
import { clampZoom, zoomStep } from "./zoom";

export interface RendererStatus {
  /** Number of terminals currently using the WebGL renderer. */
  webglActive: number;
  /** Number of VISIBLE terminals using the DOM renderer (parked terminals are not rendering at all). */
  domActive: number;
  /** UNMASKED_RENDERER_WEBGL string as reported by the browser, or null if WebGL unavailable. */
  gpuRenderer: string | null;
  webglSupported: boolean;
  contextLosses: number;
}

const WEBGL_RELEASE_GRACE_MS = 400; // keep the context briefly across unmount/remount (layout reshuffles)
const WEBGL_RETRY_MS = 3000;
const WEBGL_MAX_LOSSES = 3;
const FIT_TRAILING_MS = 50;
const NOTICE_SETTLE_MS = 150;

interface Entry {
  id: SessionId;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLDivElement;
  container: HTMLElement | null;
  ro: ResizeObserver;
  opened: boolean;
  mounted: boolean;
  visible: boolean;
  hasSize: boolean;
  focused: boolean;
  shownLast: boolean;
  lastShownAt: number;
  unshownSince: number;
  settingsDirty: boolean;
  disposed: boolean;
  cleanups: (() => void)[];

  // WebGL
  webgl: WebglAddon | null;
  webglSubs: IDisposable[];
  contextLosses: number;
  webglRetryAt: number;
  webglGaveUp: boolean;

  // Output channel
  gen: number;
  channel: Channel<ArrayBuffer> | null;
  batcher: AckBatcher | null;
  attachedStartedAt: string | null;
  attachTries: number;
  attachRetryTimer: number | null;
  lastRuntime: SessionInfo | undefined;

  // Exit notice
  noticeKey: string | null;
  noticeTimer: number | null;

  // Input
  writeChain: Promise<void>;
  lastKeyPasteAt: number;
  lastSentCols: number;
  lastSentRows: number;

  // Sizing
  fitRaf: number | null;
  fitTimer: number | null;
}

const entries = new Map<SessionId, Entry>();
/** Real Windows build (from the backend) for xterm's ConPTY heuristics; 26300 until app_info resolves. */
let windowsBuild = 26300;
ipc
  .appInfo()
  .then((i) => {
    if (i.windowsBuild) windowsBuild = i.windowsBuild;
  })
  .catch(() => {});
const pendingDetach = new Map<SessionId, Promise<unknown>>();
const statusListeners = new Set<(s: RendererStatus) => void>();
let parking: HTMLDivElement | null = null;
let storeUnsub: (() => void) | null = null;
let totalContextLosses = 0;
let lastStatus: RendererStatus | null = null;
/** Per-session font-size offset (zoom). Survives hide/show of the view; dropped with the session. */
const zoomBySession = new Map<SessionId, number>();

// ---- GPU probe ------------------------------------------------------------------------------

let gpuProbed = false;
let webglSupported = false;
let gpuRenderer: string | null = null;

function probeGpu() {
  if (gpuProbed) return;
  gpuProbed = true;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return;
    webglSupported = true;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const r = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gpuRenderer = typeof r === "string" && r.length > 0 ? r : null;
    // Free the probe's context immediately so it never occupies one of Chromium's 16 slots.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    webglSupported = false;
  }
}

// ---- helpers --------------------------------------------------------------------------------

/** Effective terminal settings: persisted settings plus the presentation-mode font boost. */
const settings = (): Settings => {
  const s = useApp.getState().persisted.settings;
  return useUi.getState().presentation ? { ...s, fontSize: s.fontSize + PRESENTATION_FONT_BOOST } : s;
};

function log(level: "info" | "warn" | "error", msg: string) {
  void ipc.log(level, `[terminal] ${msg}`);
}

function getParking(): HTMLDivElement {
  if (!parking) {
    parking = document.createElement("div");
    parking.setAttribute("data-terminal-parking", "");
    parking.style.cssText = "display:none;position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;";
    document.body.appendChild(parking);
  }
  return parking;
}

function isShown(e: Entry): boolean {
  return e.opened && e.mounted && e.visible && e.hasSize && !e.disposed;
}

function containerHasSize(c: HTMLElement | null): boolean {
  return !!c && c.clientWidth > 0 && c.clientHeight > 0;
}

function toBytes(m: unknown): Uint8Array | null {
  if (m instanceof ArrayBuffer) return new Uint8Array(m);
  if (ArrayBuffer.isView(m)) return new Uint8Array(m.buffer, m.byteOffset, m.byteLength);
  if (Array.isArray(m)) return Uint8Array.from(m as number[]);
  return null;
}

function keyLetter(ev: KeyboardEvent): string {
  const k = ev.key.length === 1 ? ev.key.toLowerCase() : "";
  if (k >= "a" && k <= "z") return k;
  // Non-Latin layouts: fall back to the physical key.
  if (ev.code.startsWith("Key") && ev.code.length === 4) return ev.code.slice(3).toLowerCase();
  return k;
}

function safeUrl(uri: string): string | null {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function openLink(ev: MouseEvent, uri: string, sessionId?: SessionId) {
  // Ctrl+click like Windows Terminal / VS Code, so clicks meant for selection never open a browser.
  // Ctrl+Shift+click opens the link in a Gridkeeper browser pane next to this terminal instead.
  if (!ev.ctrlKey) return;
  const url = safeUrl(uri);
  if (!url) return;
  if (ev.shiftKey) {
    void import("../actions/browser").then((m) => m.openBrowserPane({ url, afterId: sessionId }));
    return;
  }
  openUrl(url).catch((err) => log("warn", `openUrl failed: ${String(err)}`));
}

async function copyText(text: string) {
  if (!text) return;
  try {
    await writeText(text);
  } catch {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable */
    }
  }
}

async function readClipboard(): Promise<string> {
  try {
    return (await readText()) ?? "";
  } catch {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return "";
    }
  }
}

// ---- status ---------------------------------------------------------------------------------

function computeStatus(): RendererStatus {
  let webglActive = 0;
  let domActive = 0;
  for (const e of entries.values()) {
    if (e.webgl) webglActive++;
    else if (isShown(e)) domActive++;
  }
  return { webglActive, domActive, gpuRenderer, webglSupported, contextLosses: totalContextLosses };
}

function emitStatus() {
  const s = computeStatus();
  const l = lastStatus;
  if (
    l &&
    l.webglActive === s.webglActive &&
    l.domActive === s.domActive &&
    l.gpuRenderer === s.gpuRenderer &&
    l.webglSupported === s.webglSupported &&
    l.contextLosses === s.contextLosses
  )
    return;
  lastStatus = s;
  for (const cb of statusListeners) {
    try {
      cb(s);
    } catch {
      /* listener error must not break the registry */
    }
  }
}

// ---- WebGL budget ---------------------------------------------------------------------------

let reconcileTimer: number | null = null;
let reconcileAt = Infinity;

function scheduleReconcile(delay = 0) {
  const at = Date.now() + delay;
  if (reconcileTimer !== null && reconcileAt <= at) return;
  if (reconcileTimer !== null) window.clearTimeout(reconcileTimer);
  reconcileAt = at;
  reconcileTimer = window.setTimeout(() => {
    reconcileTimer = null;
    reconcileAt = Infinity;
    reconcile();
  }, delay);
}

function webglAllowed(): boolean {
  probeGpu();
  return webglSupported && settings().renderer !== "dom";
}

function reconcile() {
  const now = Date.now();
  const allowed = webglAllowed();
  const focused = useApp.getState().focusedSessionId;
  let wake = Infinity;
  const candidates: WebglCandidate[] = [];
  for (const e of entries.values()) {
    const shown = isShown(e);
    if (e.shownLast && !shown) e.unshownSince = now;
    e.shownLast = shown;
    if (!allowed || e.webglGaveUp) continue;
    if (now < e.webglRetryAt) {
      if (shown) wake = Math.min(wake, e.webglRetryAt);
      continue;
    }
    const priority = (e.id === focused ? 2 ** 50 : 0) + e.lastShownAt;
    if (shown) candidates.push({ id: e.id, active: !!e.webgl, priority });
    else if (e.webgl && now - e.unshownSince < WEBGL_RELEASE_GRACE_MS) {
      candidates.push({ id: e.id, active: true, priority: 0 });
      wake = Math.min(wake, e.unshownSince + WEBGL_RELEASE_GRACE_MS);
    }
  }
  const target = allocateWebgl(candidates, MAX_WEBGL);
  for (const e of entries.values()) {
    if (target.has(e.id)) {
      if (!e.webgl) enableWebgl(e);
    } else if (e.webgl) disableWebgl(e);
  }
  if (wake !== Infinity) scheduleReconcile(Math.max(0, wake - now) + 5);
  emitStatus();
}

function enableWebgl(e: Entry) {
  let addon: WebglAddon | null = null;
  try {
    addon = new WebglAddon();
    const a = addon;
    e.webglSubs = [a.onContextLoss(() => handleContextLoss(e, a))];
    e.term.loadAddon(a);
    e.webgl = a;
  } catch (err) {
    for (const s of e.webglSubs) s.dispose();
    e.webglSubs = [];
    try {
      addon?.dispose();
    } catch {
      /* ignore */
    }
    e.webgl = null;
    e.webglGaveUp = true;
    log("warn", `WebGL unavailable for ${e.id}, using DOM renderer: ${String(err)}`);
  }
}

function disableWebgl(e: Entry) {
  const a = e.webgl;
  if (!a) return;
  e.webgl = null;
  for (const s of e.webglSubs) s.dispose();
  e.webglSubs = [];
  try {
    a.dispose();
  } catch {
    /* context may already be gone */
  }
}

function handleContextLoss(e: Entry, addon: WebglAddon) {
  if (e.webgl !== addon) return;
  disableWebgl(e);
  e.contextLosses++;
  totalContextLosses++;
  if (e.contextLosses >= WEBGL_MAX_LOSSES) {
    e.webglGaveUp = true;
    log("warn", `WebGL context lost ${e.contextLosses}x for ${e.id}; staying on DOM renderer`);
  } else {
    e.webglRetryAt = Date.now() + WEBGL_RETRY_MS;
    log("warn", `WebGL context lost for ${e.id}; DOM fallback, retry in ${WEBGL_RETRY_MS} ms`);
  }
  scheduleReconcile(0);
  emitStatus();
}

// ---- settings -------------------------------------------------------------------------------

function applyFontSettings(e: Entry, s: Settings) {
  const o = e.term.options;
  const fontSize = s.fontSize + clampZoom(s.fontSize, zoomBySession.get(e.id) ?? 0);
  if (o.fontFamily !== s.fontFamily) o.fontFamily = s.fontFamily;
  if (o.fontSize !== fontSize) o.fontSize = fontSize;
  if (o.lineHeight !== s.lineHeight) o.lineHeight = s.lineHeight;
  e.settingsDirty = false;
}

function applyCheapSettings(e: Entry, s: Settings) {
  const o = e.term.options;
  if (o.scrollback !== s.scrollbackLines) o.scrollback = s.scrollbackLines;
  const blink = s.cursorBlink && e.focused;
  if (o.cursorBlink !== blink) o.cursorBlink = blink;
}

let appliedThemeId: string | null = null;

function onSettingsChanged(s: Settings) {
  // Theme: applies to parked terminals too (no measuring needed); the WebGL addon rebuilds its atlas.
  const themeChanged = s.theme !== appliedThemeId;
  appliedThemeId = s.theme;
  const theme = themeChanged ? getTerminalTheme(s) : null;
  for (const e of entries.values()) {
    if (theme) e.term.options.theme = theme;
    applyCheapSettings(e, s);
    // Font metrics can only be measured while visible; parked terminals pick them up when shown.
    if (isShown(e)) {
      applyFontSettings(e, s);
      scheduleFit(e);
    } else e.settingsDirty = true;
  }
  scheduleReconcile(0);
}

// ---- store subscription ---------------------------------------------------------------------

function ensureStoreSubscription() {
  if (storeUnsub) return;
  let prevSettings = useApp.getState().persisted.settings;
  let prevSessions = useApp.getState().persisted.sessions;
  let prevRuntime = useApp.getState().runtime;
  let prevFocused = useApp.getState().focusedSessionId;
  storeUnsub = useApp.subscribe((s) => {
    if (s.persisted.settings !== prevSettings) {
      prevSettings = s.persisted.settings;
      onSettingsChanged(settings());
    }
    if (s.persisted.sessions !== prevSessions) {
      prevSessions = s.persisted.sessions;
      if (s.loaded && entries.size > 0) {
        const ids = new Set(prevSessions.map((m) => m.id));
        for (const id of [...entries.keys()]) if (!ids.has(id)) disposeTerminal(id);
        for (const id of [...zoomBySession.keys()]) if (!ids.has(id)) zoomBySession.delete(id);
      }
    }
    if (s.runtime !== prevRuntime) {
      prevRuntime = s.runtime;
      for (const e of entries.values()) {
        const info = prevRuntime[e.id];
        if (info !== e.lastRuntime) onRuntime(e, info);
      }
    }
    if (s.focusedSessionId !== prevFocused) {
      prevFocused = s.focusedSessionId;
      scheduleReconcile(0); // focus affects priority for free WebGL slots
    }
  });
  let prevPresentation = useUi.getState().presentation;
  useUi.subscribe((u) => {
    if (u.presentation === prevPresentation) return;
    prevPresentation = u.presentation;
    onSettingsChanged(settings());
  });
}

function onRuntime(e: Entry, info: SessionInfo | undefined) {
  const prev = e.lastRuntime;
  e.lastRuntime = info;
  if (!info) return;
  const st = info.state.state;
  if (isLive(info)) {
    // A (re)started process: attach a fresh channel once per startedAt.
    if (info.startedAt && info.startedAt !== e.attachedStartedAt) {
      e.attachTries = 0;
      void attach(e, info.startedAt);
    }
  } else if (st === "exited" && prev?.state.state !== "exited") {
    scheduleNoticeCheck(e);
  }
}

// ---- output channel -------------------------------------------------------------------------

function dropChannel(e: Entry) {
  const ch = e.channel;
  e.channel = null;
  e.batcher?.dispose();
  e.batcher = null;
  if (!ch) return;
  ch.onmessage = () => {};
  // Unregister the callback a little later so in-flight messages do not log "callback not found".
  window.setTimeout(() => {
    try {
      (ch as unknown as { cleanupCallback?: () => void }).cleanupCallback?.();
    } catch {
      /* ignore */
    }
  }, 2000);
}

async function attach(e: Entry, startedAt: string | null) {
  if (e.disposed) return;
  if (e.attachRetryTimer !== null) {
    window.clearTimeout(e.attachRetryTimer);
    e.attachRetryTimer = null;
  }
  dropChannel(e);
  const gen = ++e.gen;
  e.attachedStartedAt = startedAt;

  let channel: Channel<ArrayBuffer>;
  try {
    channel = new Channel<ArrayBuffer>();
  } catch (err) {
    log("warn", `cannot create channel for ${e.id}: ${String(err)}`);
    return;
  }
  const sendAck = (n: number) => {
    if (gen === e.gen && !e.disposed) ipc.sessionAck(e.id, n).catch(() => {});
  };
  // The backend zeroes its unacked counter when it sends RESET, so every RESET starts a new ack
  // epoch: bytes received before it are never acked afterwards (their callbacks feed a disposed
  // batcher). Every DATA byte received after a RESET is acked once xterm has parsed it.
  let batcher = new AckBatcher(sendAck);
  e.channel = channel;
  e.batcher = batcher;
  e.lastSentCols = e.lastSentRows = 0;

  channel.onmessage = (msg) => {
    if (gen !== e.gen || e.disposed) return;
    const bytes = toBytes(msg);
    if (!bytes || bytes.length === 0) return;
    const kind = bytes[0];
    if (kind === FRAME_DATA) {
      const payload = bytes.subarray(1);
      const n = payload.length; // ack unit = frame byteLength - 1
      if (n === 0) return;
      const b = batcher;
      try {
        e.term.write(payload, () => b.add(n));
      } catch {
        // xterm's hard 50 MB buffer limit: data discarded. Ack anyway so the backend never stalls.
        b.add(n);
      }
      if (e.noticeTimer !== null) scheduleNoticeCheck(e);
    } else if (kind === FRAME_RESET) {
      batcher.dispose();
      batcher = new AckBatcher(sendAck);
      e.batcher = batcher;
      e.noticeKey = null;
      // Queue the reset behind data already handed to xterm so it cannot overtake it.
      e.term.write("", () => {
        if (gen === e.gen && !e.disposed) e.term.reset();
      });
      scheduleNoticeCheck(e);
    }
  };

  const detaching = pendingDetach.get(e.id);
  if (detaching) await detaching.catch(() => {});
  if (gen !== e.gen || e.disposed) return;
  try {
    const info = await ipc.sessionAttach(e.id, channel);
    if (gen !== e.gen || e.disposed) return;
    // Only adopt the backend's startedAt when we had none (e.g. right after a webview reload);
    // otherwise keep the store's value so the re-attach trigger compares like with like.
    if (e.attachedStartedAt === null && info?.startedAt) e.attachedStartedAt = info.startedAt;
    e.attachTries = 0;
    syncPtySize(e);
  } catch {
    if (gen !== e.gen || e.disposed) return;
    // Not started yet (or already gone). Retry a few times only while the store says it is live.
    const info = useApp.getState().runtime[e.id];
    if (isLive(info) && e.attachTries < 5) {
      e.attachTries++;
      e.attachRetryTimer = window.setTimeout(() => {
        e.attachRetryTimer = null;
        const cur = useApp.getState().runtime[e.id];
        if (!e.disposed && isLive(cur)) void attach(e, cur?.startedAt ?? null);
      }, 300 * e.attachTries);
    } else if (info?.state.state === "exited") {
      scheduleNoticeCheck(e);
    }
  }
}

// ---- exit notice ----------------------------------------------------------------------------

function scheduleNoticeCheck(e: Entry, delay = NOTICE_SETTLE_MS) {
  if (e.noticeTimer !== null) window.clearTimeout(e.noticeTimer);
  e.noticeTimer = window.setTimeout(() => {
    e.noticeTimer = null;
    maybeWriteExitNotice(e);
  }, delay);
}

function maybeWriteExitNotice(e: Entry) {
  if (e.disposed) return;
  const info = useApp.getState().runtime[e.id];
  if (!info || info.state.state !== "exited") return;
  const key = `${info.startedAt}|${info.endedAt}|${info.state.code}`;
  if (e.noticeKey === key) return;
  e.noticeKey = key;
  const code = info.state.code;
  // Turn off mouse reporting a crashed TUI may have left on, so the final output stays selectable.
  e.term.write("\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l");
  writeNotice(e, code === null ? "[process exited]" : `[process exited with code ${code}]`);
}

function writeNotice(e: Entry, text: string) {
  // Decide on the leading newline once all pending output has been parsed.
  e.term.write("", () => {
    if (e.disposed) return;
    const pre = e.term.buffer.active.cursorX === 0 ? "" : "\r\n";
    e.term.write(`${pre}\x1b[2m${text}\x1b[0m\r\n`);
  });
}

// ---- input ----------------------------------------------------------------------------------

/** xterm onBinary: each char code is one raw byte (must not be UTF-8 encoded). */
function sendBinary(e: Entry, data: string) {
  if (e.disposed || !data) return;
  const info = useApp.getState().runtime[e.id];
  if (info && !isLive(info)) return;
  const bytes = Array.from(data, (c) => c.charCodeAt(0) & 0xff);
  e.writeChain = e.writeChain.then(() => ipc.sessionWriteBinary(e.id, bytes).catch(() => {}));
}

function sendInput(e: Entry, data: string) {
  if (e.disposed || !data) return;
  const info = useApp.getState().runtime[e.id];
  if (info && !isLive(info)) return; // exited/failed: nothing to write to
  const parts = splitForWrite(data);
  e.writeChain = e.writeChain.then(async () => {
    for (const p of parts) {
      if (e.disposed) return;
      await ipc.sessionWrite(e.id, p).catch(() => {});
    }
  });
}

function pasteCheck(e: Entry, text: string) {
  return checkPaste(text, {
    bracketed: e.term.modes.bracketedPasteMode,
    enabled: useApp.getState().persisted.settings.pasteWarning !== false,
  });
}

/**
 * Paste with a guard: a large paste (>64 KiB or >20 lines) into a program that has NOT enabled bracketed
 * paste would arrive as typed lines (each newline = Enter), so ask first. Programs that enabled bracketed
 * paste (term.modes.bracketedPasteMode, e.g. Claude Code, Codex) are never prompted.
 */
async function guardedPaste(e: Entry, text: string) {
  if (!text || e.disposed) return;
  const check = pasteCheck(e, text);
  if (check.confirm) {
    const name = useApp.getState().persisted.sessions.find((m) => m.id === e.id)?.name ?? "this session";
    const preview = text.split(/\r\n|\r|\n/, 4).map((l) => (l.length > 120 ? `${l.slice(0, 120)}…` : l));
    const { ok, checked } = await confirmDialogEx({
      title: pasteTitle(check, name),
      message:
        "This program has not enabled bracketed paste, so every line break is sent as Enter and each line may run as a command.",
      detail: preview.join("\n") + (check.lines > preview.length ? "\n…" : ""),
      confirmLabel: "Paste",
      checkbox: "Don't ask again",
    });
    if (!ok || e.disposed) return;
    if (checked) useApp.getState().updateSettings({ pasteWarning: false });
  }
  e.term.paste(text); // applies bracketed paste when the program enabled it
}

async function pasteFromClipboard(e: Entry) {
  const text = await readClipboard();
  if (!text || e.disposed) return;
  await guardedPaste(e, text);
}

function copySelection(e: Entry, clear: boolean) {
  const sel = e.term.getSelection();
  if (!sel) return;
  void copyText(sel);
  if (clear) e.term.clearSelection();
}

function installKeyHandler(e: Entry) {
  const term = e.term;
  term.attachCustomKeyEventHandler((ev) => {
    if (isAppShortcut(ev)) return false;
    // Only plain Ctrl(+Shift) combos are ours; AltGr (Ctrl+Alt) and everything else go to xterm.
    if (!ev.ctrlKey || ev.altKey || ev.metaKey) return true;
    const k = keyLetter(ev);
    if (k === "c") {
      if (ev.shiftKey) {
        if (ev.type === "keydown") {
          ev.preventDefault();
          copySelection(e, false);
        }
        return false;
      }
      if (term.hasSelection()) {
        if (ev.type === "keydown") {
          ev.preventDefault();
          copySelection(e, true);
        }
        return false;
      }
      return true; // no selection: xterm sends ^C
    }
    if (k === "v") {
      if (ev.type === "keydown") {
        // preventDefault suppresses WebView2's native paste event -> exactly one paste.
        ev.preventDefault();
        e.lastKeyPasteAt = Date.now();
        void pasteFromClipboard(e);
      }
      return false;
    }
    return true;
  });
}

// ---- sizing ---------------------------------------------------------------------------------

function scheduleFit(e: Entry) {
  if (e.disposed) return;
  if (e.fitRaf === null) {
    e.fitRaf = window.requestAnimationFrame(() => {
      e.fitRaf = null;
      doFit(e);
    });
  }
  if (e.fitTimer !== null) window.clearTimeout(e.fitTimer);
  e.fitTimer = window.setTimeout(() => {
    e.fitTimer = null;
    doFit(e);
  }, FIT_TRAILING_MS);
}

function ensureOpened(e: Entry) {
  if (e.opened || e.disposed || !e.container || !containerHasSize(e.container)) return;
  if (e.el.parentElement !== e.container) e.container.appendChild(e.el);
  applyFontSettings(e, settings());
  e.term.open(e.el);
  e.opened = true;
  const ta = e.term.textarea;
  if (ta) {
    const onFocus = () => {
      e.focused = true;
      applyCheapSettings(e, settings());
      const st = useApp.getState();
      if (st.focusedSessionId !== e.id) st.setFocused(e.id);
    };
    const onBlur = () => {
      e.focused = false;
      applyCheapSettings(e, settings());
    };
    ta.addEventListener("focus", onFocus);
    ta.addEventListener("blur", onBlur);
    e.cleanups.push(() => {
      ta.removeEventListener("focus", onFocus);
      ta.removeEventListener("blur", onBlur);
    });
  }
}

function doFit(e: Entry) {
  if (e.disposed) return;
  const had = e.hasSize;
  e.hasSize = e.mounted && containerHasSize(e.container);
  if (e.hasSize) {
    ensureOpened(e);
    if (e.settingsDirty && e.visible) applyFontSettings(e, settings());
    if (e.opened) {
      const dims = e.fit.proposeDimensions();
      if (dims && Number.isFinite(dims.cols) && Number.isFinite(dims.rows) && dims.cols >= 2 && dims.rows >= 1) {
        if (dims.cols !== e.term.cols || dims.rows !== e.term.rows) e.fit.fit();
      }
      syncPtySize(e);
    }
  }
  if (had !== e.hasSize || isShown(e) !== e.shownLast) scheduleReconcile(0);
}

function syncPtySize(e: Entry) {
  if (!e.opened || e.disposed) return;
  const { cols, rows } = e.term;
  if (cols === e.lastSentCols && rows === e.lastSentRows) return;
  const info = useApp.getState().runtime[e.id];
  if (!isLive(info)) return;
  e.lastSentCols = cols;
  e.lastSentRows = rows;
  ipc.sessionResize(e.id, cols, rows).catch(() => {
    if (e.lastSentCols === cols && e.lastSentRows === rows) e.lastSentCols = e.lastSentRows = 0;
  });
}

function estimateSize(container: Element | null): { cols: number; rows: number } | null {
  if (!container) return null;
  const w = (container as HTMLElement).clientWidth;
  const h = (container as HTMLElement).clientHeight;
  if (!w || !h) return null;
  const s = settings();
  const cellW = s.fontSize * 0.6;
  const cellH = Math.ceil(s.fontSize * 1.2 * s.lineHeight);
  const cols = Math.max(20, Math.floor((w - 20) / cellW));
  const rows = Math.max(5, Math.floor((h - 6) / cellH));
  return { cols, rows };
}

function findContainer(id: SessionId): Element | null {
  for (const el of document.querySelectorAll("[data-terminal-container]"))
    if (el.getAttribute("data-terminal-container") === id) return el;
  return null;
}

// ---- entry creation -------------------------------------------------------------------------

function createEntry(id: SessionId): Entry {
  ensureStoreSubscription();
  probeGpu();
  const s = settings();
  if (appliedThemeId === null) appliedThemeId = s.theme;
  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: s.fontFamily,
    fontSize: s.fontSize,
    lineHeight: s.lineHeight,
    scrollback: s.scrollbackLines,
    cursorBlink: false,
    cursorStyle: "block",
    cursorInactiveStyle: "outline",
    windowsPty: { backend: "conpty", buildNumber: windowsBuild },
    macOptionIsMeta: false,
    rightClickSelectsWord: false,
    theme: getTerminalTheme(s),
    smoothScrollDuration: 0,
    linkHandler: { activate: (ev, uri) => openLink(ev, uri, id), allowNonHttpProtocols: false },
  });
  const fit = new FitAddon();
  const search = new SearchAddon({ highlightLimit: 1000 });
  term.loadAddon(fit);
  term.loadAddon(search);
  try {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
  } catch (err) {
    log("warn", `unicode11 unavailable: ${String(err)}`);
  }

  const el = document.createElement("div");
  el.className = "gk-term";
  el.setAttribute("data-terminal-host", id);

  const e: Entry = {
    id,
    term,
    fit,
    search,
    el,
    container: null,
    ro: new ResizeObserver(() => scheduleFit(e)),
    opened: false,
    mounted: false,
    visible: false,
    hasSize: false,
    focused: false,
    shownLast: false,
    lastShownAt: 0,
    unshownSince: 0,
    settingsDirty: false,
    disposed: false,
    cleanups: [],
    webgl: null,
    webglSubs: [],
    contextLosses: 0,
    webglRetryAt: 0,
    webglGaveUp: false,
    gen: 0,
    channel: null,
    batcher: null,
    attachedStartedAt: null,
    attachTries: 0,
    attachRetryTimer: null,
    lastRuntime: useApp.getState().runtime[id],
    noticeKey: null,
    noticeTimer: null,
    writeChain: Promise.resolve(),
    lastKeyPasteAt: 0,
    lastSentCols: 0,
    lastSentRows: 0,
    fitRaf: null,
    fitTimer: null,
  };

  term.loadAddon(
    new WebLinksAddon((ev, uri) => openLink(ev, uri, id), {
      hover: () => (el.title = "Ctrl+click: open in browser · Ctrl+Shift+click: open in a Gridkeeper browser pane"),
      leave: () => (el.title = ""),
    }),
  );

  const subs = [term.onData((d) => sendInput(e, d)), term.onBinary((d) => sendBinary(e, d))];
  e.cleanups.push(() => subs.forEach((d) => d.dispose()));
  installKeyHandler(e);

  // Exactly-once paste: a native paste event right after our Ctrl+V handling is swallowed.
  // Other native pastes (Shift+Insert, Ctrl+Shift+V) go through the same paste guard.
  const onPaste = (ev: ClipboardEvent) => {
    if (Date.now() - e.lastKeyPasteAt < 1000) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }
    const text = ev.clipboardData?.getData("text/plain") ?? "";
    if (!text || !pasteCheck(e, text).confirm) return; // xterm's own paste handling
    ev.preventDefault();
    ev.stopImmediatePropagation();
    void guardedPaste(e, text);
  };
  // Right-click: copy if there is a selection, else paste (Windows Terminal behaviour).
  const onContextMenu = (ev: MouseEvent) => {
    ev.preventDefault();
    if (term.modes.mouseTrackingMode !== "none" && !ev.shiftKey) return; // the program owns the mouse
    if (term.hasSelection()) copySelection(e, true);
    else void pasteFromClipboard(e);
  };
  el.addEventListener("paste", onPaste, true);
  el.addEventListener("contextmenu", onContextMenu, true);
  e.cleanups.push(() => {
    el.removeEventListener("paste", onPaste, true);
    el.removeEventListener("contextmenu", onContextMenu, true);
  });

  entries.set(id, e);
  const info = useApp.getState().runtime[id];
  void attach(e, info?.startedAt ?? null);
  if (info?.state.state === "exited") scheduleNoticeCheck(e, 600);
  return e;
}

// ---- public API (used by TerminalView) ------------------------------------------------------

/** Mount a session's terminal into `container` (creating it on first use). */
export function mountTerminal(id: SessionId, container: HTMLElement): void {
  const e = entries.get(id) ?? createEntry(id);
  if (e.container && e.container !== container) e.ro.unobserve(e.container);
  e.container = container;
  e.mounted = true;
  if (e.el.parentElement !== container) container.appendChild(e.el);
  e.ro.observe(container);
  doFit(e);
  scheduleFit(e);
  const active = document.activeElement;
  if (e.opened && useApp.getState().focusedSessionId === id && (!active || active === document.body)) e.term.focus();
  scheduleReconcile(0);
}

/** Park a session's terminal (kept alive, still parsing output). No-op if `container` is stale. */
export function unmountTerminal(id: SessionId, container: HTMLElement): void {
  const e = entries.get(id);
  if (!e || e.container !== container) return;
  e.ro.unobserve(container);
  e.container = null;
  e.mounted = false;
  e.hasSize = false;
  getParking().appendChild(e.el);
  scheduleReconcile(0);
}

/** Visibility of the mounted view (inactive group / hidden pane => false). Drives the WebGL budget. */
export function setTerminalVisible(id: SessionId, visible: boolean, container?: HTMLElement): void {
  const e = entries.get(id);
  if (!e || (container && e.container !== container) || e.visible === visible) return;
  e.visible = visible;
  if (visible) {
    e.lastShownAt = Date.now();
    scheduleFit(e);
  }
  scheduleReconcile(0);
}

export function hasTerminal(id: SessionId): boolean {
  return entries.has(id);
}

// ---- public API (contract) ------------------------------------------------------------------

export function getTerminalSize(id: SessionId): { cols: number; rows: number } | null {
  const e = entries.get(id);
  if (e?.opened) return { cols: e.term.cols, rows: e.term.rows };
  return estimateSize(e?.container ?? findContainer(id));
}

export function clearTerminal(id: SessionId): void {
  entries.get(id)?.term.clear();
}

export function focusTerminal(id: SessionId): void {
  const e = entries.get(id);
  if (e?.opened) e.term.focus();
}

export function getSelection(id: SessionId): string {
  return entries.get(id)?.term.getSelection() ?? "";
}

export function scrollToBottom(id: SessionId): void {
  entries.get(id)?.term.scrollToBottom();
}

/** Write a dim, local-only line (never sent to the process). */
export function writeLocalNotice(id: SessionId, text: string): void {
  const e = entries.get(id);
  if (e) writeNotice(e, text);
}


/** Find `query` in the scrollback. Returns whether a match was found. */
export function findInTerminal(
  id: SessionId,
  query: string,
  dir: "next" | "prev" = "next",
  opts: { caseSensitive?: boolean; regex?: boolean; wholeWord?: boolean; incremental?: boolean } = {},
): boolean {
  const e = entries.get(id);
  if (!e || !query) return false;
  try {
    const o = { ...opts, decorations: getSearchDecorations(settings()) };
    return dir === "next" ? e.search.findNext(query, o) : e.search.findPrevious(query, o);
  } catch {
    return false; // invalid regex
  }
}

export function clearSearch(id: SessionId): void {
  const e = entries.get(id);
  if (!e) return;
  e.search.clearDecorations();
  e.term.clearSelection();
}

/** Match counts for the find bar (`index` -1 when beyond the highlight limit). Returns unsubscribe. */
export function onSearchResults(id: SessionId, cb: (r: { index: number; count: number }) => void): () => void {
  const e = entries.get(id);
  if (!e) return () => {};
  const d = e.search.onDidChangeResults((r) => cb({ index: r.resultIndex, count: r.resultCount }));
  return () => d.dispose();
}

/**
 * Per-pane font zoom: 1 = in, -1 = out, 0 = reset. Refits the terminal (which resizes the PTY).
 * Returns the new font size, or null when the session has no terminal.
 */
export function zoomTerminal(id: SessionId, dir: 1 | -1 | 0): number | null {
  const e = entries.get(id);
  if (!e) return null;
  const s = settings();
  const next = zoomStep(s.fontSize, zoomBySession.get(id) ?? 0, dir);
  if (next === 0) zoomBySession.delete(id);
  else zoomBySession.set(id, next);
  if (isShown(e)) {
    applyFontSettings(e, s);
    scheduleFit(e);
  } else e.settingsDirty = true;
  return s.fontSize + next;
}

/** Refit and repaint every visible terminal (after sleep/resume or a long absence). */
export function refitAllTerminals(): void {
  for (const e of entries.values()) {
    if (!isShown(e)) continue;
    e.lastSentCols = e.lastSentRows = 0; // re-send the PTY size even if unchanged
    scheduleFit(e);
    try {
      e.term.refresh(0, e.term.rows - 1);
    } catch {
      /* not rendered yet */
    }
  }
  scheduleReconcile(0);
}

export function getRendererStatus(): RendererStatus {
  probeGpu();
  return computeStatus();
}

/** Subscribe to renderer status changes; returns unsubscribe. */
export function onRendererStatus(cb: (s: RendererStatus) => void): () => void {
  statusListeners.add(cb);
  return () => void statusListeners.delete(cb);
}

/** Dispose a session's terminal entirely (view hidden or session closed). */
export function disposeTerminal(id: SessionId): void {
  const e = entries.get(id);
  if (!e) return;
  entries.delete(id);
  e.disposed = true;
  e.gen++;
  const hadChannel = !!e.channel;
  dropChannel(e);
  if (hadChannel) {
    const p = ipc.sessionDetach(id).catch(() => {});
    pendingDetach.set(id, p);
    void p.then(() => {
      if (pendingDetach.get(id) === p) pendingDetach.delete(id);
    });
  }
  for (const t of [e.attachRetryTimer, e.noticeTimer, e.fitTimer]) if (t !== null) window.clearTimeout(t);
  if (e.fitRaf !== null) window.cancelAnimationFrame(e.fitRaf);
  e.ro.disconnect();
  disableWebgl(e);
  for (const fn of e.cleanups) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  e.cleanups = [];
  try {
    e.term.dispose();
  } catch {
    /* ignore */
  }
  e.el.remove();
  e.container = null;
  scheduleReconcile(0);
  emitStatus();
}

// ---- debug hooks ----------------------------------------------------------------------------

declare global {
  interface Window {
    __gridkeeperForceContextLoss?: (id?: SessionId) => string;
    /** Diagnostics: per-terminal renderer/flow state and buffer text. */
    __gridkeeperTerminals?: {
      list: () => { id: string; opened: boolean; shown: boolean; webgl: boolean; losses: number; cols: number; rows: number }[];
      text: (id: SessionId) => string;
    };
  }
}

if (typeof window !== "undefined") {
  window.__gridkeeperTerminals = {
    list: () =>
      [...entries.values()].map((e) => ({
        id: e.id,
        opened: e.opened,
        shown: isShown(e),
        webgl: !!e.webgl,
        losses: e.contextLosses,
        cols: e.term.cols,
        rows: e.term.rows,
      })),
    text: (id) => {
      const e = entries.get(id);
      if (!e) return "";
      const b = e.term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? "");
      return lines.join("\n").replace(/\n+$/, "");
    },
  };

  /** Simulate a GPU context loss on a terminal's WebGL canvas to exercise recovery. */
  window.__gridkeeperForceContextLoss = (id?: SessionId) => {
    const focused = useApp.getState().focusedSessionId;
    const e =
      (id ? entries.get(id) : undefined) ??
      (focused && entries.get(focused)?.webgl ? entries.get(focused) : undefined) ??
      [...entries.values()].find((x) => x.webgl);
    if (!e || !e.webgl) return "no terminal with an active WebGL renderer";
    for (const c of e.el.querySelectorAll("canvas")) {
      const gl = c.getContext("webgl2");
      const ext = gl?.getExtension("WEBGL_lose_context");
      if (ext) {
        ext.loseContext();
        return `forced context loss on ${e.id}`;
      }
    }
    return "WebGL canvas not found";
  };
}
