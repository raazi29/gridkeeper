// Minimal Chrome DevTools Protocol driver for a running Gridkeeper WebView2 (no dependencies; Node >= 22).
// Start a test instance next to your live Gridkeeper with:  npm run sandbox   (CDP on 9333, see scripts/dev/sandbox.ps1)
// Usage (CDP_PORT selects the instance; default 9222):
//   node scripts/e2e/cdp.mjs eval "<js expression>"        -> prints JSON result (awaits promises)
//   node scripts/e2e/cdp.mjs shot out.png                   -> screenshot of the window
//   node scripts/e2e/cdp.mjs file script.js                  -> evaluate a file's contents
// `file` scripts create and close sessions and workspaces, so they only run against a sandbox instance
// (ipc.appInfo().sandbox set, i.e. GRIDKEEPER_SANDBOX) unless E2E_ALLOW_LIVE=1. They see a global E2E_CWD:
// the working folder for their sessions (env E2E_CWD, default: the current directory).

import { readFileSync, writeFileSync } from "node:fs";

const PORT = process.env.CDP_PORT ?? "9222";

export async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === "page" && !t.url.startsWith("devtools"));
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 2000));
    return r.result?.result?.value;
  };
  const screenshot = async (path) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(path, Buffer.from(r.result.data, "base64"));
  };
  return { send, evaluate, screenshot, close: () => ws.close() };
}

/** Working folder handed to e2e scripts as the global `E2E_CWD`. */
export const E2E_CWD = process.env.E2E_CWD ?? process.cwd();

/** Wraps a script so it sees `E2E_CWD`. The block keeps the const out of the page's global scope (so a script can
 *  run twice) and still yields the script's last expression (the IIFE's promise) as the completion value. */
export function withE2eGlobals(source) {
  return `{\nconst E2E_CWD = ${JSON.stringify(E2E_CWD)};\n${source}\n}`;
}

/** Throws unless the connected instance is a sandbox (GRIDKEEPER_SANDBOX) or E2E_ALLOW_LIVE=1. Scripts that create
 *  and close sessions must never run against the app the developer's live agents are running in. */
export async function assertSandbox(c) {
  if (process.env.E2E_ALLOW_LIVE === "1") return { sandbox: null, allowedLive: true };
  const probe = await c.evaluate(`(async () => {
    for (let i = 0; i < 50 && !window.__gridkeeper; i++) await new Promise((r) => setTimeout(r, 100));
    const G = window.__gridkeeper;
    if (!G) return { handles: false };
    const info = await G.ipc.appInfo();
    return { handles: true, sandbox: info.sandbox ?? null, version: info.version };
  })()`);
  if (!probe?.handles) {
    throw new Error(
      `refusing to run: no window.__gridkeeper on CDP port ${PORT}, so the instance can't be verified as a sandbox ` +
        `(e2e scripts need a dev build: npm run sandbox). Set E2E_ALLOW_LIVE=1 to override.`,
    );
  }
  if (!probe.sandbox) {
    throw new Error(
      `refusing to run: the instance on CDP port ${PORT} (v${probe.version}) is not a sandbox. e2e scripts create and ` +
        `close sessions; start a test instance with 'npm run sandbox' and set CDP_PORT=9333, or set E2E_ALLOW_LIVE=1 ` +
        `if you really mean this instance.`,
    );
  }
  return { sandbox: probe.sandbox, allowedLive: false };
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("cdp.mjs")) {
  const [cmd, arg] = process.argv.slice(2);
  const c = await connect();
  try {
    if (cmd === "eval") console.log(JSON.stringify(await c.evaluate(arg), null, 2));
    else if (cmd === "file") {
      let allowed = true;
      try {
        await assertSandbox(c);
      } catch (e) {
        console.error(String(e?.message ?? e));
        process.exitCode = 2;
        allowed = false;
      }
      if (allowed) console.log(JSON.stringify(await c.evaluate(withE2eGlobals(readFileSync(arg, "utf8"))), null, 2));
    } else if (cmd === "shot") {
      await c.screenshot(arg);
      console.log(`saved ${arg}`);
    } else console.log("usage: eval <js> | file <path> | shot <out.png>");
  } finally {
    c.close();
  }
}
