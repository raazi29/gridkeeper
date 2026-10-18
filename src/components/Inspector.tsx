// Right-hand inspector for the focused session.

import { confirmCloseSession, confirmForceStop, focusSession } from "../actions/commands";
import { clearSession, copyOutput, hideView, restartSession, showView, startSession, stopSession } from "../actions/sessions";
import { isLive, useApp } from "../store/appStore";
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
        <button type="button" className="inspector-name" title="Focus this pane" onClick={() => focusSession(id)}>
          {meta.name}
        </button>
        <span className="chip">Browser</span>
      </div>
      <div className="inspector-actions">
        <Button size="sm" onClick={() => reload(id)} disabled={!url}>
          Reload
        </Button>
        <Button size="sm" onClick={() => void popOut(id)} disabled={!url} title="Open in a separate Gridkeeper window (any site, file: pages)">
          Pop out
        </Button>
        <Button size="sm" variant="ghost" onClick={() => openExternal(url)} disabled={!url?.startsWith("http")}>
          Open in browser
        </Button>
        <Button size="sm" variant="ghost" onClick={() => goHome(id)} disabled={!url}>
          Start page
        </Button>
        <Button size="sm" variant="ghost" className="is-danger-text" onClick={() => void confirmCloseSession(id)}>
          Close
        </Button>
      </div>
      <div className="inspector-section">
        <div className="kv">
          <span className="kv-k">Address</span>
          <span className="kv-v mono kv-path" title={url ?? ""}>
            {url ?? "Start page"}
          </span>
          {url && (
            <IconButton size="sm" label="Copy address" onClick={() => void copyText(url, "Address copied")}>
              <IconCopy size={12} />
            </IconButton>
          )}
        </div>
        {probe && (
          <Row k="Server" mono>
            {probe.reachable ? `HTTP ${probe.status ?? "?"}` : (probe.error ?? "No response")}
          </Row>
        )}
        {probe?.frameable === false && <Row k="Embedding">Refused ({probe.reason})</Row>}
        <Row k="Pop-out">{popout ? "Open" : "—"}</Row>
        <Toggle checked={!!meta.titleAsName} onChange={(v) => update(id, { titleAsName: v })} label="Name follows page title" />
        <p className="explain">
          Browser panes have no process. Pages run in a sandboxed frame without access to Gridkeeper; back / forward cover the addresses opened here, not
          link clicks inside the page. Sites that refuse embedding open in a pop-out window.
        </p>
      </div>
      <div className="inspector-section">
        <div className="section-label">Dev-server ports</div>
        <PortsList compact />
      </div>
    </div>
  );
}

