// Brain panel state and actions (long-term project memory; files: lib/brain.ts, Rust: src-tauri/src/brain.rs).
// Ephemeral zustand store. The per-project preferences (capture suggestions, auto-approve, mention in briefs) live
// in localStorage keyed by the normalized project folder — deliberately NOT in the project folder, so an agent can
// never switch on auto-approve for itself.
// The panel holds a ref-counted mission watch of its project while open (no polling); Rust reports agents' note
// edits as `mission-changed` with file "brain" and the index is re-read. Every write goes through Rust (atomic,
// redacted, conflict-checked); deletes return the text, so Forget / Discard offer Undo.

import { create } from "zustand";
import { notify } from "../actions/notify";
import { t } from "../i18n";
import { newNoteText, slugForTitle, type BrainKind } from "../lib/brain";
import { errorMessage, ipc, onMissionChanged } from "../lib/ipc";
import type { BrainHit, BrainIndex, BrainNoteFile } from "../lib/types";
import { selectActiveWorkspace, useApp } from "./appStore";
import { dirKey } from "./missionDoc";
import { actionToast, confirmDialog } from "./uiStore";

// ---- preferences (localStorage, per project) ------------------------------------------------------------

export interface BrainPrefs {
  /** Turn board / review / lead events into suggestions in inbox/ (default on). */
  capture: boolean;
  /** Gridkeeper's own captured suggestions go straight to notes/ (default off). Agent-written inbox files always wait. */
  autoApprove: boolean;
  /** "Brief team…" and formation starter prompts point agents at the brain (default on). */
  briefs: boolean;
}

export const DEFAULT_BRAIN_PREFS: Readonly<BrainPrefs> = Object.freeze({ capture: true, autoApprove: false, briefs: true });
export const BRAIN_PREFS_PREFIX = "gridkeeper.brain.v1:";

/** The webview's localStorage; null outside a browser (tests) or when blocked. */
function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

export function brainPrefs(dir: string | null | undefined): BrainPrefs {
  if (!dir) return { ...DEFAULT_BRAIN_PREFS };
  try {
    const raw = storage()?.getItem(BRAIN_PREFS_PREFIX + dirKey(dir)) ?? null;
    const v = raw ? (JSON.parse(raw) as Partial<BrainPrefs>) : {};
    return {
      capture: typeof v.capture === "boolean" ? v.capture : DEFAULT_BRAIN_PREFS.capture,
      autoApprove: typeof v.autoApprove === "boolean" ? v.autoApprove : DEFAULT_BRAIN_PREFS.autoApprove,
      briefs: typeof v.briefs === "boolean" ? v.briefs : DEFAULT_BRAIN_PREFS.briefs,
    };
  } catch {
    return { ...DEFAULT_BRAIN_PREFS };
  }
}

export function setBrainPrefs(dir: string, patch: Partial<BrainPrefs>): void {
  const next = { ...brainPrefs(dir), ...patch };
  try {
    storage()?.setItem(BRAIN_PREFS_PREFIX + dirKey(dir), JSON.stringify(next));
  } catch {
    /* storage unavailable: the setting lasts until the panel re-reads it */
  }
  useBrain.setState((s) => ({ prefsVersion: s.prefsVersion + 1 }));
}

/** The briefs of the project of a mission file mention the brain. */
export function brainBriefsOn(projectDir: string | null | undefined): boolean {
  return brainPrefs(projectDir).briefs;
}

// ---- state ----------------------------------------------------------------------------------------------

export interface BrainEntry {
  index: BrainIndex | null;
  loading: boolean;
  error: string | null;
}

export const EMPTY_BRAIN: BrainEntry = { index: null, loading: false, error: null };

export type BrainTab = "notes" | "inbox";

export interface Selection {
  slug: string;
  inbox: boolean;
}

