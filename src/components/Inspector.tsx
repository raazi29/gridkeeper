// Right-hand inspector for the focused session.

import { confirmCloseSession, confirmForceStop, focusSession } from "../actions/commands";
import { clearSession, copyOutput, hideView, restartSession, showView, startSession, stopSession } from "../actions/sessions";
import { isLive, useApp } from "../store/appStore";
import { useT } from "../i18n";
import { isWindows } from "../lib/platform";
import { useUi } from "../store/uiStore";
import { useDiagnosticsPoll } from "./hooks";
import { RolePicker } from "./mission/RoleTag";
import { IconClose, IconCopy } from "./icons";
import { Button, IconButton } from "./ui/Button";
import { Segmented, Toggle } from "./ui/Field";
import { copyText } from "./util/pick";
import { AGENT_LABEL, stateLabel } from "./util/session";
import { formatBytes, formatCpu, formatMb, formatTime, taskManagerCpu } from "./util/text";
import { PortsList } from "../browser/PortsList";
import { goHome, openExternal, popOut, reload } from "../actions/browser";
import { useBrowserNav } from "../browser/nav";

function BrowserDetails({ id }: { id: string }) {
  const t = useT();
  const meta = useApp((s) => s.persisted.sessions.find((m) => m.id === id));
  const probe = useBrowserNav((s) => s.panes[id]?.probe ?? null);
  const popout = useBrowserNav((s) => !!s.panes[id]?.popout);
  if (!meta) return null;
  const url = meta.url ?? null;
  const update = useApp.getState().updateSessionMeta;
  return (
    <div className="inspector-body">
      <div className="inspector-title">
        <span className="dot is-ok" />
        <button type="button" className="inspector-name" title={t("inspector.focusPane")} onClick={() => focusSession(id)}>
          {meta.name}
        </button>
        <span className="chip">{t("inspector.browserChip")}</span>
      </div>
      <div className="inspector-actions">
        <Button size="sm" onClick={() => reload(id)} disabled={!url}>
          {t("inspector.reload")}
        </Button>
        <Button size="sm" onClick={() => void popOut(id)} disabled={!url} title={t("inspector.popOutTitle")}>
          {t("inspector.popOut")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => openExternal(url)} disabled={!url?.startsWith("http")}>
          {t("inspector.openInBrowser")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => goHome(id)} disabled={!url}>
          {t("inspector.startPage")}
        </Button>
        <Button size="sm" variant="ghost" className="is-danger-text" onClick={() => void confirmCloseSession(id)}>
          {t("common.close")}
        </Button>
      </div>
      <div className="inspector-section">
        <div className="kv">
          <span className="kv-k">{t("inspector.address")}</span>
          <span className="kv-v mono kv-path" title={url ?? ""}>
            {url ?? t("inspector.startPage")}
          </span>
          {url && (
            <IconButton size="sm" label={t("inspector.copyAddress")} onClick={() => void copyText(url, t("inspector.addressCopied"))}>
              <IconCopy size={12} />
            </IconButton>
          )}
        </div>
        {probe && (
          <Row k={t("inspector.server")} mono>
            {probe.reachable ? `HTTP ${probe.status ?? "?"}` : (probe.error ?? t("inspector.noResponse"))}
          </Row>
        )}
        {probe?.frameable === false && <Row k={t("inspector.embedding")}>{t("inspector.embeddingRefused", { reason: probe.reason })}</Row>}
        <Row k={t("inspector.popOutRow")}>{popout ? t("inspector.popOutOpen") : "—"}</Row>
        <Toggle checked={!!meta.titleAsName} onChange={(v) => update(id, { titleAsName: v })} label={t("inspector.titleAsName")} />
        <p className="explain">{t("inspector.browserExplain")}</p>
      </div>
      <div className="inspector-section">
        <div className="section-label">{t("inspector.devServerPorts")}</div>
        <PortsList compact />
      </div>
    </div>
  );
}

