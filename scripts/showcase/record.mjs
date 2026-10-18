// Records a scripted tour of the running dev app (CDP screencast) and encodes it with ffmpeg.
// Prereqs: a dev sandbox (npm run sandbox; then CDP_PORT=9333), ffmpeg on PATH. Sessions run in E2E_CWD (default: cwd).
// Usage: node scripts/showcase/record.mjs [outDir]   -> outDir/gridkeeper-demo.mp4 + .gif + key frames (.png)
// The tour only uses a dedicated "Showcase" workspace with PowerShell panes (no accounts dialog, no e-mails).

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertSandbox, connect, E2E_CWD } from "../e2e/cdp.mjs";

const outDir = resolve(process.argv[2] ?? "docs/assets/showcase");
const framesDir = join(outDir, "frames");
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

const W = 1600;
const H = 900;
const c = await connect();
await assertSandbox(c); // the tour creates and closes sessions: sandbox instances only (or E2E_ALLOW_LIVE=1)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const js = (fn, ...args) => c.evaluate(`(${fn})(${args.map((a) => JSON.stringify(a)).join(",")})`);

// ---- frame capture ---------------------------------------------------------------------------
const frames = [];
let recording = false;
const ws = c; // send() + raw events
const origSend = ws.send;
await ws.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await sleep(800);

async function shot(name) {
  await c.screenshot(join(outDir, `${name}.png`));
}

// Poll screenshots at ~12 fps while recording (screencast events need a raw listener; polling is simpler and reliable).
async function recordLoop() {
  let i = 0;
  while (recording) {
    const t0 = Date.now();
    const r = await origSend("Page.captureScreenshot", { format: "jpeg", quality: 88 });
    if (r?.result?.data) {
      const f = join(framesDir, `f${String(i++).padStart(5, "0")}.jpg`);
      writeFileSync(f, Buffer.from(r.result.data, "base64"));
      frames.push({ f, t: t0 });
    }
    const dt = Date.now() - t0;
    if (dt < 83) await sleep(83 - dt);
  }
}

// ---- tour helpers (run inside the page) -------------------------------------------------------
const setup = (cwd) => (async () => {
  const G = window.__gridkeeper;
  const { useApp } = G.store;
  for (const w of useApp.getState().persisted.workspaces.filter((w) => w.name === "Showcase")) {
    for (const id of w.groups.flatMap((g) => g.sessionIds)) await G.sessions.closeSession(id);
    useApp.getState().deleteWorkspace(w.id);
  }
  const scripts = cwd + "\\scripts\\bench";
  const wsId = useApp.getState().createWorkspace("Showcase", cwd);
  const g = useApp.getState().persisted.workspaces.find((w) => w.id === wsId).groups[0].id;
  useApp.getState().renameGroup(g, "Build");
  const mk = (name, args, role) => {
    const id = G.sessions.newSession({ groupId: g, agent: "powershell", cwd, name, args });
    if (role) useApp.getState().updateSessionMeta(id, { role });
    return id;
  };
  mk("lead · planner", ["-NoProfile"], "lead");
  mk("builder 1", ["-NoProfile", "-NoExit", "-File", `${scripts}\\flood.ps1`, "-Mode", "sustained", "-Rate", "120", "-Seconds", "600"], "builder");
  mk("builder 2", ["-NoProfile", "-NoExit", "-File", `${scripts}\\flood.ps1`, "-Mode", "sustained", "-Rate", "60", "-Seconds", "600"], "builder");
  mk("tests", ["-NoProfile", "-NoExit", "-File", `${scripts}\\flood.ps1`, "-Mode", "unicode"], "verifier");
  return wsId;
})();

const theme = (id) => window.__gridkeeper.store.useApp.getState().updateSettings({ theme: id });
const cmd = (id) => window.__gridkeeper.commands.runCommand(id);
const typeInto = (name, text) => {
  const { useApp } = window.__gridkeeper.store;
  const m = useApp.getState().persisted.sessions.find((s) => s.name === name);
  if (m) window.__gridkeeper.ipc.sessionWrite(m.id, text);
};

// ---- the tour ---------------------------------------------------------------------------------
const prevTheme = await js(() => window.__gridkeeper.store.useApp.getState().persisted.settings.theme);
await js(setup, E2E_CWD);
await js(theme, "deep-space");
await sleep(6000);
recording = true;
const loop = recordLoop();

await sleep(2500); // grid of live sessions
await js(typeInto, "lead · planner", "Write-Host 'Gridkeeper: every agent in one grid' -ForegroundColor Cyan\r");
await sleep(2500);
await shot("01-grid");
for (const t of ["hyperspace", "saber-duel", "holo-comms", "twin-suns", "ice-planet", "phosphor", "rebel-squadron"]) {
  await js(theme, t);
  await sleep(1300);
  if (t === "saber-duel") await shot("02-saber-duel");
  if (t === "ice-planet") await shot("03-ice-planet");
}
await js(theme, "deep-space");
await sleep(1000);
await js(cmd, "view.mission");
await sleep(4500);
await shot("04-mission-control");
await js(cmd, "view.mission");
await sleep(800);
await js(cmd, "view.fleet");
await sleep(3500);
await shot("05-fleet");
await js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
await sleep(500);
await js(cmd, "view.fleet");
await sleep(600);
await js(cmd, "view.palette");
await sleep(2500);
await shot("06-palette");
await js(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
await sleep(1200);

recording = false;
await loop;
await js(theme, prevTheme ?? "deep-space");
// Leave the user's app as it was: remove the Showcase workspace and its sessions.
await c.evaluate(`(async () => {
  const G = window.__gridkeeper; const { useApp } = G.store;
  for (const w of useApp.getState().persisted.workspaces.filter((w) => w.name === "Showcase")) {
    for (const id of w.groups.flatMap((g) => g.sessionIds)) await G.sessions.closeSession(id);
    useApp.getState().deleteWorkspace(w.id);
  }
})()`);
await ws.send("Emulation.clearDeviceMetricsOverride", {});
c.close();

// ---- encode -----------------------------------------------------------------------------------
const durationS = (frames.at(-1).t - frames[0].t) / 1000;
const fps = Math.max(1, Math.round(frames.length / durationS));
const mp4 = join(outDir, "gridkeeper-demo.mp4");
const gif = join(outDir, "gridkeeper-demo.gif");
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", join(framesDir, "f%05d.jpg"),
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", mp4], { stdio: "inherit" });
execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4, "-vf",
  "fps=12,scale=1200:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3", gif], { stdio: "inherit" });
rmSync(framesDir, { recursive: true, force: true });
console.log(JSON.stringify({ frames: frames.length, seconds: Math.round(durationS), fps, mp4, gif }));