/** The "add memory" dialog's prefill. */
export interface ComposeRequest {
  dir: string;
  title: string;
  kind: BrainKind;
  tags: string[];
  body: string;
  source: string;
  supersedes: string | null;
  /** Where Save writes: notes/ (confirmed, the user wrote it) or inbox/ (suggested). */
  target: "notes" | "inbox";
}

interface BrainState {
  open: boolean;
  /** The panel's project folder (the active workspace's when it opened). */
  dir: string | null;
  byDir: Record<string, BrainEntry>;
  query: string;
  /** Search results for `query` (null = no query). */
  hits: BrainHit[] | null;
  searching: boolean;
  kind: BrainKind | "all";
  tag: string | null;
  tab: BrainTab;
  selected: Selection | null;
  compose: ComposeRequest | null;
  /** Bumped when preferences change (they live in localStorage). */
  prefsVersion: number;
}

export const useBrain = create<BrainState>()(() => ({
  open: false,
  dir: null,
  byDir: {},
  query: "",
  hits: null,
  searching: false,
  kind: "all",
  tag: null,
  tab: "notes",
  selected: null,
  compose: null,
  prefsVersion: 0,
}));

function activeProjectDir(): string | null {
  return selectActiveWorkspace(useApp.getState())?.projectDir ?? null;
}

export function openBrain(opts: { dir?: string | null; tab?: BrainTab; select?: Selection | null } = {}): void {
  const dir = opts.dir !== undefined ? opts.dir : activeProjectDir();
  const s = useBrain.getState();
  const sameDir = s.dir === dir;
  useBrain.setState({
    open: true,
    dir,
    tab: opts.tab ?? (sameDir ? s.tab : "notes"),
    selected: opts.select !== undefined ? opts.select : sameDir ? s.selected : null,
    ...(sameDir ? {} : { query: "", hits: null, kind: "all" as const, tag: null }),
  });
}

export function closeBrain(): void {
  useBrain.setState({ open: false });
}

export function toggleBrain(): void {
  if (useBrain.getState().open) closeBrain();
  else openBrain();
}

export function patchBrain(p: Partial<Pick<BrainState, "query" | "kind" | "tag" | "tab" | "selected">>): void {
  useBrain.setState(p);
}

function patchEntry(dir: string, p: Partial<BrainEntry>) {
  useBrain.setState((s) => ({ byDir: { ...s.byDir, [dir]: { ...(s.byDir[dir] ?? EMPTY_BRAIN), ...p } } }));
}

// ---- reading + watching -----------------------------------------------------------------------------------

const inflight = new Set<string>();
const again = new Set<string>();

/** Re-read the brain index. Bursts coalesce into at most one extra read. */
export async function reloadBrain(dir: string): Promise<void> {
  if (inflight.has(dir)) {
    again.add(dir);
    return;
  }
  inflight.add(dir);
  try {
    do {
      again.delete(dir);
      if (!useBrain.getState().byDir[dir]?.index) patchEntry(dir, { loading: true });
      try {
        const index = await ipc.brainList(dir);
        patchEntry(dir, { index, loading: false, error: null });
      } catch (e) {
        patchEntry(dir, { loading: false, error: errorMessage(e) });
      }
    } while (again.has(dir));
  } finally {
    inflight.delete(dir);
  }
  const s = useBrain.getState();
  if (s.dir === dir && s.query.trim()) void runSearch(dir, s.query);
}

const holds = new Map<string, number>();
let unlisten: Promise<(() => void) | null> | null = null;

function ensureListener() {
  if (unlisten) return;
  unlisten = onMissionChanged((ev) => {
    if (ev.file && ev.file !== "brain") return;
    const key = dirKey(ev.projectDir);
    for (const dir of holds.keys()) if (dirKey(dir) === key) void reloadBrain(dir);
  }).catch(() => null);
}

