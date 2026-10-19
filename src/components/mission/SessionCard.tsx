// Mission Control session mini card: name, agent glyph, role, account, worktree branch, state lamp +
// label and how long it has been in that state (uptime in the tooltip; "ran …" once stopped), current mission
// task (from .gridkeeper/mission.md), last output line, real output-rate sparkline and CPU/RAM (shared
// diagnostics poll). Rows are the same for every card of a workspace (placeholders where a value is missing),
// so cards line up.
// Hover / selection shows a toolbar (jump, restart, stop/start, mute, close) in place of the role tag; right-click
// opens the shared session menu; a session that needs you gets an "Answer →" call to action.

import { memo, useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { confirmCloseSession } from "../../actions/commands";
import { assignTaskToSession } from "../../actions/missionAssign";
import { notify } from "../../actions/notify";
import { toggleSessionMute, useSessionMuted } from "../../actions/notifyPrefs";
import { renameSession, startSession } from "../../actions/sessions";
import type { TaskState } from "../../lib/missionDoc";
import type { SessionId } from "../../lib/types";
import { AgentGlyph, IconClose, IconPlay, IconRestart, IconStop } from "../../layout/icons";
import { findGroupOf, useApp } from "../../store/appStore";
import { resolveAccountName } from "../../store/activity";
import { useAttention } from "../../store/attention";
import { formatRate, latestRate, useRates } from "../../store/rates";
import { clearRenameRequest, renameSeqFor, useRenameRequest } from "../../store/renameRequest";
import { useUi } from "../../store/uiStore";
import { IconExternal } from "../icons";
import { confirmRestart, confirmStop } from "../menus/sessionMenu";
import { IconBell } from "../AttentionBits";
import { IconBellOff } from "../MutedGlyph";
import { MeterCardLine } from "../MeterChip";
import { formatUptime } from "../util/fleet";
import { basename, formatCpu, formatMb, formatSince, formatTime, taskManagerCpu } from "../util/text";
import { LAMP_TEXT, sessionStatus, type DropSide } from "./derive";
import { beginSessionDrag, currentTaskDrag, dragHas, endSessionDrag, endTaskDrag, SESSION_MIME, TASK_MIME, useMcDragKind } from "./mcDrag";
import { RoleTag, roleStyle } from "./RoleTag";
import { Sparkline } from "./Sparkline";
import { useMissionTails } from "./useOutputTails";
import { evidencePath } from "../../actions/handoff";
import { runTestsForSession } from "../../store/testrun";
import { IconFlask, TestBadge } from "../testrun/TestBadge";

export const SessionCard = memo(function SessionCard({
  id,
  selected,
  onSelect,
  onJump,
  onMenu,
  now,
  task,
  taskState,
  board = false,
  diag = false,
  dropSide,
}: {
  id: SessionId;
  selected: boolean;
  onSelect: (id: SessionId) => void;
  onJump: (id: SessionId) => void;
  onMenu: (e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, id: SessionId) => void;
  /** Wall clock (ticks once a second while Mission Control is open and the window visible). */
  now: number;
  /** Current mission task owned by this session (first "doing", else first "todo"). */
  task?: string | null;
  taskState?: TaskState | null;
  /** The workspace has a mission board: the task row is shown (a placeholder when nothing is owned). */
  board?: boolean;
  /** CPU / RAM are sampled (status bar diagnostics on): the resources row is shown. */
  diag?: boolean;
  /** A dragged card would land on this side of this card (insertion bar). */
  dropSide?: DropSide | null;
}) {
  const meta = useApp(
    useShallow((s) => {
      const m = s.persisted.sessions.find((x) => x.id === id);
      return m
        ? {
            name: m.name,
            agent: m.agent,
            role: m.role ?? null,
            profileId: m.profileId,
            resume: m.resumeOnRestore,
            branch: m.worktree ? (m.worktree.branch ?? basename(m.worktree.path)) : null,
            cwd: m.cwd,
          }
        : null;
    }),
  );
  // Account: looked up in every agent's accounts (and the Claude profile list); "Default" only without an id.
  const account = useApp(
    useShallow((s) => {
      const r = resolveAccountName(meta?.agent, meta?.profileId, s.accounts, s.profiles);
      if (!r) return null;
      const color = meta?.profileId ? s.accounts.find((x) => x.id === meta.profileId)?.color ?? s.profiles.find((x) => x.id === meta.profileId)?.color : undefined;
      return { name: r.name ?? "account …", color: color ?? null, isDefault: !meta?.profileId };
    }),
  );
  const rt = useApp((s) => s.runtime[id]);
  const testPath = useApp((s) => evidencePath(s.persisted.sessions.find((x) => x.id === id)));
  const a = useAttention((s) => s.sessions[id]);
  const rate = useRates((s) => latestRate(s.hist[id]));
  const stats = useUi((s) => s.diag?.sessions.find((x) => x.id === id)?.stats);
  const cores = useUi((s) => s.diag?.logicalCores ?? 1);
  const tail = useMissionTails((s) => s.tails[id]);
  const muted = useSessionMuted(id);
  const renameSeq = useRenameRequest(renameSeqFor(id, "mission"));
  const [editing, setEditing] = useState(false);
  /** A mission task from the board hovers this card: dropping assigns it here. */
  const [assignHover, setAssignHover] = useState(false);
  const renameDone = useRef(false);
  // Both change only when a drag begins / ends (never per dragover).
  const taskDragging = useMcDragKind((s) => s.kind === "task");
  const dragging = useMcDragKind((s) => s.sessionId === id);

  useEffect(() => {
    if (!taskDragging) setAssignHover(false);
  }, [taskDragging]);

  useEffect(() => {
    if (!renameSeq) return;
    clearRenameRequest();
    renameDone.current = false;
    setEditing(true);
  }, [renameSeq]);

  if (!meta) return null;

  const st = sessionStatus(rt, a);
  const exitCode = rt?.state.state === "exited" ? rt.state.code : null;
  const label = st.lamp === "exited" && exitCode !== null ? `exit ${exitCode}` : LAMP_TEXT[st.lamp];
  // Live: how long it has been in this state (since its last attention change, at most since the start);
  // the uptime goes in the tooltip. Stopped: how long it ran.
  const started = rt?.startedAt ? Date.parse(rt.startedAt) : Number.NaN;
  let since = "";
  let sinceTitle = "";
  if (st.live && !Number.isNaN(started)) {
    since = formatSince(now - (a && a.at >= started ? a.at : started));
    sinceTitle = `${label} for ${since} · running for ${formatSince(now - started)}`;
  } else if (!st.live && rt?.startedAt) {
    const ran = formatUptime(rt.startedAt, rt.endedAt, now);
    since = ran ? `ran ${ran}` : "";
    sinceTitle = rt.endedAt ? `Ran for ${ran}, until ${formatTime(rt.endedAt)}` : "";
  }
  const cls = [
    "mc-card",
    st.live ? "is-live" : "",
    st.needs ? "is-needs" : "",
    st.lamp === "error" ? "is-error" : "",
    selected ? "is-selected" : "",
    dragging ? "is-dragging" : "",
    taskDragging ? "is-assignable" : "",
    assignHover ? "is-assign-target" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const title = [meta.name, a?.lastMessage, meta.branch ? `worktree ${meta.branch}` : meta.cwd].filter(Boolean).join("\n");
  const conv = meta.agent === "claude" || meta.agent === "codex";

  /** Toolbar button: never jumps (the card's own click does). */
  const act = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  const commit = (value: string) => {
    if (renameDone.current) return;
    renameDone.current = true;
    setEditing(false);
    renameSession(id, value);
  };

  // Card drag (to another lane / the lead box / a new lane); the drop targets live in MissionControl.
  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    const loc = findGroupOf(id);
    if (editing || !loc) {
      e.preventDefault();
      return;
    }
    beginSessionDrag({ sessionId: id, fromGroupId: loc.group.id });
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(SESSION_MIME, id);
  };
  // Task drop target (contract with the mission board: it begins/ends the task drag in mcDrag.ts).
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!currentTaskDrag() || !dragHas(e, TASK_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    if (!assignHover) setAssignHover(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (assignHover && !e.currentTarget.contains(e.relatedTarget as Node | null)) setAssignHover(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const t = currentTaskDrag();
    if (!t || !dragHas(e, TASK_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    setAssignHover(false);
    endTaskDrag();
    assignTaskToSession(id, t.line, t.text).catch((err: unknown) => notify("error", `Could not assign the task: ${err instanceof Error ? err.message : String(err)}`));
  };

  return (
    <div
      data-card={id}
      role="button"
      tabIndex={selected ? 0 : -1}
      aria-label={`${meta.name}: ${label}`}
      aria-haspopup="menu"
      title={editing ? undefined : title}
      className={cls}
      style={roleStyle(meta.role)}
      data-drop={dropSide ?? undefined}
      data-assign-label={assignHover ? `assign → ${meta.name}` : undefined}
      draggable={!editing}
      onDragStart={onDragStart}
      onDragEnd={endSessionDrag}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => !editing && onJump(id)}
      onFocus={() => onSelect(id)}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("input")) return;
        onSelect(id);
        onMenu(e, id);
      }}
    >
      <div className="mc-card-row">
        <span className={`attn-lamp attn-lamp--${st.lamp}`} />
        <span className="mc-card-glyph">
          <AgentGlyph agent={meta.agent} size={11} />
        </span>
        {editing ? (
          <input
            className="mc-card-rename"
            defaultValue={meta.name}
            autoFocus
            spellCheck={false}
            aria-label="Session name"
            onFocus={(e) => e.currentTarget.select()}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => commit(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commit(e.currentTarget.value);
              else if (e.key === "Escape") {
                renameDone.current = true;
                setEditing(false);
                (e.currentTarget.closest("[data-card]") as HTMLElement | null)?.focus();
              }
            }}
          />
        ) : (
          <span className="mc-card-name">{meta.name}</span>
        )}
        {muted && (
          <span className="mc-card-muted" title="Notifications muted">
            <IconBellOff size={10} />
          </span>
        )}
        <RoleTag role={meta.role} />
      </div>
      <div className="mc-card-row mc-card-meta">
        <span className={`is-${st.lamp}`}>{label}</span>
        {since && <span title={sinceTitle || undefined}>· {since}</span>}
        {account && (
          <span className="mc-account" title={account.isDefault ? "Default account" : `Account: ${account.name}`}>
            <span className="mc-sep">·</span>
            {account.color && <span className="mc-account-dot" style={{ background: account.color }} />}
            <span className="mc-ellipsis">{account.name}</span>
          </span>
        )}
        {meta.branch && (
          <span className="mc-card-branch" title={`Worktree branch ${meta.branch}`}>
            <span className="mc-sep">· ⎇</span>
            <span className="mc-ellipsis">{meta.branch}</span>
          </span>
        )}
        <TestBadge path={testPath} now={now} />
      </div>
      {task ? (
        <div className={`mc-card-task is-${taskState ?? "todo"}`} title={`Mission task (${taskState === "doing" ? "doing" : "next"}): ${task}`}>
          <span className="mc-card-task-box">{taskState === "doing" ? "[~]" : "[ ]"}</span>
          <span className="mc-card-task-text">{task}</span>
        </div>
      ) : (
        board && (
          <div className="mc-card-task is-none" title="No open task on the mission board names this session (or its role)">
            <span className="mc-card-task-box">[ ]</span>
            <span className="mc-card-task-text">no task on the board</span>
          </div>
        )
      )}
      <div className={`mc-card-tail${tail ? "" : " is-empty"}`} title={tail || undefined}>
        {tail || (st.live ? "…" : "no output yet")}
      </div>
      {st.needs ? (
        <button
          type="button"
          tabIndex={-1}
          className="mc-cta"
          title={a?.lastMessage ?? "Waiting for you"}
          onMouseDown={(e) => e.preventDefault()}
          onClick={act(() => onJump(id))}
        >
          <span className="mc-cta-msg">{a?.lastMessage ?? "Waiting for you"}</span>
          <span className="mc-cta-go">Answer →</span>
        </button>
      ) : (
        <div className="mc-card-row mc-card-rate">
          <Sparkline id={id} />
          <span className="mc-out" title="Terminal output rate (bytes of PTY output, not tokens)">
            out {st.live ? formatRate(rate) : "—"}
          </span>
        </div>
      )}
      <MeterCardLine sessionId={id} />
      {diag && (
        <div className="mc-card-row mc-res" title="CPU (share of all cores) · RAM of the process tree">
          {st.live && stats ? `cpu ${formatCpu(taskManagerCpu(stats.cpuPercent, cores))} · ram ${formatMb(stats.memoryBytes)}` : st.live ? "cpu … · ram …" : "cpu — · ram —"}
        </div>
      )}
      {/* mousedown keeps focus on the card, so arrow / letter keys keep working after a toolbar click */}
      <div className="mc-card-tools" role="toolbar" aria-label={`${meta.name} actions`} onMouseDown={(e) => e.preventDefault()}>
        <button type="button" tabIndex={-1} title="Jump to pane (Enter)" aria-label="Jump to pane" onClick={act(() => onJump(id))}>
          <IconExternal size={11} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          title={st.live ? (conv ? "Restart, resuming the conversation (R)" : "Restart (R)") : "Restart (R)"}
          aria-label="Restart"
          disabled={!rt}
          onClick={act(() => void confirmRestart(id, meta.name, { mode: "continue" }, st.live))}
        >
          <IconRestart size={11} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          title={st.live ? "Stop (S)" : "Start (S)"}
          aria-label={st.live ? "Stop" : "Start"}
          onClick={act(() => void (st.live ? confirmStop(id, meta.name) : startSession(id, conv ? meta.resume : { mode: "none" })))}
        >
          {st.live ? <IconStop size={11} /> : <IconPlay size={11} />}
        </button>
        <button type="button" tabIndex={-1} title="Run tests in its worktree (the log opens from the badge)" aria-label="Run tests" disabled={!testPath} onClick={act(() => void runTestsForSession(id))}>
          <IconFlask size={11} />
        </button>
        <button
          type="button"
          tabIndex={-1}
          title={muted ? "Unmute notifications" : "Mute notifications"}
          aria-label={muted ? "Unmute notifications" : "Mute notifications"}
          aria-pressed={muted}
          onClick={act(() => toggleSessionMute(id))}
        >
          {muted ? <IconBellOff size={11} /> : <IconBell size={11} />}
        </button>
        <button type="button" tabIndex={-1} className="is-danger" title={st.live ? "Close (stops the process)" : "Close"} aria-label="Close session" onClick={act(() => void confirmCloseSession(id))}>
          <IconClose size={11} />
        </button>
      </div>
    </div>
  );
});
