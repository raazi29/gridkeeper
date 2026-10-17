import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles/tokens.css";
import "./styles/app.css";
import App from "./App";
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
  ]).then(([store, sessions, registry, ipcMod]) => {
    (window as unknown as { __gridkeeper: unknown }).__gridkeeper = { store, sessions, registry, ipc: ipcMod.ipc };
  });
}

// No StrictMode: double-invoked effects would create/dispose terminals and channels twice.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
