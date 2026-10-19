// Launch video: drives the REAL app in an isolated sandbox instance over CDP, records the shots of
// docs/launch/shot-list.md and assembles them with ffmpeg into
//   docs/assets/showcase/launch-45s.mp4      (16:9, 1920x1080, master cut, works muted)
//   docs/assets/showcase/launch-hero.gif     (15 s README loop without a visible seam, <= 6 MB)
//   docs/assets/showcase/launch-vertical.mp4 (9:16, 1080x1920, 30 s)
//
// Prereqs: Node >= 22, git and ffmpeg on PATH, a dev sandbox with e2e handles:
//   npm run sandbox -- -Name launch -Fresh        (CDP on 9333; keep its window visible, not minimized)
// Usage:
//   node scripts/showcase/launch.mjs                       all shots, then all cuts, then clean up
//   node scripts/showcase/launch.mjs --only shot3          re-record one shot (or: --only autopilot,drag)
//   node scripts/showcase/launch.mjs --assemble-only       re-cut from the recorded shots (no app needed)
//   node scripts/showcase/launch.mjs --cuts hero           assemble only some cuts (45s, hero, vertical)
//   node scripts/showcase/launch.mjs --keep                leave the demo workspace and repo for the next run
//   node scripts/showcase/launch.mjs --cleanup-only        remove the demo workspace, repo and worktrees
// Options: --port 9333 (or CDP_PORT) --out docs/assets/showcase --work <dir> --root C:\gk-demo --theme deep-space
//          --scale 1 (capture device scale; 1.5 gives crisper zooms) --fps 15 --capture screenshot|screencast
//          --font-size 14
//
// What is real: the app, Mission Control, the mission file watch, lead control (advisor/autopilot), the outbox
// delivery, sign-off evidence from git, the Changes drawer, lane drag and drop, the replay renderer. What is
// scripted: the terminal output. Each pane runs scripts/showcase/fake-agent.ps1, which prints a transcript at
// human pace and makes the local file edits and git commits the transcript asks for. No AI is contacted and no
// prompt is sent anywhere. The cuts carry an on-screen note saying so.
//
// Text cards are drawn on a <canvas> inside the app page (its own fonts and theme colours), exported as
// transparent PNGs and composited by ffmpeg, so the raw shots stay clean and each cut gets its own layout.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- options ------------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const [k, inline] = a.slice(2).split("=", 2);
    const flag = ["keep", "cleanup-only", "assemble-only", "no-assemble", "help"].includes(k);
    o[k] = flag ? true : (inline ?? argv[++i]);
  }
  return o;
}
const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.help) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 22).join("\n"));
  process.exit(0);
}
const OPT = {
  port: String(ARGS.port ?? process.env.CDP_PORT ?? "9333"),
  out: path.resolve(ARGS.out ?? path.join(REPO_ROOT, "docs", "assets", "showcase")),
  work: path.resolve(ARGS.work ?? path.join(os.tmpdir(), "gridkeeper-launch")),
  root: path.resolve(ARGS.root ?? (process.platform === "win32" ? "C:\\gk-demo" : path.join(os.tmpdir(), "gk-demo"))),
  theme: ARGS.theme ?? "deep-space",
  scale: Number(ARGS.scale ?? 1),
  fps: Number(ARGS.fps ?? 15),
  capture: ARGS.capture ?? "screenshot",
  fontSize: Number(ARGS["font-size"] ?? 14),
  only: ARGS.only ? String(ARGS.only).split(",").map((s) => s.trim()).filter(Boolean) : null,
  cuts: ARGS.cuts ? String(ARGS.cuts).split(",").map((s) => s.trim()) : ["45s", "hero", "vertical"],
  keep: !!ARGS.keep,
  cleanupOnly: !!ARGS["cleanup-only"],
  assembleOnly: !!ARGS["assemble-only"],
  noAssemble: !!ARGS["no-assemble"],
};
process.env.CDP_PORT = OPT.port;
for (const k of OPT.cuts) if (!["45s", "hero", "vertical"].includes(k)) throw new Error(`unknown cut "${k}" (45s, hero, vertical)`);
if (!["screenshot", "screencast"].includes(OPT.capture)) throw new Error("--capture must be screenshot or screencast");
if (!(OPT.scale >= 1 && OPT.scale <= 2)) throw new Error("--scale must be between 1 and 2");
const W = 1920;
const H = 1080;
const OUT_FPS = 30;
const WS_NAME = "OAuth demo";
const AGENTS = ["lead", "builder-1", "builder-2", "reviewer"];
const FAKE = path.join(HERE, "fake-agent.ps1");
const TRANSCRIPTS = path.join(HERE, "transcripts");
const MARK_SVG = path.join(REPO_ROOT, "docs", "assets", "logo", "gridkeeper-mark.svg");
const DEMO = {
  repo: path.join(OPT.root, "oauth-app"),
  wt1: path.join(OPT.root, "oauth-app-builder-1"),
  wt2: path.join(OPT.root, "oauth-app-builder-2"),
  marker: path.join(OPT.root, ".gk-launch-owned"),
};
const MISSION_FILE = path.join(DEMO.repo, ".gridkeeper", "mission.md");
const SIGNALS = path.join(OPT.work, "signals");
const SHOTS_DIR = path.join(OPT.work, "shots");
const STATE_FILE = path.join(OPT.work, "state.json");
const DISCLOSURE = "Recorded in the real app · demo panes print scripted output";

// ---- shots ---------------------------------------------------------------------------------------------------
const SHOT_IDS = { shot1: "grid", shot2: "board", shot3: "autopilot", shot4: "signoff", shot5: "drag", shot6: "replay" };
const SHOT_ORDER = Object.values(SHOT_IDS);
function resolveShot(s) {
  const n = SHOT_IDS[s] ?? s;
  if (!SHOT_ORDER.includes(n)) throw new Error(`unknown shot "${s}" (use ${Object.keys(SHOT_IDS).join(", ")} or ${SHOT_ORDER.join(", ")})`);
  return n;
}

// ---- mission file states -------------------------------------------------------------------------------------
const TASKS = [
  ["plan", "Plan the auth flow and split the work @lead"],
  ["callback", "Implement /auth/callback and token storage @builder-1"],
  ["button", "Wire the login button to /auth/start @builder-2"],
  ["ratelimit", "Add rate limiting to /auth/start @builder-2"],
  ["e2e", "Integration test for the full login flow @reviewer"],
  ["review", "Review both branches @reviewer"],
  ["readme", "Update the README auth section"],
  ["secret", "Get the GitHub client secret into .env @lead"],
  ["logout", "Add a logout route @builder-1"],
];
const START = { plan: "x", callback: "~", button: "~", ratelimit: " ", e2e: " ", review: " ", readme: " ", secret: "!" };
const AFTER_BOARD = { ...START, button: "x", e2e: "~", secret: "x", logout: " " };
const MISSION = {
  grid: START,
  board: START,
  autopilot: AFTER_BOARD,
  signoff: { ...AFTER_BOARD, ratelimit: "~" },
  drag: { ...AFTER_BOARD, ratelimit: "~", callback: "x" },
};
/** The replay shot first finishes the board step by step (so the recording holds a whole mission). */
const REPLAY_STEPS = [{ ratelimit: "x" }, { e2e: "x" }, { logout: "~" }, { review: "~" }, { readme: "x" }, { logout: "x" }, { review: "x" }];
MISSION.replay = REPLAY_STEPS.reduce((s, step) => ({ ...s, ...step }), { ...MISSION.drag });

function missionText(states) {
  const lines = [
    "# Mission: Add OAuth login with GitHub",
    "",
    "Use the existing session middleware. Done = login works end to end and tests pass.",
    "",
    "## Tasks",
  ];
  for (const [key, text] of TASKS) if (states[key] !== undefined) lines.push(`- [${states[key]}] ${text}`);
  return lines.join("\n") + "\n";
}
function writeMission(states) {
  fs.mkdirSync(path.dirname(MISSION_FILE), { recursive: true });
  for (let i = 0; i < 10; i++) {
    try {
      fs.writeFileSync(MISSION_FILE, missionText(states));
      return;
    } catch (e) {
      if (i === 9) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60); // the app may be reading it right now
    }
  }
}

// ---- small utils ---------------------------------------------------------------------------------------------
const log = (...a) => console.log(`[launch ${new Date().toISOString().slice(11, 19)}]`, ...a);
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
function git(args, cwd) {
  return execFileSync("git", ["-c", "user.name=Gridkeeper demo", "-c", "user.email=demo@example.invalid", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}
function writeState(s) {
  fs.mkdirSync(OPT.work, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
function signal(name) {
  fs.mkdirSync(SIGNALS, { recursive: true });
  fs.writeFileSync(path.join(SIGNALS, name), new Date().toISOString());
}
function clearSignals() {
  fs.rmSync(SIGNALS, { recursive: true, force: true });
  fs.mkdirSync(SIGNALS, { recursive: true });
}
async function until(pred, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return true;
    await sleep(150);
  }
  if (what) throw new Error(`timed out after ${Math.round(ms / 1000)} s: ${what}`);
  return false;
}

// ---- CDP client (with events, for screencast) ----------------------------------------------------------------
async function connect(port) {
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  } catch (e) {
    throw new Error(`no CDP endpoint on port ${port}: start a sandbox first (npm run sandbox -- -Name launch -Fresh). ${e?.message ?? e}`);
  }
  const pages = targets.filter((t) => t.type === "page" && !t.url.startsWith("devtools"));
  const page = pages.find((t) => /gridkeeper/i.test(t.title ?? "")) ?? pages[0];
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) rej(new Error(`${msg.error.message} (${msg.error.code})`));
      else res(msg.result);
    } else if (msg.method) for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const on = (method, fn) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(fn);
    return () => listeners.get(method).delete(fn);
  };
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 1500));
    return r.result?.value;
  };
  return { send, on, evaluate, close: () => ws.close() };
}

let C = null; // CDP connection
/** Run `fn` (self-contained) in the page with JSON arguments. */
const js = (fn, ...args) => C.evaluate(`(${fn})(${args.map((a) => JSON.stringify(a)).join(",")})`);
/** Call a page-library method (window.__gkLaunch). */
const L = (method, ...args) => C.evaluate(`window.__gkLaunch.${method}(${args.map((a) => JSON.stringify(a)).join(",")})`);

