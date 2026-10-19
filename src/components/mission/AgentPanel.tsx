// Agent panel (Mission Control's inspector): the selected agent's name, role, agent and account label (never an
// e-mail), state and time in it, the mission tasks it owns (click a box to change the state), branch evidence
// (the sign-off summary cache), cost / context when the meter has data, CPU / RAM, the last ~30 lines of its
// terminal (read-only, re-read when the agent does something: activity events and the cards' existing tail
// refresh, never a timer of its own) and actions. Resizable from its left edge, collapsible to a rail; the
// width and open state are remembered on this device.

import { memo, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { getCommand, focusSession, runCommand } from "../../actions/commands";
import { messageSessions } from "../../actions/groupActions";
import { evidencePath, handoffMenuItems, handoffTargetCount, pathKey, refreshBranchSummary, useBranchSummaries } from "../../actions/handoff";
import { startSession } from "../../actions/sessions";
import { ipc } from "../../lib/ipc";
import { cardLine, hasData, meterTooltip } from "../../lib/meter";
import { ownsTask, type Task, type TeamMember } from "../../lib/missionDoc";
import type { SessionId } from "../../lib/types";
import { AgentGlyph } from "../../layout/icons";
import { isLive, useApp } from "../../store/appStore";
import { resolveAccountName, useActivity } from "../../store/activity";
import { useAttention } from "../../store/attention";
import { useMeter } from "../../store/meter";
import { clampPanelWidth, useDeck } from "../../store/missionDeck";
import { formatRate, latestRate, useRates } from "../../store/rates";
import { useUi } from "../../store/uiStore";
import { confirmRestart, confirmStop } from "../menus/sessionMenu";
import { useContextMenu } from "../ui/Menu";
import { formatUptime, tailLines } from "../util/fleet";
import { basename, formatCpu, formatMb, formatSince, taskManagerCpu } from "../util/text";
import { LAMP_TEXT, sessionStatus } from "./derive";
import { findTestAction, useMcExtensions } from "./mcExtensions";
import { IcPanel, IcPin, IcSpot } from "./mcIcons";
import { T } from "./mcText";
import { RoleTag, roleStyle } from "./RoleTag";
import { summaryParts } from "./signoffModel";
import { BOX, cycleTask, STATE_WORD } from "./taskOps";
import { useMissionTails } from "./useOutputTails";

const TAIL_BYTES = 12 * 1024;
const TAIL_LINES = 30;

/** "a.b@example.com" → "a.b@…": the panel never shows an e-mail address. */
export function noEmail(s: string): string {
  return s.replace(/([^\s@()<>]+)@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "$1@…");
}

export interface AgentPanelProps {
  id: SessionId | null;
  open: boolean;
  /** Docked beside the view (board / timeline / list) or floating over the graph canvas. */
  overlay: boolean;
  projectDir: string | null;
  tasks: Task[];
  team: TeamMember[];
  board: boolean;
  lane: string | null;
  now: number;
  pinned: boolean;
  spotlit: boolean;
  onJump: (id: SessionId) => void;
  onPin: (id: SessionId) => void;
  onSpotlight: (id: SessionId) => void;
  onOpen: (open: boolean) => void;
}

export const AgentPanel = memo(function AgentPanel(p: AgentPanelProps) {
  const width = useDeck((s) => s.panelWidth);
  const setDeck = useDeck((s) => s.set);
  const [dragW, setDragW] = useState<number | null>(null);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const w = dragW ?? width;

  if (!p.open)
    return (
      <button type="button" className={`mc-panel-rail${p.overlay ? " is-overlay" : ""}`} title={T.panel.open} aria-label={T.panel.open} onClick={() => p.onOpen(true)}>
        <IcPanel size={12} />
        <span className="mc-panel-rail-text">{T.panel.label}</span>
      </button>
    );

  const onDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, w };
    setDragW(w);
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) setDragW(clampPanelWidth(d.w + (d.x - e.clientX)));
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    if (dragW !== null) setDeck({ panelWidth: dragW });
    setDragW(null);
  };

  return (
    <aside className={`mc-panel${p.overlay ? " is-overlay" : ""}`} style={{ width: w }} aria-label={T.panel.label} onPointerDown={(e) => e.stopPropagation()}>
      <div
        className={`mc-panel-resize${dragW !== null ? " is-dragging" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={T.panel.resize}
        aria-valuenow={w}
        tabIndex={0}
        title={T.panel.resize}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={(e) => {
          if (e.key === "Escape") return;
          e.stopPropagation();
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          setDeck({ panelWidth: clampPanelWidth(width + (e.key === "ArrowLeft" ? 24 : -24)) });
        }}
      />
      {p.id ? <AgentBody key={p.id} {...p} id={p.id} /> : <div className="mc-panel-none">{T.panel.none}</div>}
      <button type="button" className="mc-panel-x" title={T.panel.close} aria-label={T.panel.close} onClick={() => p.onOpen(false)}>
        ✕
      </button>
    </aside>
  );
});

function AgentBody({ id, projectDir, tasks, team, board, lane, now, pinned, spotlit, onJump, onPin, onSpotlight }: AgentPanelProps & { id: SessionId }) {
  const meta = useApp(
    useShallow((s) => {
      const m = s.persisted.sessions.find((x) => x.id === id);
      return m
        ? { name: m.name, agent: m.agent, role: m.role ?? null, profileId: m.profileId, resume: m.resumeOnRestore, branch: m.worktree ? (m.worktree.branch ?? basename(m.worktree.path)) : null, cwd: m.cwd }
        : null;
    }),
  );
  const path = useApp((s) => evidencePath(s.persisted.sessions.find((x) => x.id === id)));
  const account = useApp((s) => {
    const m = s.persisted.sessions.find((x) => x.id === id);
    return resolveAccountName(m?.agent, m?.profileId, s.accounts, s.profiles)?.name ?? null;
  });
  const targets = useApp((s) => handoffTargetCount(id, s));
  const rt = useApp((s) => s.runtime[id]);
  const a = useAttention((s) => s.sessions[id]);
  const meter = useMeter((s) => s.bySession[id]);
  const rate = useRates((s) => latestRate(s.hist[id]));
  const stats = useUi((s) => s.diag?.sessions.find((x) => x.id === id)?.stats);
  const cores = useUi((s) => s.diag?.logicalCores ?? 1);
  const entry = useBranchSummaries((s) => (path ? s.byPath[pathKey(path)] : undefined));
  const cardActions = useMcExtensions((s) => s.card);
  const menu = useContextMenu();
  const output = useTail(id);

  useEffect(() => {
    if (path) void refreshBranchSummary(path);
  }, [path]);

  if (!meta) return <div className="mc-panel-none">{T.panel.none}</div>;
  const st = sessionStatus(rt, a);
  const exitCode = rt?.state.state === "exited" ? rt.state.code : null;
  const label = st.lamp === "exited" && exitCode !== null ? `exit ${exitCode}` : LAMP_TEXT[st.lamp];
  const started = rt?.startedAt ? Date.parse(rt.startedAt) : Number.NaN;
  const since = st.live && !Number.isNaN(started) ? formatSince(now - (a && a.at >= started ? a.at : started)) : "";
  const uptime = rt?.startedAt ? formatUptime(rt.startedAt, rt.endedAt, now) : "";
  const conv = meta.agent === "claude" || meta.agent === "codex";
  const member = team.find((m) => m.id === id) ?? { id, name: meta.name, role: meta.role };
  const owned = tasks.filter((t) => ownsTask(t, member));
  const parts = summaryParts(entry?.summary, now);
  const tests = findTestAction(cardActions) ?? null;
  const testCmd = !tests ? (getCommand("session.runTests") ?? getCommand("tests.run") ?? null) : null;
  const extra = cardActions.filter((x) => x !== tests && (x.visible?.(id) ?? true));

  return (
    <>
      <header className="mc-panel-head" style={roleStyle(meta.role)}>
        <span className={`attn-lamp attn-lamp--${st.lamp}`} />
        <span className="mc-card-glyph">
          <AgentGlyph agent={meta.agent} size={12} />
        </span>
        <span className="mc-panel-name" title={meta.name}>
          {meta.name}
        </span>
        <RoleTag role={meta.role} />
        <span className="mc-spacer" />
        <button type="button" className={`mc-panel-tool${spotlit ? " is-on" : ""}`} aria-pressed={spotlit} title={spotlit ? T.panel.unspotlight : `${T.panel.spotlight} (.)`} onClick={() => onSpotlight(id)}>
          <IcSpot size={12} />
        </button>
        <button type="button" className={`mc-panel-tool${pinned ? " is-on" : ""}`} aria-pressed={pinned} title={pinned ? T.card.unpin : T.card.pin} onClick={() => onPin(id)}>
          <IcPin size={12} />
        </button>
      </header>
      <div className="mc-panel-body">
        <dl className="mc-panel-facts">
          <dt>{T.panel.state}</dt>
          <dd>
            <span className={`is-${st.lamp}`}>{label}</span>
            {since && <span className="mc-panel-dim"> · {T.panel.inState(since)}</span>}
            {uptime && st.live && <span className="mc-panel-dim"> · {T.panel.running(uptime)}</span>}
          </dd>
          {a?.lastMessage && (
            <>
              <dt />
              <dd className="mc-panel-msg" title={a.lastMessage}>
                {a.lastMessage}
              </dd>
            </>
          )}
          <dt>{T.panel.agent}</dt>
          <dd>
            {meta.agent}
            {lane && <span className="mc-panel-dim"> · {lane}</span>}
          </dd>
          {account && (
            <>
              <dt>{T.panel.account}</dt>
              <dd>{noEmail(account)}</dd>
            </>
          )}
          <dt>{T.panel.cpu}</dt>
          <dd>
            {st.live && stats ? `${formatCpu(taskManagerCpu(stats.cpuPercent, cores))} · ${T.panel.ram} ${formatMb(stats.memoryBytes)}` : "—"}
            {st.live && <span className="mc-panel-dim"> · out {formatRate(rate)}</span>}
          </dd>
          {hasData(meter) && (
            <>
              <dt>{T.panel.usage}</dt>
              <dd title={meterTooltip(meter)}>{cardLine(meter)}</dd>
            </>
          )}
        </dl>

        <section className="mc-panel-sec">
          <h4 className="mc-micro">{T.panel.tasks}</h4>
          {!board ? (
            <div className="mc-panel-dim">{T.panel.noBoard}</div>
          ) : owned.length === 0 ? (
            <div className="mc-panel-dim">{T.panel.noTasks}</div>
          ) : (
            <ul className="mc-panel-tasks">
              {owned.map((t) => (
                <li key={`${t.line}:${t.text}`} className={`is-${t.state}`} data-task-line={t.line}>
                  <button type="button" className="mb-box" title={`${STATE_WORD[t.state]} — click for the next state`} disabled={!projectDir} onClick={() => projectDir && void cycleTask(projectDir, t)}>
                    {BOX[t.state]}
                  </button>
                  <span className="mc-panel-task-text" title={t.text}>
                    {t.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {path && (
          <section className="mc-panel-sec">
            <h4 className="mc-micro">{T.panel.evidence}</h4>
            {!entry ? (
              <div className="mc-panel-dim">⎇ reading git…</div>
            ) : entry.error ? (
              <div className="mc-panel-dim" title={entry.error}>
                git: {entry.error}
              </div>
            ) : parts.length === 0 ? (
              <div className="mc-panel-dim">{T.panel.noRepo}</div>
            ) : (
              <div className="mc-panel-evidence">
                {parts.map((x) => (
                  <span key={x.kind} className={`so-part is-${x.kind}`} title={x.title}>
                    {x.text}
                  </span>
                ))}
              </div>
            )}
          </section>
        )}

        <section className="mc-panel-sec mc-panel-out-sec">
          <h4 className="mc-micro" title={T.panel.outputHint}>
            {T.panel.output}
          </h4>
          <pre className={`mc-panel-out${output.length ? "" : " is-empty"}`} aria-label={T.panel.outputHint}>
            {output.length ? output.join("\n") : T.panel.noOutput}
          </pre>
        </section>
      </div>
      <footer className="mc-panel-actions">
        <button type="button" className="mc-btn is-primary" onClick={() => onJump(id)}>
          {T.panel.jump}
        </button>
        <button type="button" className="mc-btn" disabled={!st.live} onClick={() => messageSessions([id], `“${meta.name}”`)}>
          {T.panel.message}
        </button>
        <button type="button" className="mc-btn" aria-haspopup="menu" disabled={targets === 0} onClick={(e) => menu.openAt(e.currentTarget, handoffMenuItems(id))}>
          {T.panel.handoff}
        </button>
        <button type="button" className="mc-btn" disabled={!rt} onClick={() => void confirmRestart(id, meta.name, { mode: "continue" }, st.live)}>
          {T.panel.restart}
        </button>
        <button type="button" className="mc-btn" onClick={() => void (st.live ? confirmStop(id, meta.name) : startSession(id, conv ? meta.resume : { mode: "none" }))}>
          {st.live ? T.panel.stop : T.panel.start}
        </button>
        {tests && (
          <button type="button" className="mc-btn" title={tests.title} disabled={tests.disabled?.(id) ?? false} onClick={() => void tests.run(id)}>
            {tests.label || T.panel.runTests}
          </button>
        )}
        {testCmd && (
          <button
            type="button"
            className="mc-btn"
            title={testCmd.title}
            onClick={() => {
              focusSession(id);
              runCommand(testCmd.id);
            }}
          >
            {T.panel.runTests}
          </button>
        )}
        {extra.map((x) => (
          <button key={x.id} type="button" className={`mc-btn${x.danger ? " is-danger" : ""}`} title={x.title} disabled={x.disabled?.(id) ?? false} onClick={() => void x.run(id)}>
            {x.label}
          </button>
        ))}
      </footer>
      {menu.element}
    </>
  );
}

/**
 * Last lines of a session's terminal, re-read (debounced) when it changes: its activity events and the cards'
 * existing one-line tail refresh. No timer of its own; a stopped session is read once.
 */
function useTail(id: SessionId): string[] {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      timer = undefined;
      ipc
        .sessionOutputTail(id, TAIL_BYTES)
        .then((text) => {
          if (cancelled) return;
          const next = tailLines(text, TAIL_LINES, 400);
          setLines((prev) => (prev.length === next.length && prev.every((l, i) => l === next[i]) ? prev : next));
        })
        .catch(() => !cancelled && setLines([]));
    };
    const soon = () => {
      if (timer === undefined) timer = setTimeout(read, 250);
    };
    read();
    const offActivity = useActivity.subscribe((s, prev) => {
      if (s.events === prev.events) return;
      const last = s.events[s.events.length - 1];
      if (last?.sessionId === id) soon();
    });
    const offTail = useMissionTails.subscribe((s, prev) => {
      if (s.tails[id] !== prev.tails[id] && isLive(useApp.getState().runtime[id])) soon();
    });
    const offAttn = useAttention.subscribe((s, prev) => {
      if (s.sessions[id] !== prev.sessions[id]) soon();
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      offActivity();
      offTail();
      offAttn();
    };
  }, [id]);
  return lines;
}
