// mission-recap headless export: opens the recap page in a local Chrome / Edge / Chromium (headless, a
// throwaway profile), asks it to render (window.GridkeeperRecap.render) and copies the result to disk
// over the DevTools protocol. Needs Node >= 22 (built-in WebSocket). Never touches the user's browser
// profile or other browser windows; the browser it starts is closed again.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

const CHUNK = 4 * 1024 * 1024;

function envGet(env, name) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

/** Likely browser executables for this OS, most preferred first ($CHROME_PATH wins). */
export function browserCandidates(platform = process.platform, env = process.env) {
  const out = [];
  const chromePath = envGet(env, "CHROME_PATH");
  if (chromePath) out.push(chromePath);
  if (platform === "win32") {
    const roots = [envGet(env, "PROGRAMFILES"), envGet(env, "PROGRAMFILES(X86)"), envGet(env, "LOCALAPPDATA")].filter(Boolean);
    const rel = [
      ["Google", "Chrome", "Application", "chrome.exe"],
      ["Microsoft", "Edge", "Application", "msedge.exe"],
      ["Chromium", "Application", "chrome.exe"],
      ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
    ];
    for (const r of rel) for (const root of roots) out.push(join(root, ...r));
  } else if (platform === "darwin") {
    const apps = [
      "Google Chrome.app/Contents/MacOS/Google Chrome",
      "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "Chromium.app/Contents/MacOS/Chromium",
      "Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
    for (const a of apps) for (const root of ["/Applications", join(homedir(), "Applications")]) out.push(`${root}/${a}`);
  } else {
    const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable", "brave-browser"];
    const dirs = (envGet(env, "PATH") ?? "").split(delimiter).filter(Boolean);
    for (const n of names) for (const d of dirs) out.push(join(d, n));
    out.push("/snap/bin/chromium");
  }
  return out;
}

export function findBrowser(explicit, platform = process.platform, env = process.env) {
  if (explicit) return existsSync(explicit) ? explicit : null;
  return browserCandidates(platform, env).find((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  }) ?? null;
}

/** Why headless export can't run here (null = it can). */
export function headlessUnavailable(version = process.versions.node, hasWebSocket = typeof globalThis.WebSocket === "function") {
  const major = Number(String(version).split(".")[0]);
  if (major < 22 || !hasWebSocket) return `headless export needs Node 22 or newer (this is ${version})`;
  return null;
}

// ---- DevTools protocol ------------------------------------------------------------------------------

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const listeners = new Set();
    const fail = (err) => {
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    };
    ws.addEventListener("message", (e) => {
      let m;
      try {
        m = JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(e.data).toString("utf8"));
      } catch {
        return;
      }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
        else p.resolve(m.result);
      } else for (const l of listeners) l(m);
    });
    ws.addEventListener("close", () => fail(new Error("browser connection closed")));
    ws.addEventListener("error", () => reject(new Error("could not connect to the browser")));
    ws.addEventListener("open", () =>
      resolve({
        send(method, params = {}, sessionId) {
          const msg = { id: ++id, method, params };
          if (sessionId) msg.sessionId = sessionId;
          return new Promise((res, rej) => {
            pending.set(msg.id, { resolve: res, reject: rej, method });
            ws.send(JSON.stringify(msg));
          });
        },
        on(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        close() {
          try {
            ws.close();
          } catch {
            /* closed */
          }
        },
      }),
    );
  });
}

function waitForDevTools(child, profile, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const done = (fn, v) => {
      clearInterval(poll);
      clearTimeout(timer);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      fn(v);
    };
    const onData = (d) => {
      buf += d.toString();
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) done(resolve, m[1]);
    };
    const onExit = (code) => done(reject, new Error(`the browser exited before it was ready (code ${code})`));
    const poll = setInterval(() => {
      try {
        const [port, path] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/);
        if (port && path) done(resolve, `ws://127.0.0.1:${port.trim()}${path.trim()}`);
      } catch {
        /* not yet */
      }
    }, 200);
    const timer = setTimeout(() => done(reject, new Error("the browser did not start its DevTools endpoint in time")), timeoutMs);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(d.exception?.description?.split("\n")[0] ?? d.text ?? "page error");
  }
  return r.result?.value;
}

/**
 * Render the recap page `html` to `out` (kind "video" or "gif"). Resolves { ok, file, size, note } or
 * { ok: false, reason } (never throws for expected problems: no Node 22, no browser, page errors).
 */
