import ReactDOM from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles/tokens.css";
import "./styles/app.css";
import App from "./App";
import { ipc } from "./lib/ipc";

window.addEventListener("error", (e) => ipc.log("error", `uncaught: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => ipc.log("error", `unhandled rejection: ${String(e.reason?.message ?? e.reason)}`));

// No StrictMode: double-invoked effects would create/dispose terminals and channels twice.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