/** Watch + read `dir` until the returned release function is called (the panel, while open). */
export function acquireBrain(dir: string): () => void {
  const n = (holds.get(dir) ?? 0) + 1;
  holds.set(dir, n);
  if (n === 1) {
    ensureListener();
    ipc.missionWatch(dir).catch(() => {
      /* no watcher: the panel still updates after its own writes */
    });
    void reloadBrain(dir);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holds.get(dir) ?? 1) - 1;
    if (left > 0) {
      holds.set(dir, left);
      return;
    }
    holds.delete(dir);
    ipc.missionUnwatch(dir).catch(() => {});
    if (holds.size === 0) {
      const p = unlisten;
      unlisten = null;
      void p?.then((off) => off?.());
    }
  };
}

let searchSeq = 0;

/** Ranked full-text search (Rust); results land in `hits` unless a newer search started meanwhile. */
export async function runSearch(dir: string, query: string): Promise<void> {
  const n = ++searchSeq;
  if (!query.trim()) {
    useBrain.setState({ hits: null, searching: false });
    return;
  }
  useBrain.setState({ searching: true });
  try {
    const hits = await ipc.brainSearch(dir, query);
    if (n === searchSeq) useBrain.setState({ hits, searching: false });
  } catch (e) {
    if (n === searchSeq) useBrain.setState({ hits: [], searching: false });
    ipc.log("warn", `brain search failed: ${errorMessage(e)}`);
  }
}

// ---- writing ----------------------------------------------------------------------------------------------

export function isConflict(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: unknown }).code === "conflict";
}

function isNotFound(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { code?: unknown }).code === "not_found";
}

export type SaveResult = { ok: true; file: BrainNoteFile; redacted: boolean } | { ok: false; conflict: boolean };

/** Write a note with the conflict check (`expected` = modification time it was based on; null = must be new). */
export async function saveNote(dir: string, slug: string, inbox: boolean, text: string, expected: number | null): Promise<SaveResult> {
  try {
    const file = await ipc.brainWrite(dir, slug, text, inbox, expected);
    void reloadBrain(dir);
    const redacted = file.text !== text;
    if (redacted) notify("warn", t("brain.toast.masked"));
    return { ok: true, file, redacted };
  } catch (e) {
    if (isConflict(e)) {
      notify("warn", t("brain.toast.conflict"));
      void reloadBrain(dir);
      return { ok: false, conflict: true };
    }
    notify("error", t("brain.toast.saveFailed", { error: errorMessage(e) }));
    return { ok: false, conflict: false };
  }
}

/** Write `text` back as a new note (Undo of a delete); a name taken meanwhile gets a free one. */
async function restore(dir: string, slug: string, inbox: boolean, text: string): Promise<void> {
  try {
    await ipc.brainWrite(dir, slug, text, inbox, null);
  } catch (e) {
    if (!isConflict(e)) {
      notify("error", t("brain.toast.restoreFailed", { error: errorMessage(e) }));
      return;
    }
    const idx = useBrain.getState().byDir[dir]?.index;
    const taken = [...(idx?.notes ?? []), ...(idx?.inbox ?? [])].map((n) => n.slug).concat(slug);
    const other = slugForTitle(slug, taken);
    try {
      await ipc.brainWrite(dir, other, text, inbox, null);
    } catch (e2) {
      notify("error", t("brain.toast.restoreFailed", { error: errorMessage(e2) }));
      return;
    }
  }
  void reloadBrain(dir);
}

async function remove(dir: string, slug: string, inbox: boolean, title: string): Promise<boolean> {
  let text: string;
  try {
    text = await ipc.brainDelete(dir, slug, inbox);
  } catch (e) {
    if (isNotFound(e)) void reloadBrain(dir);
    else notify("error", t(inbox ? "brain.toast.discardFailed" : "brain.toast.forgetFailed", { error: errorMessage(e) }));
    return false;
  }
  const sel = useBrain.getState().selected;
  if (sel && sel.slug === slug && sel.inbox === inbox) useBrain.setState({ selected: null });
  void reloadBrain(dir);
  actionToast({ kind: "info", message: t(inbox ? "brain.toast.discarded" : "brain.toast.forgot", { title }), action: { label: t("brain.toast.undo"), run: () => void restore(dir, slug, inbox, text) } });
  return true;
}

