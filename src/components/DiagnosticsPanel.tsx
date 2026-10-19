// Diagnostics modal: per-process resource table, renderer status, export. Polls only while open.

import { useT } from "../i18n";
import { APP_NAME } from "../lib/brand";
import { isWindows, webviewHint, webviewLabel } from "../lib/platform";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { errorMessage, ipc } from "../lib/ipc";
import type { ProcStats } from "../lib/types";
import { selectActiveGroup, useApp } from "../store/appStore";
import { webglOverBudget } from "../lib/pressure";
import { MAX_WEBGL } from "../terminal/webglBudget";
import { GpuSection } from "./GpuSection";
import { actionToast, useUi } from "../store/uiStore";
import { useDiagnosticsPoll, useRendererStatus } from "./hooks";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { revealPath } from "./util/pick";
import { AGENT_LABEL } from "./util/session";
import { formatCpu, formatMb, taskManagerCpu } from "./util/text";
import { notify } from "../actions/notify";

export function DiagnosticsPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  useDiagnosticsPoll(true);
  const diag = useUi((s) => s.diag);
  const diagError = useUi((s) => s.diagError);
  const renderer = useRendererStatus();
  const names = useApp(useShallow((s) => Object.fromEntries(s.persisted.sessions.map((m) => [m.id, `${m.name}\u0000${m.agent}`]))));
  const pids = useApp(useShallow((s) => Object.fromEntries(Object.values(s.runtime).map((r) => [r.id, r.pid ?? 0]))));
  const [exporting, setExporting] = useState(false);
  const visibleInGroup = useApp((s) => {
    const g = selectActiveGroup(s);
    if (!g) return 0;
    return g.layout.maximized ? 1 : g.sessionIds.filter((id) => !s.hiddenViews[id]).length;
  });
  const overBudget = webglOverBudget(visibleInGroup);

  const cores = diag?.logicalCores ?? 1;
  const cpu = (p: ProcStats) => formatCpu(taskManagerCpu(p.cpuPercent, cores));

  const doExport = async () => {
    setExporting(true);
    try {
      const s = useApp.getState();
      const path = await ipc.diagnosticsExport({
        renderer,
        ui: {
          workspaces: s.persisted.workspaces.length,
          groups: s.persisted.workspaces.reduce((n, w) => n + w.groups.length, 0),
          sessions: s.persisted.sessions.filter((m) => (m.kind ?? "terminal") === "terminal").length,
          browserPanes: s.persisted.sessions.filter((m) => m.kind === "browser").length,
          liveSessions: Object.values(s.runtime).filter((r) => r.state.state === "running" || r.state.state === "starting").length,
          hiddenViews: Object.keys(s.hiddenViews).length,
          settings: { ...s.persisted.settings, keybindings: undefined },
          window: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
        },
        userAgent: navigator.userAgent,
      });
      actionToast({ kind: "info", message: t("diagnostics.exported"), detail: path, action: { label: t("diagnostics.openFolder"), run: () => void revealPath(path) } });
    } catch (e) {
      notify("error", t("diagnostics.exportFailed", { error: errorMessage(e) }));
    } finally {
      setExporting(false);
    }
  };

  return (
    <Modal
      title={t("diagnostics.title")}
      onClose={onClose}
      width={760}
      footer={
        <>
          <span className="footer-note">{t("diagnostics.footerNote")}</span>
          <Button onClick={onClose}>{t("common.close")}</Button>
          <Button variant="primary" onClick={() => void doExport()} disabled={exporting}>
            {exporting ? t("diagnostics.exporting") : t("diagnostics.export")}
          </Button>
        </>
      }
    >
      {diagError && !diag && <div className="callout is-error">{t("diagnostics.unavailable", { error: diagError })}</div>}
      <table className="table">
        <thead>
          <tr>
            <th>{t("diagnostics.colProcess")}</th>
            <th>{t("diagnostics.colAgent")}</th>
            <th className="num">PID</th>
            <th className="num">{t("diagnostics.colProcs")}</th>
            <th className="num">CPU</th>
            <th className="num">RAM</th>
          </tr>
        </thead>
        <tbody>
          {diag ? (
            <>
              <tr className="row-strong">
                <td>{t("diagnostics.host", { app: APP_NAME })}</td>
                <td className="muted">Rust</td>
                <td className="num muted">—</td>
                <td className="num">{diag.host.processCount}</td>
                <td className="num">{cpu(diag.host)}</td>
                <td className="num">{formatMb(diag.host.memoryBytes)}</td>
              </tr>
              <tr className="row-strong" title={isWindows ? undefined : webviewHint()}>
                <td>{webviewLabel()}</td>
                <td className="muted">{isWindows ? t("diagnostics.uiRenderer") : t("diagnostics.uiRendererBestEffort")}</td>
                <td className="num muted">—</td>
                <td className="num">{diag.webview.processCount}</td>
                <td className="num">{cpu(diag.webview)}</td>
                <td className="num">{formatMb(diag.webview.memoryBytes)}</td>
              </tr>
              {diag.sessions.map(({ id, stats }) => {
                const [name, agent] = (names[id] ?? `${t("diagnostics.unknownSession")}\u0000`).split("\u0000");
                return (
                  <tr key={id}>
                    <td>{name}</td>
                    <td className="muted">{agent ? AGENT_LABEL[agent as keyof typeof AGENT_LABEL] : "—"}</td>
                    <td className="num mono">{pids[id] || "—"}</td>
                    <td className="num">{stats.processCount}</td>
                    <td className="num">{cpu(stats)}</td>
                    <td className="num">{formatMb(stats.memoryBytes)}</td>
                  </tr>
                );
              })}
              <tr className="row-total">
                <td>{t("diagnostics.allSessions")}</td>
                <td className="muted">{t("diagnostics.running", { count: diag.runningSessions })}</td>
                <td className="num" />
                <td className="num">{diag.sessionsTotal.processCount}</td>
                <td className="num">{cpu(diag.sessionsTotal)}</td>
                <td className="num">{formatMb(diag.sessionsTotal.memoryBytes)}</td>
              </tr>
            </>
          ) : (
            <tr>
              <td colSpan={6} className="muted">
                {diagError ? "—" : t("diagnostics.collecting")}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="diag-grid">
        <div className="diag-card">
          <div className="section-label">{t("diagnostics.system")}</div>
          {diag ? (
            <>
              <div className="kv">
                <span className="kv-k">{t("diagnostics.memory")}</span>
                <span className="kv-v">
                  {formatMb(diag.systemMemoryUsed)} / {formatMb(diag.systemMemoryTotal)}
                </span>
              </div>
              <div className="kv">
                <span className="kv-k">{t("diagnostics.logicalCores")}</span>
                <span className="kv-v">{diag.logicalCores}</span>
              </div>
            </>
          ) : (
            <div className="muted">—</div>
          )}
        </div>
        <div className="diag-card">
          <div className="section-label">{t("diagnostics.terminalRenderer")}</div>
          <div className="kv">
            <span className="kv-k">GPU</span>
            <span className="kv-v mono" title={renderer.gpuRenderer ?? undefined}>
              {renderer.gpuRenderer ?? (renderer.webglSupported ? t("diagnostics.gpuUnknown") : t("gpu.webglUnavailable"))}
            </span>
          </div>
          <div className="kv">
            <span className="kv-k">{t("diagnostics.webglTerminals")}</span>
            <span className="kv-v">{renderer.webglActive}</span>
          </div>
          <div className="kv">
            <span className="kv-k">{t("diagnostics.domTerminals")}</span>
            <span className="kv-v">{renderer.domActive}</span>
          </div>
          <div className="kv">
            <span className="kv-k">{t("diagnostics.contextLosses")}</span>
            <span className="kv-v">{renderer.contextLosses}</span>
          </div>
        </div>
      </div>
      <GpuSection diag={diag} renderer={renderer} />
      {overBudget && (
        <div className="callout is-warn pressure-note" role="status">
          {t("diagnostics.overBudget", { visible: visibleInGroup, max: MAX_WEBGL })}
        </div>
      )}
      <p className="explain">
        {isWindows ? t("diagnostics.explainWindows") : t("diagnostics.explainOther")}
      </p>
    </Modal>
  );
}
