// Mission Control: a full-window team view of the ACTIVE workspace in a terminal / box-drawing style.
// Lead node(s) on top, one lane per group (a group is a phase / team), a SIGN-OFF node listing sessions
// that wait for review, connector lines, an activity river, the session log and a status line.
// Every number shown is real: process state, exit codes, attention state, PTY output bytes/s (sampled
// once per second ONLY while this overlay is open), CPU/RAM from the shared diagnostics poll.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { jumpToSession } from "../../actions/commands";
import { ipc } from "../../lib/ipc";
import { BUILTIN_ROLES, roleInfo } from "../../lib/roles";
import type { GitInfo, SessionId } from "../../lib/types";
import { selectActiveWorkspace, useApp } from "../../store/appStore";
import { useAttention } from "../../store/attention";
import { useMission } from "../../store/mission";
import { acquireRateSampler, formatRate, latestRate, useRates } from "../../store/rates";
import { isTopModal, popModal, pushModal, useUi } from "../../store/uiStore";
import { useDiagnosticsPoll } from "../hooks";
import { ActivityRiver } from "./ActivityRiver";
import { deriveMission, LAMP_TEXT, laneProgress, phaseMark, sessionStatus, type LaneModel } from "./derive";
import { Links, type LinkSpec } from "./Links";
import { roleStyle } from "./RoleTag";
import { SessionCard } from "./SessionCard";
import { SessionLog } from "./SessionLog";
import { processSessionIds } from "../../lib/browserPanes";
import "../../styles/attention.css";
import "../../styles/mission.css";

const SEP = "\u0000";

interface GroupRow {
  id: string;
  name: string;
  sessionIds: SessionId[];
}

