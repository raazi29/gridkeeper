// Minimal Chrome DevTools Protocol driver for the running Altera WebView2 (no dependencies; Node >= 22).
// Launch Altera with:  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
// Usage:
//   node scripts/e2e/cdp.mjs eval "<js expression>"        -> prints JSON result (awaits promises)
//   node scripts/e2e/cdp.mjs shot out.png                   -> screenshot of the window
//   node scripts/e2e/cdp.mjs file script.js                  -> evaluate a file's contents

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

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("cdp.mjs")) {
  const [cmd, arg] = process.argv.slice(2);
  const c = await connect();
  try {
    if (cmd === "eval") console.log(JSON.stringify(await c.evaluate(arg), null, 2));
    else if (cmd === "file") console.log(JSON.stringify(await c.evaluate(readFileSync(arg, "utf8")), null, 2));
    else if (cmd === "shot") {
      await c.screenshot(arg);
      console.log(`saved ${arg}`);
    } else console.log("usage: eval <js> | file <path> | shot <out.png>");
  } finally {
    c.close();
  }
}