async function key(keyName) {
  const codes = { Escape: 27, Enter: 13 };
  const base = { key: keyName, code: keyName, windowsVirtualKeyCode: codes[keyName], nativeVirtualKeyCode: codes[keyName] };
  await C.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, ...(keyName === "Enter" ? { text: "\r" } : {}) });
  await C.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
async function typeText(text, perChar = 70) {
  for (const ch of text) {
    await C.send("Input.insertText", { text: ch });
    await sleep(perChar);
  }
}
async function mouseClick(x, y) {
  await C.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await C.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await C.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}
/** Find an element (page-library spec), scroll it into view, return its centre or throw. */
async function locate(spec, ms = 8000, smooth = false) {
  let p = null;
  await until(async () => (p = await L("locate", spec, smooth)), ms);
  if (!p) throw new Error(`element not found: ${JSON.stringify(spec)}`);
  return p;
}
/** Click without the visual cursor (setup / arrange, not on camera). */
async function quietClick(spec, ms) {
  const p = await locate(spec, ms);
  await mouseClick(p.x, p.y);
}
/** On-camera click: the drawn cursor glides to the element, then a real CDP mouse click and a ripple. */
async function cursorClick(spec, { move = 750, dwell = 260 } = {}) {
  const p = await locate(spec, 8000, true);
  await L("cursorTo", p.x, p.y, move);
  await sleep(dwell);
  await mouseClick(p.x, p.y);
  await L("ripple", p.x, p.y);
  return p;
}