/** Forget a confirmed note (toast with Undo). */
export function forgetNote(dir: string, slug: string, title: string): Promise<boolean> {
  return remove(dir, slug, false, title);
}

/** Discard a suggestion from the inbox (toast with Undo). */
export function discardSuggestion(dir: string, slug: string, title: string): Promise<boolean> {
  return remove(dir, slug, true, title);
}

/** Approve a suggestion: inbox/ → notes/ as confirmed. Selects the approved note. */
export async function approveSuggestion(dir: string, slug: string): Promise<string | null> {
  try {
    const target = await ipc.brainApprove(dir, slug);
    const s = useBrain.getState();
    if (s.selected?.slug === slug && s.selected.inbox) useBrain.setState({ selected: { slug: target, inbox: false } });
    void reloadBrain(dir);
    return target;
  } catch (e) {
    if (isNotFound(e)) void reloadBrain(dir);
    else notify("error", t("brain.toast.approveFailed", { error: errorMessage(e) }));
    return null;
  }
}

/** Share the brain through git, or keep it local again (asks first when sharing). */
export async function setBrainShared(dir: string, share: boolean): Promise<void> {
  if (share) {
    const ok = await confirmDialog({
      title: t("brain.share.confirmTitle"),
      message: t("brain.share.confirmMessage"),
      detail: t("brain.share.confirmDetail"),
      confirmLabel: t("brain.share.confirmLabel"),
    });
    if (!ok) return;
  }
  try {
    await ipc.brainShare(dir, share);
    notify("info", t(share ? "brain.share.shared" : "brain.share.local"));
  } catch (e) {
    notify("error", t("brain.share.failed", { error: errorMessage(e) }));
  }
  void reloadBrain(dir);
}

// ---- compose ("add memory…") --------------------------------------------------------------------------------

export function openCompose(p: Partial<ComposeRequest> & { dir?: string | null } = {}): void {
  const dir = p.dir ?? useBrain.getState().dir ?? activeProjectDir();
  if (!dir) {
    notify("warn", t("brain.toast.noProject"));
    return;
  }
  useBrain.setState({
    compose: {
      dir,
      title: p.title ?? "",
      kind: p.kind ?? "fact",
      tags: p.tags ?? [],
      body: p.body ?? "",
      source: p.source ?? "user",
      supersedes: p.supersedes ?? null,
      target: p.target ?? "notes",
    },
  });
}

export function closeCompose(): void {
  useBrain.setState({ compose: null });
}

/** Write a new memory from the compose dialog. Returns its slug, or null when it failed. */
export async function addMemory(req: ComposeRequest): Promise<string | null> {
  const inbox = req.target === "inbox";
  let idx = useBrain.getState().byDir[req.dir]?.index ?? null;
  if (!idx) idx = await ipc.brainList(req.dir).catch(() => null);
  const taken = [...(idx?.notes ?? []), ...(idx?.inbox ?? [])].map((n) => n.slug);
  const slug = slugForTitle(req.title || req.body, taken);
  // Agent-facing: stays English (typed into agents / written to files): the note file's text.
  const text = newNoteText({
    title: req.title || req.body.split(/\r?\n/)[0] || "Untitled",
    kind: req.kind,
    tags: req.tags,
    source: req.source,
    confidence: inbox ? "suggested" : "confirmed",
    supersedes: req.supersedes,
    body: req.body,
  });
  const r = await saveNote(req.dir, slug, inbox, text, null);
  if (!r.ok) return null;
  return slug;
}

/** Test hook. */
export function resetBrainForTests(): void {
  holds.clear();
  inflight.clear();
  again.clear();
  unlisten = null;
  searchSeq = 0;
  useBrain.setState({ open: false, dir: null, byDir: {}, query: "", hits: null, searching: false, kind: "all", tag: null, tab: "notes", selected: null, compose: null, prefsVersion: 0 });
}
