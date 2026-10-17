import { useEffect } from "react";
import { restoreSessions } from "./actions/sessions";
import { Shell } from "./components/Shell";
import { errorMessage, ipc, onSessionState } from "./lib/ipc";
import { flushPersistence, startPersistence, useApp } from "./store/appStore";

let booted = false;

async function boot() {
  if (booted) return;
  booted = true;
  const app = useApp.getState();
  // Subscribe to process state before anything can start.
  await onSessionState((info) => {
    const s = useApp.getState();
    s.setRuntime(info);
    if (info.state.state === "exited") s.updateSessionMeta(info.id, { lastExitCode: info.state.code });
  });
  try {
    const state = await ipc.stateLoad();
    app.hydrate(state);
    if (state.workspaces.length === 0) {
      useApp.getState().createWorkspace("Workspace", null);
    }
  } catch (e) {
    useApp.setState({ loaded: true, loadError: errorMessage(e) });
  }
  startPersistence();
  window.addEventListener("beforeunload", () => void flushPersistence());

  // Re-sync runtime for sessions that are already running (e.g. after a webview reload).
  for (const info of await ipc.sessionList().catch(() => [])) useApp.getState().setRuntime(info);

  ipc.profilesList().then((p) => useApp.getState().setProfiles(p)).catch(() => {});
  ipc.agentsDetect().then((a) => useApp.getState().setAgents(a)).catch(() => {});
  await restoreSessions();
}

export default function App() {
  const loaded = useApp((s) => s.loaded);
  useEffect(() => {
    void boot();
  }, []);
  if (!loaded) return <div className="boot" />;
  return <Shell />;
}