// ---- page library (installed into the app page) --------------------------------------------------------------
function installPageLib() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shown = (el) => !!el && el.getClientRects().length > 0;
  const lower = (s) => String(s ?? "").toLowerCase();
  const textHits = (root, text) =>
    [...(root ?? document).querySelectorAll("*")].filter((e) => {
      if (!shown(e) || !lower(e.textContent).includes(lower(text))) return false;
      return ![...e.children].some((c) => lower(c.textContent).includes(lower(text)));
    });
  const L = {
    sleep,
    app: () => window.__gridkeeper.store.useApp.getState(),
    /** spec: { sel?, text?, within?, last? } -> element */
    find(spec) {
      const root = spec.within ? document.querySelector(spec.within) : document;
      if (!root) return null;
      let c;
      if (spec.sel) {
        c = [...root.querySelectorAll(spec.sel)].filter(shown);
        if (spec.text) c = c.filter((e) => lower(e.textContent).includes(lower(spec.text)) || lower(e.getAttribute("aria-label")).includes(lower(spec.text)));
      } else c = textHits(root, spec.text);
      if (!c.length) return null;
      return spec.last ? c[c.length - 1] : c[0];
    },
    async locate(spec, smooth) {
      const el = L.find(spec);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.top < 40 || r.bottom > innerHeight - 40 || r.left < 0 || r.right > innerWidth) {
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: smooth ? "smooth" : "auto" });
        await sleep(smooth ? 700 : 120);
      }
      const q = el.getBoundingClientRect();
      return { x: Math.round(q.left + q.width / 2), y: Math.round(q.top + Math.min(q.height / 2, 40)) };
    },
    rect(el) {
      if (typeof el === "string") el = document.querySelector(el);
      if (!el || !shown(el)) return null;
      const r = el.getBoundingClientRect();
      const x = Math.max(0, r.left), y = Math.max(0, r.top);
      const w = Math.min(innerWidth, r.right) - x, h = Math.min(innerHeight, r.bottom) - y;
      return w > 4 && h > 4 ? { x, y, w, h } : null;
    },
    union(rects) {
      const rs = rects.filter(Boolean);
      if (!rs.length) return null;
      const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
      return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
    },
    /** Rects for the cut framing (CSS px). */
    rects(names) {
      const out = {};
      const textBlock = (label, minW, minH) => {
        let el = textHits(document, label).find((e) => lower(e.textContent).trim() === lower(label)) ?? null;
        while (el && !(el.getBoundingClientRect().width >= minW && el.getBoundingClientRect().height >= minH)) el = el.parentElement;
        return el;
      };
      for (const n of names) {
        if (n === "board") out[n] = L.rect('[data-node="mission"]');
        else if (n === "lead") out[n] = L.rect('[data-node="lead"]');
        else if (n === "signoff") out[n] = L.rect('[data-node="signoff"]');
        else if (n === "lanes") out[n] = L.union([...document.querySelectorAll('[data-node^="lane:"], .mc-newlane')].map((e) => L.rect(e)));
        else if (n === "log") out[n] = L.rect(textBlock("session log", 900, 120));
        else if (n === "drawer") out[n] = L.rect(".changes-drawer");
        else if (n === "replay") out[n] = L.rect(".rp-modal");
      }
      return out;
    },
    expandDone() {
      const b = document.querySelector('[data-node="mission"] .mb-done-toggle[aria-expanded="false"]');
      if (b) b.click();
      return !!b;
    },
    text: (sel) => [...document.querySelectorAll(sel)].filter(shown).map((e) => e.textContent ?? "").join(" "),
    // ---- drawn cursor ------------------------------------------------------------------------------------
    cursorEl() {
      let el = document.getElementById("gk-launch-cursor");
      if (!el) {
        el = document.createElement("div");
        el.id = "gk-launch-cursor";
        el.innerHTML =
          '<svg width="30" height="30" viewBox="0 0 30 30"><path d="M3 2 L3 23 L8.6 17.6 L12.4 26.4 L16.2 24.8 L12.5 16.2 L20.4 16.2 Z" fill="#fff" stroke="#0b1220" stroke-width="1.6" stroke-linejoin="round"/></svg>';
        Object.assign(el.style, {
          position: "fixed", left: "0px", top: "0px", width: "30px", height: "30px", zIndex: "2147483647",
          pointerEvents: "none", opacity: "0", transform: `translate(${innerWidth * 0.72}px, ${innerHeight * 0.8}px)`,
          filter: "drop-shadow(0 3px 6px rgba(0,0,0,.5))", willChange: "transform",
        });
        document.body.appendChild(el);
        el.dataset.x = String(innerWidth * 0.72);
        el.dataset.y = String(innerHeight * 0.8);
      }
      return el;
    },
    placeCursor(x, y) {
      const el = L.cursorEl();
      el.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
      el.dataset.x = String(x);
      el.dataset.y = String(y);
    },
    async cursorTo(x, y, ms) {
      const el = L.cursorEl();
      el.style.transition = `transform ${ms}ms cubic-bezier(.45,0,.2,1), opacity 220ms ease`;
      el.style.opacity = "1";
      L.placeCursor(x, y);
      await sleep(ms);
    },
    hideCursor() {
      const el = document.getElementById("gk-launch-cursor");
      if (el) el.style.opacity = "0";
    },
    ripple(x, y) {
      const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim() || "#4cc2ff";
      const d = document.createElement("div");
      Object.assign(d.style, {
        position: "fixed", left: `${x - 22}px`, top: `${y - 22}px`, width: "44px", height: "44px", borderRadius: "50%",
        border: `2px solid ${accent}`, pointerEvents: "none", zIndex: "2147483646",
      });
      document.body.appendChild(d);
      d.animate([{ transform: "scale(.25)", opacity: 0.9 }, { transform: "scale(1.5)", opacity: 0 }], { duration: 480, easing: "ease-out" }).finished.then(() => d.remove());
    },
    removeOverlays() {
      for (const id of ["gk-launch-cursor", "gk-launch-ghost"]) document.getElementById(id)?.remove();
    },
    /** HTML5 drag of `srcSel` onto `dstSel` with the same DragEvents a mouse drag produces (Chromium only fires
     *  real drag events for OS-level drags, which a recording cannot show), a ghost card and the drawn cursor. */
    async fakeDrag(srcSel, dstSel, ms) {
      const src = document.querySelector(srcSel);
      const dst = document.querySelector(dstSel);
      if (!src || !dst) return { ok: false, why: `missing ${src ? dstSel : srcSel}` };
      src.scrollIntoView({ block: "nearest" });
      const r0 = src.getBoundingClientRect();
      const r1 = dst.getBoundingClientRect();
      const p0 = { x: r0.left + r0.width / 2, y: r0.top + Math.min(r0.height / 2, 26) };
      const p1 = { x: r1.left + r1.width / 2, y: r1.top + Math.min(r1.height / 2, 70) };
      await L.cursorTo(p0.x, p0.y, 650);
      await sleep(160);
      L.ripple(p0.x, p0.y);
      const dt = new DataTransfer();
      const fire = (type, x, y, target) =>
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: x, clientY: y }));
      fire("dragstart", p0.x, p0.y, src);
      const ghost = src.cloneNode(true);
      ghost.id = "gk-launch-ghost";
      ghost.removeAttribute("data-card");
      Object.assign(ghost.style, {
        position: "fixed", left: `${r0.left}px`, top: `${r0.top}px`, width: `${r0.width}px`, height: `${r0.height}px`, margin: "0",
        pointerEvents: "none", zIndex: "2147483645", opacity: "0.94", transform: "rotate(-1.2deg) scale(1.03)",
        boxShadow: "0 20px 44px rgba(0,0,0,.5)", transition: "none",
      });
      document.body.appendChild(ghost);
      await new Promise((r) => requestAnimationFrame(r));
      const cur = L.cursorEl();
      cur.style.transition = "opacity 200ms ease";
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      let last = null;
      const t0 = performance.now();
      for (;;) {
        const k = Math.min(1, (performance.now() - t0) / ms);
        const e = ease(k);
        const x = p0.x + (p1.x - p0.x) * e;
        const y = p0.y + (p1.y - p0.y) * e - Math.sin(Math.PI * e) * 36;
        ghost.style.left = `${r0.left + x - p0.x}px`;
        ghost.style.top = `${r0.top + y - p0.y}px`;
        L.placeCursor(x, y);
        const under = document.elementFromPoint(x, y);
        if (under) {
          if (under !== last) {
            if (last) fire("dragleave", x, y, last);
            fire("dragenter", x, y, under);
            last = under;
          }
          fire("dragover", x, y, under);
        }
        if (k >= 1) break;
        await new Promise((r) => requestAnimationFrame(r));
      }
      await sleep(180);
      const target = document.elementFromPoint(p1.x, p1.y) ?? dst;
      fire("dragover", p1.x, p1.y, target);
      fire("drop", p1.x, p1.y, target);
      fire("dragend", p1.x, p1.y, src);
      L.ripple(p1.x, p1.y);
      ghost.animate([{ opacity: 0.94 }, { opacity: 0 }], { duration: 200 }).finished.then(() => ghost.remove());
      return { ok: true };
    },
    // ---- text cards (canvas, app fonts and theme colours) -------------------------------------------------
    palette() {
      const cs = getComputedStyle(document.body);
      const v = (n, d) => cs.getPropertyValue(n).trim() || d;
      return {
        bg0: v("--bg-0", "#07090d"), bg2: v("--bg-2", "#12161e"), text0: v("--text-0", "#e7ecf4"), text1: v("--text-1", "#a2acbd"),
        text2: v("--text-2", "#6c7689"), accent: v("--accent", "#4cc2ff"), border: v("--border-strong", "#29323f"), ok: v("--ok", "#3ddc97"),
      };
    },
    async renderCard(spec, w, h, markSvg) {
      const DISPLAY = '"Space Grotesk Variable", "Space Grotesk", "Geist Variable", "Segoe UI", sans-serif';
      const UI = '"Geist Variable", "Geist", "Segoe UI", sans-serif';
      const MONO = '"Geist Mono Variable", "Geist Mono", "Cascadia Mono", Consolas, monospace';
      for (const f of [`600 64px ${DISPLAY}`, `500 28px ${MONO}`, `400 30px ${UI}`]) {
        try {
          await document.fonts.load(f);
        } catch {}
      }
      const p = L.palette();
      const cv = document.createElement("canvas");
      cv.width = w;
      cv.height = h;
      const ctx = cv.getContext("2d");
      ctx.textBaseline = "alphabetic";
      const wrap = (text, maxW) => {
        const words = String(text).split(/\s+/);
        const lines = [];
        let cur = "";
        for (const wd of words) {
          const t = cur ? `${cur} ${wd}` : wd;
          if (ctx.measureText(t).width > maxW && cur) {
            lines.push(cur);
            cur = wd;
          } else cur = t;
        }
        if (cur) lines.push(cur);
        return lines;
      };
      const rr = (x, y, ww, hh, r) => {
        ctx.beginPath();
        ctx.roundRect(x, y, ww, hh, r);
      };
      let mark = null;
      if (markSvg && (spec.style === "end" || spec.style === "vend")) {
        mark = new Image();
        mark.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markSvg);
        try {
          await mark.decode();
        } catch {
          mark = null;
        }
      }
      const vertical = h > w;
      const u = vertical ? w / 1080 : h / 1080; // 1 unit = 1 px at 1080 short side

      if (spec.style === "lower") {
        const padX = 40 * u, padY = 30 * u, maxW = 1080 * u;
        ctx.font = `600 ${58 * u}px ${DISPLAY}`;
        const tl = wrap(spec.title, maxW - 2 * padX);
        const tw = Math.max(...tl.map((l) => ctx.measureText(l).width));
        ctx.font = `500 ${25 * u}px ${MONO}`;
        const sl = spec.sub ? wrap(spec.sub, maxW - 2 * padX) : [];
        const sw = sl.length ? Math.max(...sl.map((l) => ctx.measureText(l).width)) : 0;
        const bw = Math.max(tw, sw) + 2 * padX + 6 * u;
        const bh = 2 * padY + tl.length * 68 * u + (sl.length ? 14 * u + sl.length * 34 * u : 0);
        const x = 96 * u, y = h - 104 * u - bh;
        ctx.globalAlpha = 0.86;
        ctx.fillStyle = p.bg0;
        rr(x, y, bw, bh, 18 * u);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = p.border;
        ctx.lineWidth = 1.5 * u;
        ctx.stroke();
        ctx.fillStyle = p.accent;
        rr(x, y + 18 * u, 6 * u, bh - 36 * u, 3 * u);
        ctx.fill();
        ctx.fillStyle = p.text0;
        ctx.font = `600 ${58 * u}px ${DISPLAY}`;
        tl.forEach((l, i) => ctx.fillText(l, x + padX + 6 * u, y + padY + 52 * u + i * 68 * u));
        ctx.fillStyle = p.accent;
        ctx.font = `500 ${25 * u}px ${MONO}`;
        sl.forEach((l, i) => ctx.fillText(l, x + padX + 6 * u, y + padY + tl.length * 68 * u + 14 * u + 26 * u + i * 34 * u));
      } else if (spec.style === "center") {
        ctx.textAlign = "center";
        ctx.fillStyle = p.text0;
        ctx.font = `600 ${84 * u}px ${DISPLAY}`;
        const tl = wrap(spec.title, w * 0.8);
        const y0 = h / 2 - ((tl.length - 1) * 96 * u) / 2 + 26 * u;
        tl.forEach((l, i) => ctx.fillText(l, w / 2, y0 + i * 96 * u));
        if (spec.sub) {
          ctx.fillStyle = p.text1;
          ctx.font = `500 ${28 * u}px ${MONO}`;
          ctx.fillText(spec.sub, w / 2, y0 + tl.length * 96 * u + 10 * u);
        }
      } else if (spec.style === "label") {
        ctx.font = `600 ${34 * u}px ${DISPLAY}`;
        const tw = ctx.measureText(spec.title).width;
        const bh = 64 * u, bw = tw + 76 * u, x = 44 * u, y = h - 44 * u - bh;
        ctx.globalAlpha = 0.88;
        ctx.fillStyle = p.bg0;
        rr(x, y, bw, bh, bh / 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = p.border;
        ctx.lineWidth = 1.5 * u;
        ctx.stroke();
        ctx.fillStyle = p.accent;
        ctx.beginPath();
        ctx.arc(x + 30 * u, y + bh / 2, 7 * u, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = p.text0;
        ctx.fillText(spec.title, x + 50 * u, y + bh / 2 + 12 * u);
      } else if (spec.style === "tag") {
        ctx.font = `500 ${17 * u}px ${MONO}`;
        const tw = ctx.measureText(spec.title).width;
        const bh = 34 * u, bw = tw + 28 * u;
        const x = vertical ? (w - bw) / 2 : w - 24 * u - bw;
        const y = h - (vertical ? 36 : 22) * u - bh;
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = p.bg0;
        rr(x, y, bw, bh, bh / 2);
        ctx.fill();
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = p.text1;
        ctx.fillText(spec.title, x + 14 * u, y + bh / 2 + 6 * u);
        ctx.globalAlpha = 1;
      } else if (spec.style === "vtop") {
        ctx.textAlign = "center";
        ctx.fillStyle = p.text0;
        ctx.font = `600 ${78 * u}px ${DISPLAY}`;
        const tl = wrap(spec.title, w - 140 * u);
        const bandTop = 120 * u, bandBottom = 500 * u, lh = 90 * u;
        const y0 = (bandTop + bandBottom) / 2 - ((tl.length - 1) * lh) / 2 + 28 * u;
        tl.forEach((l, i) => ctx.fillText(l, w / 2, y0 + i * lh));
        if (spec.sub) {
          ctx.fillStyle = p.accent;
          ctx.font = `500 ${32 * u}px ${MONO}`;
          const sl = wrap(spec.sub, w - 140 * u);
          const sy = 1590 * u - ((sl.length - 1) * 44 * u) / 2;
          sl.forEach((l, i) => ctx.fillText(l, w / 2, sy + i * 44 * u));
        }
      } else if (spec.style === "end" || spec.style === "vend") {
        ctx.fillStyle = p.bg0;
        ctx.fillRect(0, 0, w, h);
        const g = ctx.createRadialGradient(w / 2, h * 0.38, 10, w / 2, h * 0.38, Math.max(w, h) * 0.6);
        g.addColorStop(0, p.bg2);
        g.addColorStop(1, p.bg0);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.textAlign = "center";
        const cx = w / 2;
        let y = vertical ? 560 * u : 250 * u;
        const ms = (vertical ? 170 : 116) * u;
        if (mark) ctx.drawImage(mark, cx - ms / 2, y - ms / 2, ms, ms);
        y += ms / 2 + (vertical ? 150 : 112) * u;
        ctx.fillStyle = p.text0;
        ctx.font = `600 ${(vertical ? 112 : 100) * u}px ${DISPLAY}`;
        ctx.fillText("Gridkeeper", cx, y);
        y += (vertical ? 86 : 66) * u;
        ctx.fillStyle = p.text1;
        ctx.font = `400 ${(vertical ? 44 : 38) * u}px ${UI}`;
        ctx.fillText(spec.tagline ?? "Every agent in one grid.", cx, y);
        y += (vertical ? 130 : 96) * u;
        ctx.fillStyle = p.accent;
        ctx.font = `500 ${(vertical ? 40 : 38) * u}px ${MONO}`;
        ctx.fillText(spec.url ?? "github.com/raazi29/gridkeeper", cx, y);
        y += (vertical ? 70 : 56) * u;
        ctx.fillStyle = p.text2;
        ctx.font = `400 ${(vertical ? 30 : 27) * u}px ${UI}`;
        for (const l of vertical ? (spec.platformsV ?? []) : [spec.platforms ?? ""]) {
          ctx.fillText(l, cx, y);
          y += 44 * u;
        }
        y += (vertical ? 50 : 30) * u;
        ctx.fillStyle = p.text1;
        ctx.font = `500 ${(vertical ? 28 : 25) * u}px ${MONO}`;
        for (const l of (vertical ? spec.installV : null) ?? spec.install ?? []) {
          ctx.fillText(l, cx, y);
          y += (vertical ? 46 : 40) * u;
        }
        ctx.fillStyle = p.text2;
        ctx.font = `400 ${(vertical ? 24 : 20) * u}px ${UI}`;
        const fl = wrap(spec.footnote ?? "", w - 120 * u);
        fl.forEach((l, i) => ctx.fillText(l, cx, h - (vertical ? 90 : 46) * u - (fl.length - 1 - i) * 32 * u));
      }
      try {
        return cv.toDataURL("image/png");
      } catch {
        return null;
      }
    },
  };
  window.__gkLaunch = L;
  return true;
}