export function MissionControl() {
  const close = useCallback(() => useMission.getState().toggle(false), []);
  const panel = useRef<HTMLDivElement>(null);
  const modalId = useRef(0);

  const wsName = useApp((s) => selectActiveWorkspace(s)?.name ?? "");
  const projectDir = useApp((s) => selectActiveWorkspace(s)?.projectDir ?? null);
  // Structure + roles as primitive strings: re-derives only on layout / role edits, not on output churn.
  const structure = useApp(
    useShallow((s) => {
      const ws = selectActiveWorkspace(s);
      if (!ws) return [] as string[];
      const roles = new Map(s.persisted.sessions.map((m) => [m.id, m.role ?? ""]));
      // Team members are processes: browser panes are not part of the team view.
      const metas = new Map(s.persisted.sessions.map((m) => [m.id, m]));
      return ws.groups.map(
        (g) => `${g.id}${SEP}${g.name}${SEP}${processSessionIds(g.sessionIds, metas).map((id) => `${id}=${roles.get(id) ?? ""}`).join(",")}`,
      );
    }),
  );
  const runtime = useApp((s) => s.runtime);
  const attn = useAttention((s) => s.sessions);
  const diagOn = useApp((s) => s.persisted.settings.statusBarDiagnostics);
  const stillSetting = useApp((s) => (s.persisted.settings as { reduceMotion?: boolean }).reduceMotion === true);
  const prefersReduced = useMemo(() => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches, []);
  const still = stillSetting || prefersReduced;
  const sampledAt = useRates((s) => s.sampledAt);

  // Output-rate sampling and the shared diagnostics poll run only while Mission Control is open.
  useEffect(() => acquireRateSampler(), []);
  useDiagnosticsPoll(diagOn);

  const { groups, roles } = useMemo(() => {
    const roles: Record<SessionId, string | null> = {};
    const groups: GroupRow[] = structure.map((row) => {
      const [id, name, list] = row.split(SEP);
      const sessionIds: SessionId[] = [];
      for (const pair of list ? list.split(",") : []) {
        const eq = pair.indexOf("=");
        const sid = pair.slice(0, eq);
        sessionIds.push(sid);
        roles[sid] = pair.slice(eq + 1) || null;
      }
      return { id, name, sessionIds };
    });
    return { groups, roles };
  }, [structure]);

  const model = useMemo(
    () => deriveMission(groups, (id) => roles[id], (id) => sessionStatus(runtime[id], attn[id])),
    [groups, roles, runtime, attn],
  );
  const allIds = useMemo(() => groups.flatMap((g) => g.sessionIds), [groups]);
  const wsIdSet = useMemo(() => new Set(allIds), [allIds]);
  const flat = useMemo(() => [...model.leads, ...model.lanes.flatMap((l) => l.ids)], [model]);
  const rolesPresent = useMemo(() => {
    const set = new Set(Object.values(roles).filter((r): r is string => !!r));
    const builtins = BUILTIN_ROLES.filter((r) => set.has(r));
    return [...builtins, ...[...set].filter((r) => !(BUILTIN_ROLES as readonly string[]).includes(r)).sort()];
  }, [roles]);
  const riverSessions = useMemo(() => flat.map((id) => ({ id, role: roles[id] ?? null })), [flat, roles]);

  // Git branch: once per open (and when the folder changes). No polling.
  const [git, setGit] = useState<GitInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    setGit(null);
    if (projectDir)
      ipc
        .gitInfo(projectDir)
        .then((g) => !cancelled && setGit(g))
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  // Status line: total output rate of live sessions in this workspace.
  const outTotal = useRates((s) => {
    let sum = 0;
    let any = false;
    for (const id of allIds) {
      const r = latestRate(s.hist[id]);
      if (r !== null) {
        sum += r;
        any = true;
      }
    }
    return any ? sum : null;
  });

  // ---- modal semantics + keyboard ------------------------------------------------------------
  const [selected, setSelected] = useState<SessionId | null>(() => useApp.getState().focusedSessionId);
  useLayoutEffect(() => {
    modalId.current = pushModal();
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const id = modalId.current;
    return () => {
      popModal(id);
      if (prev?.isConnected && !useUi.getState().dialog) requestAnimationFrame(() => prev.focus());
    };
  }, []);
  useEffect(() => {
    if (flat.length && (!selected || !flat.includes(selected))) setSelected(flat[0]);
  }, [flat, selected]);
  useEffect(() => {
    if (!selected) return;
    const el = panel.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(selected)}"]`);
    if (el && document.activeElement !== el && panel.current?.contains(document.activeElement)) el.focus({ preventScroll: false });
  }, [selected]);

  const jump = useCallback(
    (id: SessionId) => {
      close();
      jumpToSession(id);
    },
    [close],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Ignore keys from dialogs stacked above (formation dialog / confirms) and from form controls.
    if (!isTopModal(modalId.current) || !panel.current?.contains(e.target as Node)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "SELECT" || tag === "INPUT" || tag === "BUTTON") return;
    if (!flat.length) return;
    const i = selected ? flat.indexOf(selected) : -1;
    if (e.key === "Enter" && selected) {
      e.preventDefault();
      jump(selected);
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setSelected(flat[e.key === "ArrowRight" ? Math.min(flat.length - 1, i + 1) : Math.max(0, i - 1)]);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSelected(verticalNeighbor(panel.current, selected, flat, e.key === "ArrowDown") ?? selected);
    } else if (e.key === "Home") {
      e.preventDefault();
      setSelected(flat[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      setSelected(flat[flat.length - 1]);
    }
  };

  // ---- connectors ------------------------------------------------------------------------------
  const linkKey = model.lanes.map((l) => `${l.groupId}:${l.state}:${l.done}:${l.needs}`).join("|") + `|${model.signoff.length}|${model.leads.length}`;
  const links = useMemo<LinkSpec[]>(() => {
    const out: LinkSpec[] = [];
    for (const l of model.lanes) {
      out.push({ key: `in:${l.groupId}`, from: "lead", to: `lane:${l.groupId}`, cls: l.needs ? "is-needs" : l.working ? "is-active" : "" });
      const ready = l.ids.some((id) => model.signoff.includes(id));
      out.push({ key: `out:${l.groupId}`, from: `lane:${l.groupId}`, to: "signoff", cls: l.needs ? "is-needs" : ready ? "is-review" : "" });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkKey]);

  const now = sampledAt ?? Date.now();
  const total = model.counts.total;

  return createPortal(
    <div className="mc-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={panel}
        className={`mc${still ? " is-still" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Mission Control"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="mc-head">
          <span className="mc-title">
            <span className="mc-title-glyph">◆</span> mission control
          </span>
          <div className="mc-head-meta">
            <span className="mc-strong">{wsName || "no workspace"}</span>
            {projectDir && (
              <span className="mc-path" title={projectDir}>
                {projectDir}
              </span>
            )}
            {git?.isRepo && (
              <span className="mc-branch" title={git.root ?? ""}>
                ⎇ {git.branch ?? "detached"}
                {git.dirty ? " *" : ""}
                {git.worktrees.length > 1 ? ` · ${git.worktrees.length} worktrees` : ""}
              </span>
            )}
          </div>
          {rolesPresent.length > 0 && (
            <span className="mc-legend" aria-label="Roles present">
              {rolesPresent.map((r) => (
                <span key={r} className="mc-legend-item" style={roleStyle(r)}>
                  <span className="mc-legend-sq" />
                  {roleInfo(r)?.id}
                </span>
              ))}
            </span>
          )}
          <span className="mc-bracket">
            agents [ <b>{model.counts.live}</b>/<b>{total}</b> ]
          </span>
          <span className="mc-head-actions">
            <button type="button" className="mc-btn is-primary" onClick={() => useMission.getState().openFormation()}>
              launch formation…
            </button>
            <button type="button" className="mc-btn" aria-label="Close" title="Close (Esc)" onClick={close}>
              esc ✕
            </button>
          </span>
        </header>

        <div className="mc-scroll">
          <div className="mc-canvas">
            <Links links={links} version={`${structure.join("|")}|${linkKey}`} />
            {total === 0 ? (
              <EmptyMission />
            ) : (
              <>
                <div className="mc-row">
                  <LeadNode leads={model.leads} lanes={model.lanes} allIds={allIds} selected={selected} onSelect={setSelected} onJump={jump} now={now} />
                </div>
                <div className="mc-lanes">
                  {model.lanes.map((l, i) => (
                    <LaneNode key={l.groupId} lane={l} index={i + 1} selected={selected} onSelect={setSelected} onJump={jump} now={now} />
                  ))}
                </div>
                <div className="mc-row">
                  <SignoffNode ids={model.signoff} onJump={jump} />
                </div>
              </>
            )}
          </div>
        </div>

        <ActivityRiver sessions={riverSessions} still={still} />
        <SessionLog workspaceIds={wsIdSet} />

        <footer className="mc-status" aria-label="Status">
          <span>
            workspace [ <b>{wsName || "—"}</b> ]
          </span>
          <span>
            agents [ <b>{model.counts.live}</b>/<b>{total}</b> ]
          </span>
          <span className="is-working">
            working [ <b>{model.counts.working}</b> ]
          </span>
          <span className={model.counts.needs ? "is-needs" : ""}>
            needs-you [ <b>{model.counts.needs}</b> ]
          </span>
          <span title="Terminal output of this workspace's sessions (PTY bytes, not tokens)">
            out [ <b>{formatRate(outTotal)}</b> ]
          </span>
          <span className="mc-spacer" />
          <span>←↑↓→ select · enter jump · esc close</span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

// ---- nodes -------------------------------------------------------------------------------------

interface CardProps {
  selected: SessionId | null;
  onSelect: (id: SessionId) => void;
  onJump: (id: SessionId) => void;
  now: number;
}

function LeadNode({ leads, lanes, allIds, selected, onSelect, onJump, now }: CardProps & { leads: SessionId[]; lanes: LaneModel[]; allIds: SessionId[] }) {
  const phases = lanes.length > 0 && (
    <div className="mc-lead-phases mc-micro" aria-label="Workflow phases">
      <span>workflow</span>
      {lanes.map((l, i) => {
        const mark = phaseMark(l);
        const cls = mark === "✓" ? "is-done" : mark === "!" ? "is-needs" : mark === "●" ? "is-active" : "";
        return (
          <span key={l.groupId} className={`mc-phase ${cls}`}>
            {i > 0 && <span className="mc-bracket">→ </span>}
            <span className="mc-phase-mark">{mark}</span>
            {l.name}
          </span>
        );
      })}
    </div>
  );
  if (leads.length === 0)
    return (
      <div data-node="lead" className="mc-node mc-lead is-placeholder">
        <span className="mc-node-label">lead · orchestrator</span>
        {phases}
        <div>no lead — assign a role</div>
        <AssignLead ids={allIds} />
      </div>
    );
  return (
    <div data-node="lead" className="mc-node mc-lead is-solid">
      <span className="mc-node-label">lead · orchestrator</span>
      <span className="mc-node-label mc-node-label-right">{leads.length === 1 ? "1 lead" : `${leads.length} leads`}</span>
      {phases}
      <div className="mc-cards">
        {leads.map((id) => (
          <SessionCard key={id} id={id} selected={id === selected} onSelect={onSelect} onJump={onJump} now={now} />
        ))}
      </div>
    </div>
  );
}

function AssignLead({ ids }: { ids: SessionId[] }) {
  const options = useApp(useShallow((s) => ids.map((id) => `${id}${SEP}${s.persisted.sessions.find((m) => m.id === id)?.name ?? id}`)));
  if (!options.length) return null;
  return (
    <label className="mc-assign">
      <span className="mc-micro">make lead</span>
      <select
        value=""
        aria-label="Assign the lead role to a session"
        onChange={(e) => e.target.value && useApp.getState().updateSessionMeta(e.target.value, { role: "lead" })}
      >
        <option value="">choose a session…</option>
        {options.map((o) => {
          const [id, name] = o.split(SEP);
          return (
            <option key={id} value={id}>
              {name}
            </option>
          );
        })}
      </select>
    </label>
  );
}

function LaneNode({ lane, index, selected, onSelect, onJump, now }: CardProps & { lane: LaneModel; index: number }) {
  const progress = laneProgress(lane);
  const cls = ["mc-node", lane.live > 0 ? "is-solid" : "", lane.needs > 0 ? "is-needs" : "", lane.total >= 7 ? "is-wide" : ""].filter(Boolean).join(" ");
  return (
    <div data-node={`lane:${lane.groupId}`} className={cls}>
      <span className="mc-node-label">
        lane {index} · {lane.name}
      </span>
      <span className="mc-node-label mc-node-label-right">{lane.total === 1 ? "1 agent" : `${lane.total} agents`}</span>
      {progress ? (
        <div className="mc-lane-head mc-micro">
          <span className="mc-progress" role="progressbar" aria-valuemin={0} aria-valuemax={lane.total} aria-valuenow={lane.done} aria-label={progress.label}>
            <span style={{ width: `${Math.round(progress.fraction * 100)}%` } as CSSProperties} />
          </span>
          <span>{progress.label}</span>
          <span className="mc-lane-stats">
            {lane.working > 0 && <span className="is-working">{lane.working} working</span>}
            {lane.needs > 0 && <span className="is-needs">{lane.needs} need you</span>}
            {lane.errors > 0 && <span className="is-err">{lane.errors} error</span>}
          </span>
        </div>
      ) : (
        <div className="mc-empty">empty group — add sessions or launch a formation</div>
      )}
      <div className="mc-cards">
        {lane.ids.map((id) => (
          <SessionCard key={id} id={id} selected={id === selected} onSelect={onSelect} onJump={onJump} now={now} />
        ))}
      </div>
    </div>
  );
}

function SignoffNode({ ids, onJump }: { ids: SessionId[]; onJump: (id: SessionId) => void }) {
  return (
    <div data-node="signoff" className={`mc-node mc-signoff${ids.length ? " is-solid" : ""}`}>
      <span className="mc-node-label">sign-off · ready for review</span>
      <span className="mc-node-label mc-node-label-right">{ids.length} waiting / done</span>
      {ids.length === 0 ? (
        <div className="mc-empty">nothing waiting for review — sessions appear here when they finish or ask for you</div>
      ) : (
        <div className="mc-signoff-list">
          {ids.map((id) => (
            <SignoffChip key={id} id={id} onJump={onJump} />
          ))}
        </div>
      )}
    </div>
  );
}

function SignoffChip({ id, onJump }: { id: SessionId; onJump: (id: SessionId) => void }) {
  const meta = useApp(useShallow((s) => {
    const m = s.persisted.sessions.find((x) => x.id === id);
    return m ? { name: m.name, role: m.role ?? null } : null;
  }));
  const rt = useApp((s) => s.runtime[id]);
  const a = useAttention((s) => s.sessions[id]);
  if (!meta) return null;
  const st = sessionStatus(rt, a);
  return (
    <button
      type="button"
      className={`mc-chip is-${st.lamp}`}
      style={roleStyle(meta.role)}
      title={a?.lastMessage ?? LAMP_TEXT[st.lamp]}
      onClick={() => onJump(id)}
    >
      <span className="mc-chip-sq" />
      {meta.name}
      <span className="mc-bracket">[ {st.lamp === "waiting" ? "needs you" : "done"} ]</span>
    </button>
  );
}

function EmptyMission() {
  return (
    <div className="mc-row">
      <div data-node="lead" className="mc-node mc-lead is-placeholder">
        <span className="mc-node-label">mission</span>
        <div>No agents in this workspace yet.</div>
        <div style={{ marginTop: 10 }}>
          <button type="button" className="mc-btn is-primary" onClick={() => useMission.getState().openFormation()}>
            launch formation…
          </button>
        </div>
      </div>
    </div>
  );
}

/** Card directly below / above (closest horizontal centre in the next row). */
function verticalNeighbor(root: HTMLElement | null, current: SessionId | null, flat: SessionId[], down: boolean): SessionId | null {
  if (!root || !current) return flat[0] ?? null;
  const rect = (id: SessionId) => root.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`)?.getBoundingClientRect();
  const cur = rect(current);
  if (!cur) return null;
  const cx = cur.left + cur.width / 2;
  let best: { id: SessionId; dy: number; dx: number } | null = null;
  for (const id of flat) {
    const r = rect(id);
    if (!r || id === current) continue;
    const dy = down ? r.top - cur.bottom : cur.top - r.bottom;
    if (dy < -2) continue;
    const dx = Math.abs(r.left + r.width / 2 - cx);
    if (!best || dy < best.dy - 4 || (Math.abs(dy - best.dy) <= 4 && dx < best.dx)) best = { id, dy, dx };
  }
  return best?.id ?? null;
}