export async function renderHeadless({ html, kind, out, browser: explicit, length = 30, log = (s) => process.stdout.write(s) }) {
  const why = headlessUnavailable();
  if (why) return { ok: false, reason: why };
  const browser = findBrowser(explicit ?? null);
  if (!browser) return { ok: false, reason: explicit ? `browser not found: ${explicit}` : "no Chrome, Edge or Chromium found (set CHROME_PATH or pass --browser <path>)" };

  const profile = mkdtempSync(join(tmpdir(), "mission-recap-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--mute-audio",
    "--hide-scrollbars",
    "--window-size=1280,900",
    "about:blank",
  ];
  const child = spawn(browser, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let cdp = null;
  // Live progress only on a terminal; piped output (an agent reading it) gets the final line only.
  const tty = !!process.stdout.isTTY;
  const progress = (label, pct) => tty && log(`\r  ${(kind === "gif" ? "gif" : "video").padEnd(9)}${label} ${String(pct).padStart(3)}%   `);
  const endLine = () => tty && log("\n");
  try {
    const wsUrl = await waitForDevTools(child, profile, 30_000);
    cdp = await connect(wsUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    cdp.on((m) => {
      if (m.sessionId !== sessionId || m.method !== "Runtime.consoleAPICalled") return;
      const a = (m.params?.args ?? []).map((x) => x.value);
      if (a[0] === "[recap]") progress(a[1] === "encode" ? "finishing" : kind === "gif" ? "encoding" : "recording", a[1] === "encode" ? 100 : Number(a[2]) || 0);
    });
    const loaded = new Promise((resolve) => {
      const off = cdp.on((m) => {
        if (m.sessionId === sessionId && m.method === "Page.loadEventFired") {
          off();
          resolve();
        }
      });
    });
    await cdp.send("Page.navigate", { url: pathToFileURL(html).href }, sessionId);
    await Promise.race([loaded, new Promise((_, rej) => setTimeout(() => rej(new Error("the page did not load")), 30_000))]);
    const ready = await evaluate(
      cdp,
      sessionId,
      `new Promise((resolve) => { let n = 0; const t = setInterval(() => { const api = window.GridkeeperRecap; if (api) { clearInterval(t); api.ready.then(() => resolve(true)); } else if (++n > 300) { clearInterval(t); resolve(false); } }, 50); })`,
    );
    if (!ready) throw new Error("the recap page did not start (no events, or the player failed)");
    if (kind === "video") {
      const mime = await evaluate(cdp, sessionId, "window.GridkeeperRecap.info().video");
      if (!mime) throw new Error("this browser cannot record canvas video");
    }
    progress(kind === "gif" ? "encoding" : `recording ${length} s in real time`, 0);
    const meta = await evaluate(cdp, sessionId, `window.GridkeeperRecap.render(${JSON.stringify(kind)})`);
    endLine();
    let file = out;
    let note = "";
    if (kind === "video" && meta.ext !== "mp4" && /\.mp4$/i.test(file)) {
      file = file.replace(/\.mp4$/i, `.${meta.ext}`);
      note = `(this browser records ${meta.ext.toUpperCase()}, not MP4)`;
    }
    const tmp = `${file}.part`;
    const fd = openSync(tmp, "w");
    try {
      for (let off = 0; off < meta.size; off += CHUNK) {
        const b64 = await evaluate(cdp, sessionId, `window.GridkeeperRecap.chunk(${off}, ${CHUNK})`);
        writeSync(fd, Buffer.from(b64, "base64"));
      }
    } catch (e) {
      closeSync(fd);
      rmSync(tmp, { force: true });
      throw e;
    }
    closeSync(fd);
    renameSync(tmp, file);
    return { ok: true, file, size: meta.size, note };
  } catch (e) {
    endLine();
    return { ok: false, reason: e?.message ?? String(e) };
  } finally {
    try {
      await Promise.race([cdp?.send("Browser.close"), new Promise((r) => setTimeout(r, 3000))]);
    } catch {
      /* already gone */
    }
    cdp?.close();
    // Only the browser this function started, and only if it did not exit on Browser.close.
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((r) => {
        const t = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* gone */
          }
          r();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(t);
          r();
        });
      });
    }
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      /* temp folder; the OS cleans it */
    }
  }
}