// ---- recorder -----------------------------------------------------------------------------------------------
class Recorder {
  constructor(name) {
    this.name = name;
    this.dir = path.join(SHOTS_DIR, name);
    this.framesDir = path.join(this.dir, "frames");
  }
  async start() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.framesDir, { recursive: true });
    this.frames = [];
    this.writes = [];
    this.marks = {};
    this.rectsAt = {};
    this.on = true;
    this.n = 0;
    if (OPT.capture === "screencast") {
      this.off = C.on("Page.screencastFrame", (p) => {
        if (!this.on) return;
        const file = `f${String(this.n++).padStart(5, "0")}.jpg`;
        this.writes.push(fs.promises.writeFile(path.join(this.framesDir, file), Buffer.from(p.data, "base64")));
        this.frames.push({ file, t: (p.metadata?.timestamp ? p.metadata.timestamp * 1000 : Date.now()) });
        C.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
      });
      await C.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: Math.round(W * OPT.scale), maxHeight: Math.round(H * OPT.scale), everyNthFrame: 1 });
    } else {
      this.loop = (async () => {
        const period = 1000 / OPT.fps;
        while (this.on) {
          const t0 = Date.now();
          try {
            const r = await C.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
            const t1 = Date.now();
            const file = `f${String(this.n++).padStart(5, "0")}.jpg`;
            this.writes.push(fs.promises.writeFile(path.join(this.framesDir, file), Buffer.from(r.data, "base64")));
            this.frames.push({ file, t: (t0 + t1) / 2 });
          } catch {
            /* a frame lost while the page was busy; the next one covers it */
          }
          const dt = Date.now() - t0;
          if (dt < period) await sleep(period - dt);
        }
      })();
    }
    await until(() => this.frames.length > 0, 5000, `${this.name}: no frames (is the sandbox window visible and not minimized?)`);
    this.t0 = this.frames[0].t;
  }
  mark(name) {
    this.marks[name] = Date.now();
    log(`  mark ${name} @ ${((Date.now() - this.t0) / 1000).toFixed(2)} s`);
  }
  async rects(names) {
    const r = await L("rects", names);
    for (const [k, v] of Object.entries(r ?? {})) if (v && !this.rectsAt[k]) this.rectsAt[k] = v;
  }
  async stop() {
    this.on = false;
    const tEnd = Date.now();
    if (this.off) {
      this.off();
      await C.send("Page.stopScreencast").catch(() => {});
    }
    if (this.loop) await this.loop;
    await Promise.all(this.writes);
    const s = OPT.scale;
    const meta = {
      name: this.name,
      width: Math.round(W * s),
      height: Math.round(H * s),
      scale: s,
      end: (tEnd - this.t0) / 1000,
      frames: this.frames.map((f) => ({ file: f.file, t: Math.max(0, (f.t - this.t0) / 1000) })),
      marks: Object.fromEntries(Object.entries(this.marks).map(([k, v]) => [k, (v - this.t0) / 1000])),
      rects: Object.fromEntries(Object.entries(this.rectsAt).map(([k, r]) => [k, { x: r.x * s, y: r.y * s, w: r.w * s, h: r.h * s }])),
      capture: OPT.capture,
      recordedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(this.dir, "meta.json"), JSON.stringify(meta, null, 2));
    fs.rmSync(path.join(this.dir, "shot.mp4"), { force: true });
    return meta;
  }
}

