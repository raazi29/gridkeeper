// Bottom status bar (24px): breadcrumb, running count, app vs agents resources, renderer status.

import { APP_NAME } from "../lib/brand";
import { useApp, isLive, selectActiveGroup, selectActiveWorkspace } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { CommsButton, FleetButton } from "./Comms";
import { useDiagnosticsPoll, useRendererStatus, useShortcut } from "./hooks";
import { formatCpu, formatMb, taskManagerCpu } from "./util/text";
import { stateLabel } from "./util/session";

export function StatusBar() {
  const wsName = useApp((s) => selectActiveWorkspace(s)?.name ?? "");
  const groupName = useApp((s) => selectActiveGroup(s)?.name ?? "");
  const focusedName = useApp((s) => {
    const id = s.focusedSessionId;
    const g = selectActiveGroup(s);
    if (!id || !g?.sessionIds.includes(id)) return null;
    return s.persisted.sessions.find((m) => m.id === id)?.name ?? null;
  });
  const focusedTone = useApp((s) => {
    const id = s.focusedSessionId;
    return id ? stateLabel(s.runtime[id]?.state).tone : "muted";
  });
  const running = useApp((s) => {
    let n = 0;
    for (const id in s.runtime) if (isLive(s.runtime[id])) n++;
    return n;
  });
  const showDiag = useApp((s) => s.persisted.settings.statusBarDiagnostics);
  const scPalette = useShortcut("view.palette");
  useDiagnosticsPoll(showDiag);

  const open = () => useUi.getState().openDialog({ kind: "diagnostics" });

  return (
    <footer className="statusbar" role="contentinfo">
      <div className="sb-left">
        <span className="sb-item sb-crumbs" title="Workspace › group › focused session">
          <span>{wsName}</span>
          {groupName && <span className="sb-sep">›</span>}
          {groupName && <span>{groupName}</span>}
          {focusedName && <span className="sb-sep">›</span>}
          {focusedName && (
            <span className="sb-focused">
              <span className={`dot is-${focusedTone}`} />
              {focusedName}
            </span>
          )}
        </span>
        <span className="sb-div" />
        <span className="sb-item" title="Live sessions across all workspaces">
          {running > 0 && <span className="dot is-ok" />}
          {running} running
        </span>
      </div>
      <div className="sb-right">
        <FleetButton />
        <CommsButton />
        <span className="sb-div" />
        {showDiag && <ResourceItems onClick={open} />}
        <RendererItem onClick={open} />
        {scPalette && (
          <>
            <span className="sb-div" />
            <button type="button" className="sb-item sb-btn" title="Command palette" onClick={() => useUi.getState().openPalette("all")}>
              <kbd className="kbd">{scPalette}</kbd>
            </button>
          </>
        )}
      </div>
    </footer>
  );
}

function ResourceItems({ onClick }: { onClick: () => void }) {
  const diag = useUi((s) => s.diag);
  const diagError = useUi((s) => s.diagError);
  if (!diag) {
    return (
      <>
        <button type="button" className="sb-item sb-btn" onClick={onClick} title={diagError ? `Diagnostics unavailable: ${diagError}` : "Collecting…"}>
          App —
        </button>
        <span className="sb-div" />
      </>
    );
  }
  const cores = diag.logicalCores;
  const appCpu = taskManagerCpu(diag.host.cpuPercent + diag.webview.cpuPercent, cores);
  const appMem = diag.host.memoryBytes + diag.webview.memoryBytes;
  const agCpu = taskManagerCpu(diag.sessionsTotal.cpuPercent, cores);
  const agMem = diag.sessionsTotal.memoryBytes;
  return (
    <>
      <button
        type="button"
        className="sb-item sb-btn"
        onClick={onClick}
        title={`${APP_NAME} app = host process + WebView2 (${diag.host.processCount + diag.webview.processCount} processes)\nCPU as in Task Manager: share of all ${cores} logical cores`}
      >
        App CPU {formatCpu(appCpu)} · RAM {formatMb(appMem)}
      </button>
      <span className="sb-div" />
      <button
        type="button"
        className="sb-item sb-btn"
        onClick={onClick}
        title={`All session process trees (${diag.sessionsTotal.processCount} processes): agents, shells, builds, git…`}
      >
        Agents CPU {formatCpu(agCpu)} · RAM {formatMb(agMem)}
      </button>
      <span className="sb-div" />
    </>
  );
}

function RendererItem({ onClick }: { onClick: () => void }) {
  const r = useRendererStatus();
  let text: string;
  let title: string;
  if (r.webglActive > 0) {
    text = `GPU: WebGL ×${r.webglActive}`;
    title = `${r.gpuRenderer ?? "GPU renderer string unavailable"}${r.domActive ? `\n${r.domActive} terminal(s) on DOM renderer` : ""}${r.contextLosses ? `\n${r.contextLosses} WebGL context loss(es)` : ""}`;
  } else if (r.domActive > 0) {
    text = "Renderer: DOM (software)";
    title = r.webglSupported ? `WebGL available: ${r.gpuRenderer ?? "unknown GPU"}` : "WebGL unavailable in this WebView";
  } else {
    text = r.webglSupported ? "Renderer: WebGL ready" : "Renderer: —";
    title = r.gpuRenderer ?? "No terminals open";
  }
  return (
    <button type="button" className="sb-item sb-btn" onClick={onClick} title={title}>
      {text}
    </button>
  );
}