export function Inspector() {
  const id = useApp((s) => s.focusedSessionId);
  const close = () => useApp.getState().updateSettings({ inspectorOpen: false });
  const diagOn = useApp((s) => s.persisted.settings.statusBarDiagnostics);
  // Shares the status-bar poll; never polls when the user turned resource usage off.
  useDiagnosticsPoll(!!id && diagOn);
  return (
    <aside className="inspector" aria-label="Session inspector">
      <div className="inspector-head">
        <span className="panel-title">Inspector</span>
        <IconButton size="sm" label="Close inspector" onClick={close}>
          <IconClose size={13} />
        </IconButton>
      </div>
      {id ? <SessionDetails id={id} key={id} /> : <div className="inspector-empty">Focus a session to see its details.</div>}
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
  const meta = useApp((s) => s.persisted.sessions.find((m) => m.id === id));
  const info = useApp((s) => s.runtime[id]);
  const hidden = useApp((s) => !!s.hiddenViews[id]);
  const profile = useApp((s) => (meta?.profileId ? s.accounts.find((p) => p.id === meta.profileId) : undefined));
  const stats = useUi((s) => s.diag?.sessions.find((x) => x.id === id)?.stats);
  const cores = useUi((s) => s.diag?.logicalCores ?? 1);

  if (!meta) return <div className="inspector-empty">Session not found.</div>;
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
        <button type="button" className="inspector-name" title="Focus this session" onClick={() => focusSession(id)}>
          {meta.name}
        </button>
        <span className={`chip tone-${st.tone}`}>{st.label}</span>
      </div>
      {info?.state.state === "failed" && <div className="callout is-error">{info.state.message}</div>}

      <div className="inspector-actions">
        {live ? (
          <Button size="sm" onClick={() => void stopSession(id, false)} disabled={info?.state.state === "stopping"} title="Ask the process to exit gracefully">
            Stop
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={() => void startSession(id, meta.resumeOnRestore)} title="Start the process (uses the restore setting below)">
            Start
          </Button>
        )}
        <Button size="sm" onClick={() => void restartSession(id, { mode: "continue" })} title="Restart and resume the conversation where supported">
          Restart
        </Button>
        <Button size="sm" onClick={() => void restartSession(id, { mode: "none" })} title="Restart with a new, empty conversation">
          Restart fresh
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copyOutput(id)} title="Copy the buffered output as text">
          Copy output
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void clearSession(id)}>
          Clear
        </Button>
        <Button size="sm" variant="ghost" onClick={() => (hidden ? showView(id) : hideView(id))} title={hidden ? "Show the terminal view" : "Hide the view; the process keeps running"}>
          {hidden ? "Show view" : "Hide view"}
        </Button>
        <Button size="sm" variant="ghost" className="is-danger-text" onClick={() => void confirmForceStop(id)} disabled={!live} title="Kill the whole process tree">
          Force stop
        </Button>
        <Button size="sm" variant="ghost" className="is-danger-text" onClick={() => void confirmCloseSession(id)} title="Stop the process and remove the session">
          Close
        </Button>
      </div>

      <div className="inspector-section">
        <Row k="Agent">{AGENT_LABEL[meta.agent]}</Row>
        <div className="kv">
          <span className="kv-k">Role</span>
          <span className="kv-v">
            <RolePicker value={meta.role ?? null} onChange={(role) => update(id, { role })} />
          </span>
        </div>
        {meta.agent === "claude" && (
          <Row k="Account">
            {profile ? (
              <>
                <span className="dot" style={{ background: profile.color }} /> {profile.name}
              </>
            ) : (
              "Default (~/.claude)"
            )}
          </Row>
        )}
        <div className="kv">
          <span className="kv-k">Directory</span>
          <span className="kv-v mono kv-path" title={meta.cwd}>
            {meta.cwd}
          </span>
          <IconButton size="sm" label="Copy path" onClick={() => void copyText(meta.cwd, "Path copied")}>
            <IconCopy size={12} />
          </IconButton>
        </div>
        {meta.worktree && (
          <Row k="Worktree" mono title={meta.worktree.path}>
            {meta.worktree.branch ?? "detached"}
          </Row>
        )}
        <Row k="PID" mono>
          {info?.pid ?? "—"}
        </Row>
        <Row k="Exit code" mono>
          {exitCode ?? "—"}
        </Row>
        <Row k="Started">{formatTime(info?.startedAt)}</Row>
        <Row k="Ended">{formatTime(info?.endedAt)}</Row>
        <Row k="Output" mono>
          {info ? formatBytes(info.bytesOut) : "—"}
        </Row>
        <Row k="CPU / RAM" mono title={isWindows ? "Process tree of this session (Task Manager style CPU)" : "Process tree of this session (share of all logical cores)"}>
          {stats ? `${formatCpu(taskManagerCpu(stats.cpuPercent, cores))} · ${formatMb(stats.memoryBytes)} · ${stats.processCount} proc` : "—"}
        </Row>
        {info?.commandDisplay && (
          <div className="kv kv-block">
            <span className="kv-k">Command</span>
            <code className="code-inline" title={info.commandDisplay}>
              {info.commandDisplay}
            </code>
          </div>
        )}
      </div>

      <div className="inspector-section">
        <div className="section-label">Ports</div>
        {live ? <PortsList sessionId={id} compact emptyText="Not listening on any TCP port." /> : <p className="explain">Not running.</p>}
      </div>

      <div className="inspector-section">
        <div className="section-label">On app restore</div>
        <Toggle checked={meta.autoStart} onChange={(v) => update(id, { autoStart: v })} label="Auto-start process" />
        {meta.agent !== "powershell" && meta.agent !== "generic" && (
          <div className="resume-row">
            <span className="resume-label">Conversation</span>
            <Segmented
              size="sm"
              ariaLabel="Resume on restore"
              value={resumeMode}
              onChange={(v) => update(id, { resumeOnRestore: v === "none" ? { mode: "none" } : { mode: "continue" } })}
              options={[
                { value: "none", label: "New" },
                { value: "continue", label: "Continue" },
              ]}
            />
          </div>
        )}
        <p className="explain">
          Restoring the layout is not the same as reconnecting a process, and neither is resuming an AI conversation. Processes never survive app exit or a reboot — they are started again.
          {meta.agent === "claude" && " Claude resumes this pane’s own conversation via its pinned session id."}
          {meta.agent === "codex" && " Codex resumes with “resume --last”: the most recent conversation in this folder, which may belong to another pane."}
        </p>
      </div>
    </div>
  );
}