// ---- demo repository (plain git, run from Node) -------------------------------------------------------------
function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
}
function setupRepo() {
  if (fs.existsSync(OPT.root) && fs.readdirSync(OPT.root).length && !fs.existsSync(DEMO.marker)) {
    throw new Error(`${OPT.root} exists and was not created by launch.mjs; pass --root <empty or new folder>`);
  }
  removeRepo();
  fs.mkdirSync(DEMO.repo, { recursive: true });
  fs.writeFileSync(DEMO.marker, "created by scripts/showcase/launch.mjs; safe to delete\n");
  git(["init", "-q", "-b", "main"], DEMO.repo);
  writeFiles(DEMO.repo, {
    ".gitignore": ".gridkeeper/\nnode_modules/\n.env\n",
    "README.md": "# oauth-app\n\nA small web app used as the demo project in the Gridkeeper launch video.\n",
    "package.json": JSON.stringify({ name: "oauth-app", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
    "src/server.ts": 'import { createServer } from "./http";\nimport { sessions } from "./session";\nimport { authRoutes } from "./auth/routes";\n\nconst app = createServer();\napp.use(sessions());\napp.use(authRoutes);\napp.listen(3000);\n',
    "src/session.ts": "// Server-side sessions (cookie holds only the id).\nexport function sessions() {\n  return (req, res, next) => next();\n}\n\nexport function createStore(name) {\n  const map = new Map();\n  return { name, get: (k) => map.get(k), set: (k, v) => map.set(k, v) };\n}\n",
    "src/auth/routes.ts": 'import { router } from "../http";\nimport { start } from "./start";\n\nexport const authRoutes = router();\nauthRoutes.get("/auth/start", start);\n',
    "src/auth/start.ts": "// Redirects to GitHub's authorize URL with a fresh state value.\nexport function start(req, res) {\n  req.session.oauthState = crypto.randomUUID();\n  res.redirect(`https://github.com/login/oauth/authorize?state=${req.session.oauthState}`);\n}\n",
    "src/auth/github.ts": "// Swaps an authorization code for an access token.\nexport async function exchangeCode(code) {\n  return { access_token: `token-for-${code}` };\n}\n",
    "src/ui/header.tsx": 'export function Header() {\n  return <header className="top">oauth-app</header>;\n}\n',
  });
  git(["add", "-A"], DEMO.repo);
  git(["commit", "-q", "-m", "App skeleton with session middleware"], DEMO.repo);
  git(["worktree", "add", "-q", "-b", "gk/builder-1", DEMO.wt1, "main"], DEMO.repo);
  git(["worktree", "add", "-q", "-b", "gk/builder-2", DEMO.wt2, "main"], DEMO.repo);
  writeFiles(DEMO.wt2, {
    "src/ui/LoginButton.tsx": 'export function LoginButton() {\n  return <a className="btn" href="/auth/start">Sign in with GitHub</a>;\n}\n',
    "src/ui/header.tsx": 'import { LoginButton } from "./LoginButton";\n\nexport function Header() {\n  return (\n    <header className="top">\n      oauth-app\n      <LoginButton />\n    </header>\n  );\n}\n',
  });
  git(["add", "-A"], DEMO.wt2);
  git(["commit", "-q", "-m", "Add the GitHub login button"], DEMO.wt2);
  writeMission(MISSION.grid);
}
function removeRepo() {
  if (!fs.existsSync(OPT.root)) return;
  if (!fs.existsSync(DEMO.marker)) {
    if (fs.readdirSync(OPT.root).length) log(`not removing ${OPT.root}: it has no launch.mjs marker`);
    return;
  }
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(OPT.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      return;
    } catch (e) {
      if (i === 4) log(`could not remove ${OPT.root}: ${e.message}`);
    }
  }
}

// ---- app setup (in the page) --------------------------------------------------------------------------------
async function pgSetup(o) {
  const G = window.__gridkeeper;
  const { useApp } = G.store;
  const S = G.sessions;
  try {
    localStorage.setItem("gridkeeper.welcomed", "1");
  } catch {}
  const s0 = useApp.getState().persisted;
  const prev = { theme: s0.settings.theme, fontSize: s0.settings.fontSize, notifications: s0.settings.notifications, activeWorkspaceId: s0.activeWorkspaceId };
  for (const w of useApp.getState().persisted.workspaces.filter((w) => w.name === o.wsName && String(w.projectDir ?? "").toLowerCase().startsWith(o.root.toLowerCase()))) {
    for (const id of w.groups.flatMap((g) => g.sessionIds)) await S.closeSession(id);
    useApp.getState().deleteWorkspace(w.id);
  }
  // Comms feed only while recording: no OS notifications, no toasts over the shots.
  useApp.getState().updateSettings({ theme: o.theme, fontSize: o.fontSize, notifications: { ...prev.notifications, delivery: "off" } });
  const wsId = useApp.getState().createWorkspace(o.wsName, o.repo);
  const ws = () => useApp.getState().persisted.workspaces.find((w) => w.id === wsId);
  const buildId = ws().groups[0].id;
  useApp.getState().renameGroup(buildId, "Build");
  const verifyId = useApp.getState().createGroup(wsId, "Verify");
  useApp.getState().setActiveGroup(wsId, buildId);
  useApp.getState().setActiveWorkspace(wsId);
  const base = { groupId: buildId, agent: "powershell", args: o.args };
  const ids = {};
  ids.lead = S.newSession({ ...base, cwd: o.repo, name: "lead", role: "lead" });
  ids["builder-1"] = S.newSession({ ...base, cwd: o.repo, name: "builder-1", role: "builder", worktree: { path: o.wt1, branch: "gk/builder-1" } });
  ids["builder-2"] = S.newSession({ ...base, cwd: o.repo, name: "builder-2", role: "builder", worktree: { path: o.wt2, branch: "gk/builder-2" } });
  ids.reviewer = S.newSession({ ...base, cwd: o.repo, name: "reviewer", role: "reviewer" });
  G.commands.runCommand("layout.grid");
  return { wsId, buildId, verifyId, ids, prev };
}

/** Earlier runs' demo workspaces (same name, folder under --root): close their panes before the folder goes. */
async function pgRemoveLeftovers(o) {
  const G = window.__gridkeeper;
  const { useApp } = G.store;
  let n = 0;
  for (const w of useApp.getState().persisted.workspaces.filter((w) => w.name === o.wsName && String(w.projectDir ?? "").toLowerCase().startsWith(o.root.toLowerCase()))) {
    for (const id of w.groups.flatMap((g) => g.sessionIds)) await G.sessions.closeSession(id);
    useApp.getState().deleteWorkspace(w.id);
    n++;
  }
  return n;
}

async function pgSessionsReady(ids) {
  const G = window.__gridkeeper;
  const rt = G.store.useApp.getState().runtime;
  for (const id of ids) {
    if (rt[id]?.state?.state !== "running") return false;
    const t = await G.ipc.sessionOutputText(id).catch(() => "");
    if (!t.includes("PS> ")) return false;
  }
  return true;
}

async function setupApp() {
  if (await js(pgRemoveLeftovers, { wsName: WS_NAME, root: OPT.root })) await sleep(1000);
  log("setting up the demo repository in", OPT.root);
  setupRepo();
  await key("Escape");
  await key("Escape");
  const args = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-NoExit", "-Command", "function global:prompt { 'PS> ' }"];
  const r = await js(pgSetup, { wsName: WS_NAME, root: OPT.root, repo: DEMO.repo, wt1: DEMO.wt1, wt2: DEMO.wt2, theme: OPT.theme, fontSize: OPT.fontSize, args });
  const state = { ...r, launchedAt: Date.now(), root: OPT.root, port: OPT.port };
  writeState(state);
  log("waiting for the four PowerShell panes");
  await until(() => js(pgSessionsReady, Object.values(r.ids)), 45000, "panes did not reach a prompt");
  return state;
}

async function stateUsable(st) {
  if (!st || st.root !== OPT.root || !fs.existsSync(DEMO.repo)) return false;
  return js(
    (st) => {
      const a = window.__gridkeeper?.store.useApp.getState();
      if (!a) return false;
      const ws = a.persisted.workspaces.find((w) => w.id === st.wsId);
      return !!ws && Object.values(st.ids).every((id) => a.runtime[id]?.state?.state === "running");
    },
    st,
  );
}

async function teardownApp(st) {
  if (st && C) {
    try {
      await js(
        async (st) => {
          const G = window.__gridkeeper;
          const { useApp } = G.store;
          G.mission.useMission.getState().toggle(false);
          for (const id of Object.values(st.ids)) await G.sessions.closeSession(id).catch(() => {});
          for (const w of useApp.getState().persisted.workspaces.filter((w) => w.id === st.wsId)) {
            for (const id of w.groups.flatMap((g) => g.sessionIds)) await G.sessions.closeSession(id).catch(() => {});
            useApp.getState().deleteWorkspace(w.id);
          }
          if (st.prev) {
            useApp.getState().updateSettings({ theme: st.prev.theme, fontSize: st.prev.fontSize, notifications: st.prev.notifications });
            if (st.prev.activeWorkspaceId && useApp.getState().persisted.workspaces.some((w) => w.id === st.prev.activeWorkspaceId))
              useApp.getState().setActiveWorkspace(st.prev.activeWorkspaceId);
          }
          window.__gkLaunch?.removeOverlays();
        },
        st,
      );
    } catch (e) {
      log("app cleanup failed:", e.message);
    }
  }
  await sleep(800); // let the panes' processes exit before their folders go
  removeRepo();
  fs.rmSync(STATE_FILE, { force: true });
  fs.rmSync(SIGNALS, { recursive: true, force: true });
}

// ---- per-shot arrangement -----------------------------------------------------------------------------------
let ST = null; // setup state
let maximized = false;
const sid = (name) => ST.ids[name];
const write = (name, text) => js((id, t) => window.__gridkeeper.ipc.sessionWrite(id, t), sid(name), text);
const missionOpen = (open) => js((o) => window.__gridkeeper.mission.useMission.getState().toggle(o), open);

async function resetView() {
  await L("removeOverlays");
  await js(() => document.activeElement?.blur?.());
  if (await js(() => !!document.querySelector(".rp-modal"))) {
    await key("Escape");
    await sleep(300);
    if (await js(() => !!document.querySelector(".rp-modal"))) await quietClick({ within: ".rp-modal", sel: "button", text: "close" }, 2000).catch(() => {});
  }
  await missionOpen(false);
  if (await js(() => !!document.querySelector(".changes-drawer"))) await js(() => window.__gridkeeper.commands.runCommand("view.changes"));
  if (await js(() => !!document.querySelector(".palette, [role='dialog']"))) await key("Escape");
  if (maximized) {
    await js((id) => window.__gridkeeper.store.useApp.getState().setFocused(id), sid("builder-2"));
    await js(() => window.__gridkeeper.commands.runCommand("session.maximize"));
    maximized = false;
  }
  await js(
    (st) => {
      const a = window.__gridkeeper.store.useApp.getState();
      a.setActiveWorkspace(st.wsId);
      a.setActiveGroup(st.wsId, st.buildId);
      a.setFocused(st.ids.lead);
    },
    ST,
  );
  await sleep(300);
}

async function startAgents(section) {
  clearSignals();
  for (const n of AGENTS) await write(n, "\x03");
  await sleep(600);
  for (const n of AGENTS) {
    await write(n, "\x1b"); // PSReadLine: Escape clears anything left on the prompt line
    await sleep(60);
    const cmd = `& ${psq(FAKE)} -Transcript ${psq(path.join(TRANSCRIPTS, `${n}.txt`))} -Section ${section} -Name ${n} -MissionFile ${psq(MISSION_FILE)} -SignalDir ${psq(SIGNALS)}`;
    await write(n, cmd + "\r");
  }
  await until(() => AGENTS.every((n) => fs.existsSync(path.join(SIGNALS, `started-${n}`))), 20000, "fake agents did not start (see the panes)");
}

async function showMission() {
  await missionOpen(true);
  await until(() => js(() => (document.querySelector('[data-node="mission"]')?.textContent ?? "").includes("Add OAuth login")), 8000, "mission board did not render");
  await L("expandDone");
  await js(() => {
    const s = document.querySelector(".mc-scroll");
    if (s) s.scrollTop = 0;
  });
  await sleep(400);
}

async function setLeadMode(mode, { autoReview } = {}) {
  await showMission();
  await L("locate", { sel: '[data-node="lead"]' }, false);
  if (!(await js((m) => !!document.querySelector(`.lc-seg-btn.is-${m}.is-on`), mode))) {
    await quietClick({ sel: `.lc-seg-btn.is-${mode}` });
    if (mode === "autopilot") await quietClick({ sel: "button", text: "Turn on autopilot" });
    await sleep(300);
  }
  if (autoReview !== undefined && mode !== "off") {
    const cur = await js(() => {
      const lab = [...document.querySelectorAll(".lc-check")].find((l) => /review/i.test(l.textContent ?? ""));
      return lab ? !!lab.querySelector("input")?.checked : null;
    });
    if (cur !== null && cur !== autoReview) await quietClick({ sel: ".lc-check", text: "review" });
  }
}

/** Rewinds builder-1's branch so its commit happens on camera again (re-runs of the sign-off shot). */
function resetBuilder1() {
  git(["reset", "-q", "--hard", "main"], DEMO.wt1);
  git(["clean", "-fdq"], DEMO.wt1);
}

const SHOTS = {
  grid: {
    async arrange() {},
    async act(rec) {
      await sleep(11000);
      rec.mark("end");
    },
  },
  board: {
    async arrange() {
      await showMission();
    },
    async act(rec) {
      await rec.rects(["board", "lead", "signoff"]);
      await sleep(12500);
      await rec.rects(["board"]);
      rec.mark("end");
    },
  },
  autopilot: {
    async prepare() {
      await setLeadMode("advisor", { autoReview: false }); // no review requests typed into the lead's script
      // Nothing may be waiting when autopilot goes on (it would be delivered too): dismiss leftovers.
      for (let i = 0; i < 10; i++) {
        const p = await L("locate", { within: ".lc-props", sel: "button", text: "dismiss" }, false);
        if (!p) break;
        await mouseClick(p.x, p.y);
        await sleep(400);
      }
      await missionOpen(false);
    },
    async arrange() {
      await showMission();
      await L("locate", { sel: '[data-node="lead"]' }, false);
      await sleep(300);
    },
    async act(rec) {
      await rec.rects(["lead", "log", "lanes"]);
      // The in-memory session log keeps older entries: wait for a NEW "auto-sent" line.
      const autoSent = () => js(() => (document.body.innerText.match(/auto-sent/g) ?? []).length);
      const sentBefore = await autoSent();
      await sleep(700);
      await cursorClick({ sel: ".lc-seg-btn.is-autopilot" }, { move: 850, dwell: 320 });
      rec.mark("click-autopilot");
      await locate({ sel: "button", text: "Turn on autopilot" }, 4000);
      await sleep(1100);
      await cursorClick({ sel: "button", text: "Turn on autopilot" }, { move: 600, dwell: 260 });
      rec.mark("confirm");
      signal("autopilot-on");
      await until(async () => (await autoSent()) > sentBefore, 60000, "autopilot did not deliver to builder-2 (see Lead control in Mission Control)");
      rec.mark("delivered");
      await rec.rects(["log"]);
      await sleep(2300);
      await cursorClick({ sel: `[data-card="${sid("builder-2")}"]` }, { move: 700, dwell: 250 });
      rec.mark("jump");
      await sleep(350);
      await missionOpen(false);
      await js((id) => window.__gridkeeper.store.useApp.getState().setFocused(id), sid("builder-2"));
      await js(() => window.__gridkeeper.commands.runCommand("session.maximize"));
      maximized = true;
      await L("hideCursor");
      rec.mark("maximized");
      await sleep(5500);
      rec.mark("end");
    },
    async after() {
      await resetView();
      await setLeadMode("off");
      await missionOpen(false);
    },
  },
  signoff: {
    async prepare() {
      await setLeadMode("off");
      await missionOpen(false);
      resetBuilder1();
    },
    async arrange() {
      await showMission();
      await js(() => window.__gridkeeper.commands.runCommand("attention.markAllRead"));
      // Wait until no stale "done" card from an earlier shot is left in the sign-off dock.
      await until(() => js((id) => !document.querySelector(`[data-signoff="${id}"]`), sid("builder-1")), 10000);
    },
    async act(rec) {
      await rec.rects(["signoff", "board"]);
      await until(
        () => js((id) => /commit/i.test(document.querySelector(`[data-signoff="${id}"]`)?.textContent ?? ""), sid("builder-1")),
        60000,
        "builder-1 never reached sign-off with commit evidence",
      );
      rec.mark("signoff");
      await rec.rects(["signoff"]);
      await sleep(2300);
      await cursorClick({ sel: `[data-signoff="${sid("builder-1")}"] button`, text: "review diff" }, { move: 800, dwell: 280 });
      rec.mark("review");
      await until(() => js(() => !!document.querySelector(".changes-drawer")), 5000, "Changes drawer did not open");
      await sleep(900);
      // Open the first committed file if the drawer did not select one by itself.
      const file = await L("locate", { within: ".changes-drawer", text: "callback.ts" }, true);
      if (file && !(await js(() => /handleCallback/.test(document.querySelector(".changes-drawer")?.textContent ?? "")))) {
        await L("cursorTo", file.x, file.y, 600);
        await mouseClick(file.x, file.y);
        await L("ripple", file.x, file.y);
      }
      rec.mark("diff");
      await rec.rects(["drawer"]);
      await sleep(4800);
      rec.mark("end");
    },
  },
  drag: {
    async prepare() {
      await js(
        (st) => {
          const a = window.__gridkeeper.store.useApp.getState();
          const ws = a.persisted.workspaces.find((w) => w.id === st.wsId);
          if (!ws.groups.some((g) => g.id === st.verifyId)) {
            st.verifyId = a.createGroup(st.wsId, "Verify");
            a.setActiveGroup(st.wsId, st.buildId);
          }
          const build = a.persisted.workspaces.find((w) => w.id === st.wsId).groups.find((g) => g.id === st.buildId);
          if (!build.sessionIds.includes(st.ids.reviewer)) a.moveSessionToGroup(st.ids.reviewer, st.buildId, build.sessionIds.length);
          return st.verifyId;
        },
        ST,
      ).then((v) => {
        ST.verifyId = v;
        writeState(ST);
      });
    },
    async arrange() {
      await showMission();
      await L("locate", { sel: `[data-node="lane:${ST.buildId}"]` }, false);
      await sleep(300);
    },
    async act(rec) {
      await rec.rects(["lanes", "lead"]);
      await sleep(700);
      rec.mark("grab");
      const dst = (await js((id) => !!document.querySelector(`[data-node="lane:${id}"]`), ST.verifyId)) ? `[data-node="lane:${ST.verifyId}"]` : ".mc-newlane";
      const r = await L("fakeDrag", `[data-card="${sid("reviewer")}"]`, dst, 1300);
      rec.mark("drop");
      const moved = await js((st) => {
        const ws = window.__gridkeeper.store.useApp.getState().persisted.workspaces.find((w) => w.id === st.wsId);
        return !ws.groups.find((g) => g.id === st.buildId).sessionIds.includes(st.ids.reviewer);
      }, ST);
      if (!r?.ok || !moved) log(`  warning: the drop did not move the reviewer (${r?.why ?? "handler did not accept it"}); check the shot`);
      await sleep(400);
      await rec.rects(["lanes"]);
      await sleep(2600);
      await L("hideCursor");
      rec.mark("end");
    },
  },
  replay: {
    async prepare() {
      // Make sure the recording has a whole mission in it: finish the board while Mission Control is open.
      await showMission();
      let s = { ...MISSION.drag };
      for (const step of REPLAY_STEPS) {
        s = { ...s, ...step };
        writeMission(s);
        await sleep(900);
      }
      await sleep(1500);
      await missionOpen(false);
    },
    async arrange() {},
    async act(rec) {
      await sleep(600);
      await js(() => window.__gridkeeper.commands.runCommand("view.palette"));
      rec.mark("palette");
      await sleep(500);
      await typeText("replay", 90);
      await sleep(650);
      await key("Enter");
      if (!(await until(() => js(() => !!document.querySelector(".rp-modal")), 2500))) {
        log("  palette did not open the replay dialog; opening it with the command");
        await key("Escape");
        await js(() => window.__gridkeeper.commands.runCommand("mission.replay"));
        await until(() => js(() => !!document.querySelector(".rp-modal")), 5000, "replay dialog did not open");
      }
      rec.mark("dialog");
      await sleep(1600);
      await rec.rects(["replay"]);
      const len = await L("locate", { within: ".rp-modal", sel: "button, [role='radio']", text: "15 s" }, true);
      if (len) {
        await L("cursorTo", len.x, len.y, 650);
        await sleep(200);
        await mouseClick(len.x, len.y);
        await L("ripple", len.x, len.y);
        rec.mark("length");
      }
      await sleep(400);
      await L("hideCursor");
      await sleep(6500);
      rec.mark("end");
    },
    async after() {
      await resetView();
    },
  },
};

async function runShot(name) {
  const shot = SHOTS[name];
  const t0 = Date.now();
  log(`shot ${name}: arranging`);
  await js(installPageLib);
  await resetView();
  if (shot.prepare) await shot.prepare();
  writeMission(MISSION[name]);
  await startAgents(name);
  await shot.arrange();
  await sleep(1600); // context lines printed, board settled
  await C.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: OPT.scale, mobile: false });
  const rec = new Recorder(name);
  await rec.start();
  rec.mark("go");
  signal("go");
  let meta;
  try {
    await shot.act(rec);
  } finally {
    meta = await rec.stop();
  }
  if (shot.after) await shot.after();
  const fps = meta.frames.length / Math.max(0.001, meta.end);
  log(`shot ${name}: ${meta.end.toFixed(1)} s recorded, ${meta.frames.length} frames (${fps.toFixed(1)} fps), total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { name, seconds: meta.end, frames: meta.frames.length, fps, wall: (Date.now() - t0) / 1000 };
}

// ---- cards --------------------------------------------------------------------------------------------------
const END_CARD = {
  tagline: "Every agent in one grid.",
  url: "github.com/raazi29/gridkeeper",
  platforms: "Windows  ·  macOS and Linux in preview  ·  MIT",
  platformsV: ["Windows  ·  macOS and Linux in preview", "Open source, MIT"],
  install: ["Installers on the Releases page", "Mission protocol for any agent:  npx skills add raazi29/gridkeeper"],
  installV: ["Installers on the Releases page", "Mission protocol for any agent:", "npx skills add raazi29/gridkeeper"],
  footnote: "Recorded in the real app. The demo panes print scripted output; no AI was called.",
};

async function renderCards(cut) {
  const dir = path.join(OPT.work, "cards", cut.name);
  fs.mkdirSync(dir, { recursive: true });
  await js(installPageLib);
  const markSvg = fs.existsSync(MARK_SVG) ? fs.readFileSync(MARK_SVG, "utf8") : null;
  const all = [...cut.cards.map((c, i) => ({ ...c, file: `card${String(i).padStart(2, "0")}.png` }))];
  if (cut.tag) all.push({ style: "tag", title: DISCLOSURE, file: "tag.png" });
  for (const s of cut.segments) if (s.card) all.push({ ...END_CARD, style: s.card, file: `${s.card}.png` });
  for (const c of all) {
    const url = await L("renderCard", c, cut.w, cut.h, markSvg);
    if (!url) throw new Error(`card ${c.file} could not be drawn`);
    fs.writeFileSync(path.join(dir, c.file), Buffer.from(url.split(",")[1], "base64"));
  }
  const bg = (await L("palette"))?.bg0 ?? "#07090d";
  fs.writeFileSync(path.join(dir, "cards.json"), JSON.stringify({ bg, files: all.map((c) => c.file), theme: OPT.theme }, null, 2));
  log(`cards for ${cut.name}: ${all.length} PNGs`);
}

// ---- cuts (see docs/launch/script.md and cuts.md) -----------------------------------------------------------
const at = (mark, off = 0) => ({ mark, off });
const CUTS = {
  "45s": {
    name: "launch-45s",
    file: "launch-45s.mp4",
    w: 1920,
    h: 1080,
    tag: true,
    segments: [
      { shot: "grid", from: at("go", 0.5), dur: 1.4 },
      { shot: "board", from: at("go", 0.4), to: at("go", 2.6), dur: 1.6, focus: ["board"] },
      { shot: "grid", from: at("go", 2.5), dur: 2.5, dim: 0.62, blur: 5 },
      { shot: "board", from: at("go", 3.0), dur: 7.5, focus: ["board"] },
      { shot: "autopilot", from: at("click-autopilot", -0.9), to: at("delivered", 1.2), dur: 5.5, maxSpeed: 2.6, focus: ["lead", "log"] },
      { shot: "autopilot", from: at("maximized", 0.4), dur: 2.5 },
      { shot: "signoff", from: at("signoff", -1.5), to: at("review", -0.1), dur: 4.0, maxSpeed: 1.6, focus: ["signoff"] },
      { shot: "signoff", from: at("review", 0.5), dur: 4.0 },
      { shot: "drag", from: at("grab", -0.6), to: at("drop", 2.0), dur: 5.0, focus: ["lanes"] },
      { shot: "replay", from: at("palette", -0.3), to: at("dialog", 5.2), dur: 6.0, maxSpeed: 1.4 },
      { card: "end", dur: 5.0, fadeIn: 0.4 },
    ],
    cards: [
      { a: 0.25, b: 2.85, style: "lower", title: "Your coding agents, one board." },
      { a: 3.15, b: 5.35, style: "center", title: "Separate terminals. No shared plan." },
      { a: 5.75, b: 12.8, style: "lower", title: "Agents update one Markdown board.", sub: ".gridkeeper/mission.md  ·  [ ] [~] [x] [!]" },
      { a: 13.25, b: 18.3, style: "lower", title: "The lead hands out work.", sub: "Advisor: you approve each one  ·  Autopilot: idle agents only" },
      { a: 18.75, b: 20.8, style: "lower", title: "Delivered while builder-2 was idle." },
      { a: 21.25, b: 28.8, style: "lower", title: "Sign-off shows what changed.", sub: "commits  ·  files  ·  lines  ·  review diff" },
      { a: 29.25, b: 33.8, style: "lower", title: "Drag agents between lanes.", sub: "tasks onto agents  ·  lanes into phases" },
      { a: 34.25, b: 39.8, style: "lower", title: "Every mission becomes a replay.", sub: "15–60 s video or GIF, rendered in the app" },
    ],
  },
  hero: {
    name: "launch-hero",
    file: "launch-hero.mp4",
    gif: "launch-hero.gif",
    w: 1920,
    h: 1080,
    tag: false,
    seam: 0.6, // crossfade of the last 0.6 s into the first frame: the GIF loops without a jump
    segments: [
      { shot: "board", from: at("go", 0.4), to: at("go", 4.4), dur: 3.8, focus: ["board"] },
      { shot: "autopilot", from: at("confirm", -0.2), to: at("delivered", 0.8), dur: 3.4, maxSpeed: 3, focus: ["lead", "log"] },
      { shot: "signoff", from: at("signoff", -0.6), to: at("review", 1.6), dur: 3.4, maxSpeed: 1.8 },
      { shot: "drag", from: at("grab", -0.2), to: at("drop", 0.6), dur: 2.4, focus: ["lanes"] },
      { shot: "board", from: at("go", 10.0), dur: 2.6, focus: ["board"] },
    ],
    // Times are after the seam (the first 0.6 s of the assembled base is cut off): 15.0 s in total.
    cards: [
      { a: 0.0, b: 3.0, style: "label", title: "Agents update the board", fadeIn: 0 },
      { a: 3.4, b: 6.4, style: "label", title: "Lead on autopilot" },
      { a: 6.8, b: 9.8, style: "label", title: "Sign-off with git evidence" },
      { a: 10.2, b: 12.2, style: "label", title: "Drag between lanes" },
      { a: 12.6, b: 15.0, style: "label", title: "Agents update the board", fadeOut: 0 },
    ],
  },
  vertical: {
    name: "launch-vertical",
    file: "launch-vertical.mp4",
    w: 1080,
    h: 1920,
    tag: true,
    zone: { y: 520, h: 960 }, // footage area between the headline band and the caption band
    segments: [
      { shot: "board", from: at("go", 0.4), to: at("go", 2.6), dur: 2.5, focus: ["board"] },
      { shot: "board", from: at("go", 3.0), dur: 6.0, focus: ["board"] },
      { shot: "autopilot", from: at("click-autopilot", -0.6), to: at("delivered", 0.8), dur: 5.0, maxSpeed: 2.8, focus: ["lead", "log"] },
      { shot: "autopilot", from: at("maximized", 0.4), dur: 2.0, crop: { x: 0, y: 0.04, w: 0.62, h: 0.62 } },
      { shot: "signoff", from: at("signoff", -1.2), to: at("review", -0.1), dur: 3.5, maxSpeed: 1.6, focus: ["signoff"] },
      { shot: "signoff", from: at("review", 0.5), dur: 3.5, focus: ["drawer"] },
      { shot: "replay", from: at("palette", -0.3), to: at("dialog", 4.0), dur: 3.5, maxSpeed: 1.6, focus: ["replay"] },
      { card: "vend", dur: 4.0, fadeIn: 0.4 },
    ],
    cards: [
      { a: 0.2, b: 2.4, style: "vtop", title: "Your coding agents, one board." },
      { a: 2.6, b: 8.4, style: "vtop", title: "Agents update one Markdown board.", sub: ".gridkeeper/mission.md" },
      { a: 8.6, b: 13.4, style: "vtop", title: "The lead hands out work.", sub: "Autopilot: idle agents only" },
      { a: 13.6, b: 15.4, style: "vtop", title: "Delivered while builder-2 was idle." },
      { a: 15.6, b: 22.4, style: "vtop", title: "Sign-off shows what changed.", sub: "commits · files · lines · review diff" },
      { a: 22.6, b: 25.9, style: "vtop", title: "Every mission becomes a replay.", sub: "video or GIF, rendered in the app" },
    ],
  },
};

// ---- assembly (ffmpeg) --------------------------------------------------------------------------------------
function ff(args, label) {
  const r = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { stdio: ["ignore", "inherit", "inherit"] });
  if (r.error) throw new Error(`ffmpeg not runnable (${label}): ${r.error.message}`);
  if (r.status !== 0) throw new Error(`ffmpeg failed (${label}), exit ${r.status}`);
}
const n3 = (x) => Number(x).toFixed(3);
const even = (x) => Math.max(2, Math.round(x / 2) * 2);
const evenPos = (x) => Math.max(0, Math.floor(x / 2) * 2);
const X264 = ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(OUT_FPS), "-video_track_timescale", "15360", "-an"];

function shotMeta(name) {
  const p = path.join(SHOTS_DIR, name, "meta.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/** frames + measured times -> constant-frame-rate intermediate (concat demuxer with real durations). */
function shotVideo(name) {
  const meta = shotMeta(name);
  if (!meta) throw new Error(`shot "${name}" has not been recorded yet: node scripts/showcase/launch.mjs --only ${name}`);
  const dir = path.join(SHOTS_DIR, name);
  const out = path.join(dir, "shot.mp4");
  if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(path.join(dir, "meta.json")).mtimeMs) return { meta, file: out };
  const lines = ["ffconcat version 1.0"];
  const fr = meta.frames;
  for (let i = 0; i < fr.length; i++) {
    const next = i + 1 < fr.length ? fr[i + 1].t : meta.end;
    lines.push(`file 'frames/${fr[i].file}'`, `duration ${n3(Math.max(1 / 120, next - fr[i].t))}`);
  }
  lines.push(`file 'frames/${fr[fr.length - 1].file}'`);
  fs.writeFileSync(path.join(dir, "frames.ffconcat"), lines.join("\n") + "\n");
  ff(["-f", "concat", "-safe", "0", "-i", path.join(dir, "frames.ffconcat"), "-vf", `fps=${OUT_FPS},format=yuv420p`, "-c:v", "libx264", "-preset", "fast", "-crf", "12", "-an", out], `shot ${name}`);
  return { meta, file: out };
}

function resolveTime(meta, t, label) {
  if (typeof t === "number") return t;
  const m = meta.marks[t.mark];
  if (m === undefined) throw new Error(`${label}: shot "${meta.name}" has no mark "${t.mark}" (marks: ${Object.keys(meta.marks).join(", ")})`);
  return m + (t.off ?? 0);
}

/** Crop rectangle (device px) for a segment, fitted to `aspect`; never upscaled more than `maxUpscale` when it is
 *  scaled to `outW` pixels wide (capture with --scale 1.5 to allow tighter, still crisp framing). */
function framing(meta, seg, aspect, outW, maxUpscale) {
  const FW = meta.width, FH = meta.height;
  let r = null;
  if (seg.crop) r = { x: seg.crop.x * FW, y: seg.crop.y * FH, w: seg.crop.w * FW, h: seg.crop.h * FH };
  else if (seg.focus) {
    const rs = seg.focus.map((k) => meta.rects[k]).filter(Boolean);
    if (rs.length) {
      const x = Math.min(...rs.map((q) => q.x)), y = Math.min(...rs.map((q) => q.y));
      r = { x, y, w: Math.max(...rs.map((q) => q.x + q.w)) - x, h: Math.max(...rs.map((q) => q.y + q.h)) - y };
      const pad = 40 * meta.scale;
      r = { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
    }
  }
  if (!r) r = { x: 0, y: 0, w: FW, h: FH };
  // grow to the target aspect around the centre
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  let w = r.w, h = r.h;
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  const minW = outW / maxUpscale;
  if (w < minW) {
    w = minW;
    h = w / aspect;
  }
  if (w > FW) {
    w = FW;
    h = w / aspect;
  }
  if (h > FH) {
    h = FH;
    w = h * aspect;
  }
  const x = Math.min(Math.max(0, cx - w / 2), FW - w);
  const y = Math.min(Math.max(0, cy - h / 2), FH - h);
  const ex = evenPos(x), ey = evenPos(y);
  return { x: ex, y: ey, w: Math.min(even(w), FW - ex), h: Math.min(even(h), FH - ey) };
}

function renderSegment(cut, seg, i, dir, cardsDir, bg) {
  const out = path.join(dir, `seg${String(i).padStart(2, "0")}.mp4`);
  const fades = [];
  if (seg.fadeIn) fades.push(`fade=t=in:st=0:d=${seg.fadeIn}`);
  if (seg.fadeOut) fades.push(`fade=t=out:st=${n3(seg.dur - seg.fadeOut)}:d=${seg.fadeOut}`);
  if (seg.card) {
    const vf = [`scale=${cut.w}:${cut.h}`, `fps=${OUT_FPS}`, "format=yuv420p", ...fades].join(",");
    ff(["-loop", "1", "-framerate", String(OUT_FPS), "-t", n3(seg.dur), "-i", path.join(cardsDir, `${seg.card}.png`), "-vf", vf, ...X264, out], `${cut.name} seg ${i}`);
    return { out, info: `card ${seg.card}` };
  }
  const { meta, file } = shotVideo(seg.shot);
  const label = `${cut.name} seg ${i} (${seg.shot})`;
  const s0 = Math.max(0, resolveTime(meta, seg.from, label));
  let speed = 1;
  if (seg.to) {
    const s1 = resolveTime(meta, seg.to, label);
    speed = Math.max(1, (s1 - s0) / seg.dur);
    const max = seg.maxSpeed ?? 2;
    if (speed > max) {
      log(`  ${label}: span ${(s1 - s0).toFixed(2)} s needs ${speed.toFixed(2)}x, capped at ${max}x (end is cut)`);
      speed = max;
    }
  }
  const span = seg.dur * speed;
  if (s0 + span > meta.end + 0.05) log(`  ${label}: only ${(meta.end - s0).toFixed(2)} s of footage after the in-point; the last frame is held`);
  const vertical = cut.h > cut.w;
  const zone = vertical ? cut.zone : { y: 0, h: cut.h };
  const zoneAspect = cut.w / zone.h;
  const fr = framing(meta, seg, vertical ? zoneAspect : cut.w / cut.h, cut.w, seg.maxUpscale ?? (vertical ? 1.35 : 1.3));
  const chain = [`setpts=(PTS-STARTPTS)/${n3(speed)}`, `crop=${fr.w}:${fr.h}:${fr.x}:${fr.y}`];
  if (vertical) {
    let sw = cut.w, sh = even((fr.h * cut.w) / fr.w);
    if (sh > zone.h) {
      sh = zone.h;
      sw = even((fr.w * zone.h) / fr.h);
    }
    chain.push(`scale=${sw}:${sh}:flags=lanczos`, `pad=${cut.w}:${cut.h}:${evenPos((cut.w - sw) / 2)}:${evenPos(zone.y + (zone.h - sh) / 2)}:color=${bg}`);
  } else chain.push(`scale=${cut.w}:${cut.h}:flags=lanczos`);
  if (seg.blur) chain.push(`gblur=sigma=${seg.blur}`);
  if (seg.dim) chain.push(`drawbox=x=0:y=0:w=iw:h=ih:color=black@${seg.dim}:t=fill`);
  chain.push(`fps=${OUT_FPS}`, `tpad=stop_mode=clone:stop_duration=${n3(seg.dur)}`, `trim=duration=${n3(seg.dur)}`, "setpts=PTS-STARTPTS", ...fades, "format=yuv420p");
  ff(["-ss", n3(s0), "-t", n3(span + 0.2), "-i", file, "-vf", chain.join(","), ...X264, out], label);
  return { out, info: `${seg.shot} ${s0.toFixed(2)}+${span.toFixed(2)} s @${speed.toFixed(2)}x crop ${fr.w}x${fr.h}+${fr.x}+${fr.y}` };
}

async function assembleCut(key) {
  const cut = CUTS[key];
  const dir = path.join(OPT.work, "cut", cut.name);
  const cardsDir = path.join(OPT.work, "cards", cut.name);
  if (!fs.existsSync(path.join(cardsDir, "cards.json"))) {
    if (!C) throw new Error(`cards for ${cut.name} were never rendered; run once with the sandbox up (they need the app's fonts)`);
    await renderCards(cut);
  }
  const { bg } = JSON.parse(fs.readFileSync(path.join(cardsDir, "cards.json"), "utf8"));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  log(`cut ${cut.name}: ${cut.segments.length} segments`);
  const segs = cut.segments.map((s, i) => {
    const r = renderSegment(cut, s, i, dir, cardsDir, bg.startsWith("#") ? `0x${bg.slice(1)}` : "black");
    log(`  seg ${i}: ${s.dur.toFixed(2)} s  ${r.info}`);
    return r.out;
  });
  fs.writeFileSync(path.join(dir, "list.ffconcat"), "ffconcat version 1.0\n" + segs.map((s) => `file '${path.basename(s)}'`).join("\n") + "\n");
  let base = path.join(dir, "base.mp4");
  ff(["-f", "concat", "-safe", "0", "-i", path.join(dir, "list.ffconcat"), "-c", "copy", base], `${cut.name} concat`);
  let total = cut.segments.reduce((a, s) => a + s.dur, 0);
  if (cut.seam) {
    const d = cut.seam;
    const looped = path.join(dir, "looped.mp4");
    const body = total - d;
    ff(
      [
        "-i", base, "-filter_complex",
        `[0:v]split[a][b];[a]trim=start=${d},setpts=PTS-STARTPTS[body];[b]trim=end=${d},setpts=PTS-STARTPTS[head];[body][head]xfade=transition=fade:duration=${d}:offset=${n3(body - d)},format=yuv420p[v]`,
        "-map", "[v]", ...X264, looped,
      ],
      `${cut.name} seam`,
    );
    base = looped;
    total = body;
  }
  // overlay pass: cards (fade + slight rise), the disclosure tag, a silent audio track
  const inputs = ["-i", base];
  const graph = [];
  let prev = "0:v";
  let k = 1;
  const endStart = cut.segments.filter((s) => !s.card).reduce((a, s) => a + s.dur, 0) - (cut.seam ?? 0);
  const layers = cut.cards.map((c, i) => ({ ...c, file: `card${String(i).padStart(2, "0")}.png` }));
  if (cut.tag) layers.push({ a: 0, b: endStart, file: "tag.png", fadeIn: 0, fadeOut: 0.3, rise: 0 });
  for (const c of layers) {
    inputs.push("-loop", "1", "-framerate", String(OUT_FPS), "-t", n3(total), "-i", path.join(cardsDir, c.file));
    const fi = c.fadeIn ?? 0.28, fo = c.fadeOut ?? 0.22, rise = c.rise ?? 16;
    const f = ["format=rgba"];
    if (fi > 0) f.push(`fade=t=in:st=${n3(c.a)}:d=${fi}:alpha=1`);
    if (fo > 0) f.push(`fade=t=out:st=${n3(c.b - fo)}:d=${fo}:alpha=1`);
    graph.push(`[${k}:v]${f.join(",")}[c${k}]`);
    const y = rise && fi > 0 ? `'${rise}*max(0,1-(t-${n3(c.a)})/${n3(fi + 0.12)})'` : "0";
    graph.push(`[${prev}][c${k}]overlay=x=0:y=${y}:enable='between(t,${n3(c.a)},${n3(c.b)})':eof_action=pass[v${k}]`);
    prev = `v${k}`;
    k++;
  }
  graph.push(`[${prev}]format=yuv420p[vout]`);
  fs.writeFileSync(path.join(dir, "overlay.filter"), graph.join(";\n")); // for debugging; passed inline below
  // The hero loop's MP4 is only the GIF's source: it stays in the work folder.
  const outFile = path.join(cut.gif ? dir : OPT.out, cut.file);
  fs.mkdirSync(OPT.out, { recursive: true });
  const audio = cut.gif ? [] : ["-f", "lavfi", "-t", n3(total), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"];
  ff(
    [
      ...inputs, ...audio, "-filter_complex", graph.join(";"), "-map", "[vout]",
      ...(cut.gif ? ["-an"] : ["-map", `${k}:a`, "-c:a", "aac", "-b:a", "96k", "-shortest"]),
      "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(OUT_FPS), "-movflags", "+faststart", outFile,
    ],
    `${cut.name} overlay`,
  );
  log(`cut ${cut.name}: ${total.toFixed(1)} s -> ${path.relative(REPO_ROOT, outFile)} (${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  if (cut.gif) makeGif(outFile, path.join(OPT.out, cut.gif), dir);
}

/** Two-pass palette GIF, stepped down until it fits the README budget. */
function makeGif(src, gif, dir, maxBytes = 6 * 1024 * 1024) {
  const ladder = [
    [960, 15, 192],
    [960, 12, 160],
    [880, 12, 128],
    [800, 10, 128],
    [720, 10, 96],
  ];
  for (const [w, fps, colors] of ladder) {
    const pal = path.join(dir, "palette.png");
    ff(["-i", src, "-vf", `fps=${fps},scale=${w}:-1:flags=lanczos,palettegen=max_colors=${colors}:stats_mode=diff`, pal], "gif palette");
    ff(["-i", src, "-i", pal, "-lavfi", `fps=${fps},scale=${w}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, "-loop", "0", gif], "gif encode");
    const size = fs.statSync(gif).size;
    log(`  gif ${w}px ${fps} fps ${colors} colours: ${(size / 1e6).toFixed(2)} MB`);
    if (size <= maxBytes) return;
  }
  log(`  warning: ${path.basename(gif)} is still over ${(maxBytes / 1e6).toFixed(0)} MB; use the MP4 in the README instead`);
}

