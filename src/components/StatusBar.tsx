// Bottom status bar (24px): breadcrumb, running count, app vs agents resources, renderer status.

import { APP_NAME } from "../lib/brand";
import { useT } from "../i18n";
import { cpuShareLabel, webviewLabel } from "../lib/platform";
import { useApp, isLive, selectActiveGroup, selectActiveWorkspace } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { CommsButton, FleetButton } from "./Comms";
import { gpuLoadText, gpuTooltip } from "./GpuSection";
import { AutopilotChip } from "./mission/LeadControl";
import { MemoryLevelChip } from "./MemoryGuard";
import { MemoryPressureChip } from "./ResourceWarnings";
import { ThemeChip } from "./ThemeSwitcher";
import { useDiagnosticsPoll, useRendererStatus, useShortcut } from "./hooks";
import { formatCpu, formatMb, taskManagerCpu } from "./util/text";
import { stateLabel } from "./util/session";

export function StatusBar() {
  const t = useT();
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
        <span className="sb-item sb-crumbs" title={t("shell.status.crumbsTitle")}>
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
        <span className="sb-item" title={t("shell.status.runningTitle")}>
          {running > 0 && <span className="dot is-ok" />}
          {t("shell.status.running", { count: running })}
        </span>
        <span className="sb-div" />
        <ThemeChip />
      </div>
      <div className="sb-right">
        <AutopilotChip />
        <FleetButton />
        <CommsButton />
        <span className="sb-div" />
        <MemoryLevelChip />
        {showDiag && <MemoryPressureChip onClick={open} />}
        {showDiag && <ResourceItems onClick={open} />}
        <RendererItem onClick={open} live={showDiag} />
        {scPalette && (
          <>
            <span className="sb-div" />
            <button type="button" className="sb-item sb-btn" title={t("shell.status.palette")} onClick={() => useUi.getState().openPalette("all")}>
              <kbd className="kbd">{scPalette}</kbd>
            </button>
          </>
        )}
      </div>
    </footer>
  );
}

function ResourceItems({ onClick }: { onClick: () => void }) {
  const t = useT();
  const diag = useUi((s) => s.diag);
  const diagError = useUi((s) => s.diagError);
  if (!diag) {
    return (
      <>
        <button type="button" className="sb-item sb-btn" onClick={onClick} title={diagError ? t("shell.status.diagUnavailable", { error: diagError }) : t("shell.status.collecting")}>
          {t("shell.status.appPending")}
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
        title={t("shell.status.appTitle", { app: APP_NAME, webview: webviewLabel(), processes: diag.host.processCount + diag.webview.processCount, cpu: cpuShareLabel(), cores })}
      >
        {t("shell.status.appUsage", { cpu: formatCpu(appCpu), ram: formatMb(appMem) })}
      </button>
      <span className="sb-div" />
      <button
        type="button"
        className="sb-item sb-btn"
        onClick={onClick}
        title={t("shell.status.agentsTitle", { processes: diag.sessionsTotal.processCount })}
      >
        {t("shell.status.agentsUsage", { cpu: formatCpu(agCpu), ram: formatMb(agMem) })}
      </button>
      <span className="sb-div" />
    </>
  );
}

function RendererItem({ onClick, live }: { onClick: () => void; live: boolean }) {
  const t = useT();
  const r = useRendererStatus();
  // GPU load only while the status bar holds the diagnostics poll (otherwise the figure could be stale).
  const diag = useUi((s) => (live ? s.diag : null));
  const load = gpuLoadText(diag);
  let text: string;
  let title: string;
  if (r.webglActive > 0) {
    text = load ? t("shell.status.gpuWebglLoad", { count: r.webglActive, load }) : t("shell.status.gpuWebgl", { count: r.webglActive });
    const gpuTip = diag?.gpu ? gpuTooltip(diag) : ""; // "" on macOS / Linux (no GPU telemetry there)
    title = `${r.gpuRenderer ?? t("shell.status.gpuRendererUnavailable")}${r.domActive ? `\n${t("shell.status.domTerminals", { count: r.domActive })}` : ""}${r.contextLosses ? `\n${t("shell.status.contextLosses", { count: r.contextLosses })}` : ""}${gpuTip ? `\n\n${gpuTip}` : ""}`;
  } else if (r.domActive > 0) {
    text = t("shell.status.rendererDom");
    title = r.webglSupported ? t("shell.status.webglAvailable", { gpu: r.gpuRenderer ?? t("shell.status.unknownGpu") }) : t("shell.status.webglUnavailable");
  } else {
    text = r.webglSupported ? t("shell.status.rendererReady") : t("shell.status.rendererNone");
    title = r.gpuRenderer ?? t("shell.status.noTerminals");
  }
  return (
    <button type="button" className="sb-item sb-btn" onClick={onClick} title={title}>
      {text}
    </button>
  );
}