export function Inspector() {
  const t = useT();
  const id = useApp((s) => s.focusedSessionId);
  const close = () => useApp.getState().updateSettings({ inspectorOpen: false });
  const diagOn = useApp((s) => s.persisted.settings.statusBarDiagnostics);
  // Shares the status-bar poll; never polls when the user turned resource usage off.
  useDiagnosticsPoll(!!id && diagOn);
  return (
    <aside className="inspector" aria-label={t("inspector.aria")}>
      <div className="inspector-head">
        <span className="panel-title">{t("inspector.title")}</span>
        <IconButton size="sm" label={t("inspector.close")} onClick={close}>
          <IconClose size={13} />
        </IconButton>
      </div>
      {id ? <SessionDetails id={id} key={id} /> : <div className="inspector-empty">{t("inspector.empty")}</div>}
    </aside>
  );
}

function Row({ k, children, mono, title }: { k: string; children: React.ReactNode; mono?: boolean; title?: string }) {
  return (
    <div className="kv">
      <span className="kv-k">{k}</span>
      <span className={`kv-v${mono ? " mono" : ""}`} title={title}>
        {children}
      </span>
    </div>
  );
}

function SessionDetails({ id }: { id: string }) {
  const t = useT();
  const meta = useApp((s) => s.persisted.sessions.find((m) => m.id === id));
  const info = useApp((s) => s.runtime[id]);
  const hidden = useApp((s) => !!s.hiddenViews[id]);
  const profile = useApp((s) => (meta?.profileId ? s.accounts.find((p) => p.id === meta.profileId) : undefined));
  const stats = useUi((s) => s.diag?.sessions.find((x) => x.id === id)?.stats);
  const cores = useUi((s) => s.diag?.logicalCores ?? 1);

  if (!meta) return <div className="inspector-empty">{t("inspector.notFound")}</div>;
  if (meta.kind === "browser") return <BrowserDetails id={id} />;
  const live = isLive(info);
  const st = stateLabel(info?.state);
  const exitCode = info?.state.state === "exited" ? info.state.code : meta.lastExitCode;
  const resumeMode = meta.resumeOnRestore.mode === "none" ? "none" : "continue";
  const update = useApp.getState().updateSessionMeta;

  return (
    <div className="inspector-body">
      <div className="inspector-title">
        <span className={`dot is-${st.tone}`} />
        <button type="button" className="inspector-name" title={t("inspector.focusSession")} onClick={() => focusSession(id)}>
          {meta.name}
        </button>
        <span className={`chip tone-${st.tone}`}>{st.label}</span>
      </div>
      {info?.state.state === "failed" && <div className="callout is-error">{info.state.message}</div>}

      <div className="inspector-actions">
        {live ? (
          <Button size="sm" onClick={() => void stopSession(id, false)} disabled={info?.state.state === "stopping"} title={t("inspector.stopTitle")}>
            {t("common.stop")}
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => void startSession(id, meta.resumeOnRestore)} title={t("inspector.startTitle")}>
            {t("common.start")}
          </Button>
        )}
        <Button size="sm" onClick={() => void restartSession(id, { mode: "continue" })} title={t("inspector.restartTitle")}>
          {t("common.restart")}
        </Button>
        <Button size="sm" onClick={() => void restartSession(id, { mode: "none" })} title={t("inspector.restartFreshTitle")}>
          {t("inspector.restartFresh")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copyOutput(id)} title={t("inspector.copyOutputTitle")}>
          {t("inspector.copyOutput")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void clearSession(id)}>
          {t("inspector.clear")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => (hidden ? showView(id) : hideView(id))} title={hidden ? t("inspector.showViewTitle") : t("inspector.hideViewTitle")}>
          {hidden ? t("inspector.showView") : t("inspector.hideView")}
        </Button>
        <Button size="sm" variant="ghost" className="is-danger-text" onClick={() => void confirmForceStop(id)} disabled={!live} title={t("inspector.forceStopTitle")}>
          {t("inspector.forceStop")}
        </Button>
        <Button size="sm" variant="ghost" className="is-danger-text" onClick={() => void confirmCloseSession(id)} title={t("inspector.closeSessionTitle")}>
          {t("common.close")}
        </Button>
      </div>

      <div className="inspector-section">
        <Row k={t("inspector.agent")}>{AGENT_LABEL[meta.agent]}</Row>
        <div className="kv">
          <span className="kv-k">{t("inspector.role")}</span>
          <span className="kv-v">
            <RolePicker value={meta.role ?? null} onChange={(role) => update(id, { role })} />
          </span>
        </div>
        {meta.agent === "claude" && (
          <Row k={t("inspector.account")}>
            {profile ? (
              <>
                <span className="dot" style={{ background: profile.color }} /> {profile.name}
              </>
            ) : (
              t("inspector.accountDefault")
            )}
          </Row>
        )}
        <div className="kv">
          <span className="kv-k">{t("inspector.directory")}</span>
          <span className="kv-v mono kv-path" title={meta.cwd}>
            {meta.cwd}
          </span>
          <IconButton size="sm" label={t("inspector.copyPath")} onClick={() => void copyText(meta.cwd, t("inspector.pathCopied"))}>
            <IconCopy size={12} />
          </IconButton>
        </div>
        {meta.worktree && (
          <Row k={t("inspector.worktree")} mono title={meta.worktree.path}>
            {meta.worktree.branch ?? t("inspector.detached")}
          </Row>
        )}
        <Row k={t("inspector.pid")} mono>
          {info?.pid ?? "—"}
        </Row>
        <Row k={t("inspector.exitCode")} mono>
          {exitCode ?? "—"}
        </Row>
        <Row k={t("inspector.started")}>{formatTime(info?.startedAt)}</Row>
        <Row k={t("inspector.ended")}>{formatTime(info?.endedAt)}</Row>
        <Row k={t("inspector.output")} mono>
          {info ? formatBytes(info.bytesOut) : "—"}
        </Row>
        <Row k={t("inspector.cpuRam")} mono title={isWindows ? t("inspector.cpuRamTitleWindows") : t("inspector.cpuRamTitle")}>
          {stats ? t("inspector.cpuRamValue", { cpu: formatCpu(taskManagerCpu(stats.cpuPercent, cores)), ram: formatMb(stats.memoryBytes), count: stats.processCount }) : "—"}
        </Row>
        {info?.commandDisplay && (
          <div className="kv kv-block">
            <span className="kv-k">{t("inspector.command")}</span>
            <code className="code-inline" title={info.commandDisplay}>
              {info.commandDisplay}
            </code>
          </div>
        )}
      </div>

      <div className="inspector-section">
        <div className="section-label">{t("inspector.ports")}</div>
        {live ? <PortsList sessionId={id} compact emptyText={t("inspector.portsEmpty")} /> : <p className="explain">{t("inspector.notRunning")}</p>}
      </div>

      <div className="inspector-section">
        <div className="section-label">{t("inspector.onRestore")}</div>
        <Toggle checked={meta.autoStart} onChange={(v) => update(id, { autoStart: v })} label={t("inspector.autoStart")} />
        {meta.agent !== "powershell" && meta.agent !== "generic" && (
          <div className="resume-row">
            <span className="resume-label">{t("inspector.conversation")}</span>
            <Segmented
              size="sm"
              ariaLabel={t("inspector.resumeAria")}
              value={resumeMode}
              onChange={(v) => update(id, { resumeOnRestore: v === "none" ? { mode: "none" } : { mode: "continue" } })}
              options={[
                { value: "none", label: t("inspector.resumeNew") },
                { value: "continue", label: t("inspector.resumeContinue") },
              ]}
            />
          </div>
        )}
        <p className="explain">
          {t("inspector.restoreExplain")}
          {meta.agent === "claude" && ` ${t("inspector.restoreExplainClaude")}`}
          {meta.agent === "codex" && ` ${t("inspector.restoreExplainCodex")}`}
        </p>
      </div>
    </div>
  );
}