// ---- main ---------------------------------------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  if (OPT.assembleOnly) {
    try {
      C = await connect(OPT.port);
    } catch {
      C = null; // cards already rendered are reused; new cards need the app
    }
    for (const k of OPT.cuts) await assembleCut(k);
    C?.close();
    return;
  }
  C = await connect(OPT.port);
  const { assertSandbox } = await import("../e2e/cdp.mjs");
  await assertSandbox(C); // creates and closes sessions: sandbox instances only (or E2E_ALLOW_LIVE=1)
  await js(installPageLib);
  if (OPT.cleanupOnly) {
    ST = readState();
    await teardownApp(ST);
    log("cleaned up");
    C.close();
    return;
  }
  await C.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  await C.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: OPT.scale, mobile: false });
  const timings = [];
  try {
    const prior = readState();
    if (await stateUsable(prior).catch(() => false)) {
      ST = prior;
      log("reusing the demo workspace from the last --keep run");
    } else {
      if (prior) await teardownApp(prior);
      ST = await setupApp();
    }
    // Gridkeeper ignores "done" for runs in a session's first 20 s; give the panes that long.
    const wait = 22000 - (Date.now() - ST.launchedAt);
    if (wait > 0) {
      log(`waiting ${Math.ceil(wait / 1000)} s for the panes' start-up grace period`);
      await sleep(wait);
    }
    const shots = OPT.only ? OPT.only.map(resolveShot) : SHOT_ORDER;
    for (const s of SHOT_ORDER.filter((x) => shots.includes(x))) timings.push(await runShot(s));
    for (const k of OPT.cuts) await renderCards(CUTS[k]);
  } finally {
    await C.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await C.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
    if (!OPT.keep) await teardownApp(ST);
    else log(`kept the demo workspace and ${OPT.root} (next run reuses them; --cleanup-only removes them)`);
  }
  if (timings.length) {
    console.log("\nshot        recorded   frames    fps   wall");
    for (const t of timings) console.log(`${t.name.padEnd(10)} ${t.seconds.toFixed(1).padStart(7)} s ${String(t.frames).padStart(8)} ${t.fps.toFixed(1).padStart(6)} ${t.wall.toFixed(0).padStart(5)} s`);
  }
  if (!OPT.noAssemble) {
    const missing = SHOT_ORDER.filter((s) => !shotMeta(s));
    if (missing.length) log(`not assembling: shots not recorded yet: ${missing.join(", ")} (run with --only ${missing.join(",")})`);
    else for (const k of OPT.cuts) await assembleCut(k);
  }
  C.close();
  log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

main().catch((e) => {
  console.error(`launch: ${e?.stack ?? e}`);
  try {
    C?.close();
  } catch {}
  process.exit(1);
});
