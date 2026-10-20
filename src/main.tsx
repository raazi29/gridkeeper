import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/i18n.css";
import App from "./App";
import { initI18n } from "./i18n";
import { ipc } from "./lib/ipc";

window.addEventListener("error", (e) => ipc.log("error", `uncaught: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => ipc.log("error", `unhandled rejection: ${String(e.reason?.message ?? e.reason)}`));

// Dev-only stable handles for the CDP e2e scripts (scripts/e2e). Dynamic import() from a test would get a
// different module instance after Vite HMR, so tests must use these.
if (import.meta.env.DEV) {
  void Promise.all([
    import("./store/appStore"),
    import("./actions/sessions"),
    import("./terminal/registry"),
    import("./lib/ipc"),
    import("./store/mission"),
    import("./actions/commands"),
  ]).then(([store, sessions, registry, ipcMod, mission, commands]) => {
    (window as unknown as { __gridkeeper: unknown }).__gridkeeper = { store, sessions, registry, ipc: ipcMod.ipc, mission, commands };
  });
}

// The UI language (and right-to-left direction) is applied before the first frame; a non-English catalog is one
// small local chunk. Any failure falls back to English inside initI18n.
// No StrictMode: double-invoked effects would create/dispose terminals and channels twice.
void initI18n().finally(() => ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />));
