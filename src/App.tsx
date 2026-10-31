import { useEffect } from "react";
import { loadAccountAgents, refreshAccounts, scanAccounts } from "./actions/accounts";
import { maybeAutoRetry, restoreSessions } from "./actions/sessions";
import { setupBench } from "./bench";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Shell } from "./components/Shell";
import { errorMessage, ipc, onSessionState } from "./lib/ipc";
import { flushPersistence, startPersistence, useApp } from "./store/appStore";
import { startMemoryWatch } from "./store/memguard";
import { preloadFont } from "./styles/fonts";
import "./theme/applyTheme";
import { t, useT } from "./i18n";

let booted = false;

async function boot() {
  if (booted) return;
  booted = true;
  const app = useApp.getState();
  // Subscribe to process state before anything can start.
  await onSessionState((info) => {
    const s = useApp.getState();
    s.setRuntime(info);
    if (info.state.state === "exited") {
      s.updateSessionMeta(info.id, { lastExitCode: info.state.code });
      maybeAutoRetry(info);
    }
  });
  // Low-memory guard: the current level must be known before restored sessions launch (awaited below).
  const memoryWatch = startMemoryWatch();
  const info = await ipc.appInfo().catch(() => null);
  if (info?.bench) {
    // Benchmark mode: in-memory workspace only; never persisted.
    app.hydrate({ ...(await ipc.stateLoad().catch(() => useApp.getState().persisted)), workspaces: [], sessions: [] });
    ipc.agentsDetect().then((a) => useApp.getState().setAgents(a)).catch(() => {});
    setupBench(info);
    return;
  }
  try {
    const state = await ipc.stateLoad();
    app.hydrate(state);
    await preloadFont(useApp.getState().persisted.settings.fontFamily);
    if (state.workspaces.length === 0) {
      useApp.getState().createWorkspace(t("command.defaultWorkspaceName"), null);
    }
  } catch (e) {
    useApp.setState({ loaded: true, loadError: errorMessage(e) });
  }
  startPersistence();
  window.addEventListener("beforeunload", () => void flushPersistence());

  // Re-sync runtime for sessions that are already running (e.g. after a webview reload).
  for (const info of await ipc.sessionList().catch(() => [])) useApp.getState().setRuntime(info);

  ipc.profilesList().then((p) => useApp.getState().setProfiles(p)).catch(() => {});
  void refreshAccounts();
  void loadAccountAgents();
  const detected = ipc
    .agentsDetect()
    .then((a) => useApp.getState().setAgents(a))
    .catch(() => {});
  await memoryWatch;
  await restoreSessions();
  // Account auto-detection (all agents) once agents are detected and restored sessions are
  // launched: status checks skip accounts with a live session (Claude Code #91708).
  void detected.finally(() => void scanAccounts());
}

export default function App() {
  const tr = useT();
  const loaded = useApp((s) => s.loaded);
  useEffect(() => {
    void boot();
  }, []);
  if (!loaded) return <div className="boot" />;
  return (
    <ErrorBoundary scope={tr("errors.scopeApp")}>
      <Shell />
    </ErrorBoundary>
  );
}
