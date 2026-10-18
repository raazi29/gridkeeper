// Mission Control: a full-window team view — and cockpit — of the ACTIVE workspace in a terminal /
// box-drawing style. The shared mission board (goal + tasks from <projectDir>/.gridkeeper/mission.md, watched
// only while open) on top, then the lead node(s), one lane per group (a group is a phase / team), a SIGN-OFF dock
// listing sessions that wait for review, connector lines, an activity river, the session log and a status
// line. Lanes have actions (add session, message, restart, stop, formation); cards have a hover toolbar,
// the shared session context menu and keyboard actions (Enter / R / S / M / Del / F2 / Shift+F10).
// Every number shown is real: process state, exit codes, attention state, PTY output bytes/s (sampled
// once per second ONLY while this overlay is open), CPU/RAM from the shared diagnostics poll.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { confirmCloseSession, deleteGroupFlow, jumpToSession } from "../../actions/commands";
import { messageSessions, restartSessions, restartTargets, stopSessions } from "../../actions/groupActions";
import { closeSession, startSession } from "../../actions/sessions";
import { commandForEvent } from "../../keybindings";
import { ipc } from "../../lib/ipc";
import { countOwned, currentTaskFor, progress, type Task, type TeamMember } from "../../lib/missionDoc";
import { BUILTIN_ROLES, roleInfo } from "../../lib/roles";
import type { GitInfo, SessionId } from "../../lib/types";
import { AgentGlyph } from "../../layout/icons";
import { findGroupOf, isLive, selectActiveGroup, selectActiveWorkspace, useApp } from "../../store/appStore";
import { useAttention } from "../../store/attention";
import { LEAD_BOX, useMission } from "../../store/mission";
import { useMissionFile } from "../../store/missionDoc";
import { acquireRateSampler, formatRate, latestRate, useRates } from "../../store/rates";
import { requestRename } from "../../store/renameRequest";
import { actionToast, confirmDialog, isTopModal, popModal, pushModal, useUi } from "../../store/uiStore";
import { useDiagnosticsPoll } from "../hooks";
import { buildGroupMenu } from "../menus/containerMenus";
import { buildSessionMenu, confirmRestart, confirmStop } from "../menus/sessionMenu";
import { QuickLaunchButton } from "../QuickLaunch";
import { ReplayHeaderControls } from "../replay/ReplayControls";
import { CostMeterHint, WorkspaceCost } from "../MeterChip";
import { useContextMenu, type MenuItem } from "../ui/Menu";
import { ActivityRiver } from "./ActivityRiver";
import type { FleetLamp } from "../util/fleet";
import { deriveMission, insertIndex, laneProgress, nextLaneName, phaseMark, reorderTarget, sessionStatus, sideOf, type DropSide, type LaneModel } from "./derive";
import { LeadControl } from "./LeadControl";
import { Links, type LinkSpec } from "./Links";
import {
  beginLaneDrag,
  currentLaneDrag,
  currentSessionDrag,
  dragHas,
  endAllMcDrags,
  endLaneDrag,
  endSessionDrag,
  LANE_MIME,
  SESSION_MIME,
  useMcDragKind,
} from "./mcDrag";
import { MissionNode } from "./MissionNode";
import { roleStyle } from "./RoleTag";
import { SessionCard } from "./SessionCard";
import { SessionLog } from "./SessionLog";
import { SignoffNode } from "./Signoff";
import { processSessionIds } from "../../lib/browserPanes";
import { useOutputTails } from "./useOutputTails";
import "../../styles/attention.css";
import "../../styles/mission.css";
import "../../styles/mcDrag.css";

const SEP = "\u0000";

const NO_TASKS: Task[] = [];

type MenuEvent = { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void };
type OpenMenu = (e: MenuEvent, items: MenuItem[]) => void;

interface GroupRow {
  id: string;
  name: string;
  sessionIds: SessionId[];
}

function sessionName(id: SessionId): string {
  return useApp.getState().persisted.sessions.find((m) => m.id === id)?.name ?? "session";
}

/** Del on a card: always asks (a stopped session's definition is removed too). */
async function confirmRemove(id: SessionId): Promise<void> {
  if (isLive(useApp.getState().runtime[id])) return confirmCloseSession(id);
  const ok = await confirmDialog({
    title: `Close “${sessionName(id)}”?`,
    message: "Removes the pane and its session definition. The process is not running.",
    confirmLabel: "Close",
    danger: true,
  });
  if (ok) await closeSession(id);
}

// ---- moves (drag & drop and Alt+arrows) ---------------------------------------------------------
// Each returns an announcement for the aria-live region, or null when nothing changed.

type Anchor = { id: SessionId; side: DropSide } | null;
/** A completed move: select / focus the card (when an id is given) and announce `msg`. */
type OnMoved = (id: SessionId | null, msg: string | null) => void;

function metaOf(id: SessionId) {
  return useApp.getState().persisted.sessions.find((m) => m.id === id);
}

/** "“name” → Build, position 2 of 3" (position among the lane's visible cards: no leads, no browser panes). */
function describePlace(id: SessionId): string {
  const loc = findGroupOf(id);
  if (!loc) return `Moved “${sessionName(id)}”`;
  const metas = new Map(useApp.getState().persisted.sessions.map((m) => [m.id, m]));
  const visible = processSessionIds(loc.group.sessionIds, metas).filter((x) => metas.get(x)?.role !== "lead");
  const pos = visible.indexOf(id);
  return pos < 0 ? `Moved “${sessionName(id)}” to ${loc.group.name}` : `Moved “${sessionName(id)}” to ${loc.group.name}, position ${pos + 1} of ${visible.length}`;
}

/**
 * Moves a card into a lane next to `anchor` (null = the end). A lead dropped on a lane leaves the lead
 * box (role cleared); a toast offers Undo (role and position). Same workspace only (store no-op otherwise).
 */
function moveCardToLane(id: SessionId, groupId: string, anchor: Anchor): string | null {
  const app = useApp.getState();
  const loc = findGroupOf(id);
  const target = loc?.workspace.groups.find((g) => g.id === groupId);
  if (!loc || !target) return null;
  const from = { groupId: loc.group.id, index: loc.group.sessionIds.indexOf(id) };
  const wasLead = metaOf(id)?.role === "lead";
  const before = app.persisted;
  app.moveSessionToGroup(id, groupId, insertIndex(target.sessionIds, id, anchor));
  if (wasLead) {
    app.updateSessionMeta(id, { role: null });
    actionToast({
      kind: "info",
      message: `“${sessionName(id)}” is no longer the lead`,
      detail: `moved to ${target.name}`,
      action: {
        label: "Undo",
        run: () => {
          const a = useApp.getState();
          a.updateSessionMeta(id, { role: "lead" });
          a.moveSessionToGroup(id, from.groupId, from.index);
        },
      },
    });
  }
  if (useApp.getState().persisted === before) return null;
  return describePlace(id);
}

/** Drop on the lead box: the session becomes a lead. Replacing another role offers Undo. */
function makeLead(id: SessionId): string | null {
  const m = metaOf(id);
  if (!m || m.role === "lead") return null;
  const old = m.role ?? null;
  useApp.getState().updateSessionMeta(id, { role: "lead" });
  if (old)
    actionToast({
      kind: "info",
      message: `“${m.name}” is now the lead`,
      detail: `was ${old}`,
      action: { label: "Undo", run: () => useApp.getState().updateSessionMeta(id, { role: old }) },
    });
  return `“${m.name}” is now the lead`;
}

/** New empty group "Lane N" at the end. The grid behind Mission Control keeps its active group. */
function createLane(wsId: string | null): string | null {
  const app = useApp.getState();
  const ws = app.persisted.workspaces.find((w) => w.id === wsId);
  if (!ws) return null;
  const prev = ws.activeGroupId;
  const gid = app.createGroup(ws.id, nextLaneName(ws.groups.map((g) => g.name)));
  if (prev) app.setActiveGroup(ws.id, prev); // createGroup activates the new group
  return gid;
}

/** Lane reorder: `dragId` lands before / after `targetId` (indices are group indices, lead-only groups included). */
function moveLane(dragId: string, targetId: string, side: DropSide): string | null {
  if (dragId === targetId) return null;
  const app = useApp.getState();
  const ws = app.persisted.workspaces.find((w) => w.groups.some((g) => g.id === dragId));
  const from = ws?.groups.findIndex((g) => g.id === dragId) ?? -1;
  const anchor = ws?.groups.findIndex((g) => g.id === targetId) ?? -1;
  if (!ws || from < 0 || anchor < 0) return null;
  const before = app.persisted;
  app.moveGroup(ws.id, from, reorderTarget(from, anchor, side));
  if (useApp.getState().persisted === before) return null;
  const after = useApp.getState().persisted.workspaces.find((w) => w.id === ws.id);
  const at = after?.groups.findIndex((g) => g.id === dragId) ?? -1;
  return `Moved lane “${ws.groups[from].name}” to position ${at + 1} of ${ws.groups.length}`;
}

/** Card nearest to the pointer inside a lane (the dragged card excluded) and the side the pointer is on. */
function nearestCard(root: HTMLElement, x: number, y: number, exclude: SessionId): Anchor {
  let best: { id: SessionId; d: number; r: DOMRect } | null = null;
  for (const el of root.querySelectorAll<HTMLElement>(".mc-cards > [data-card]")) {
    const id = el.dataset.card;
    if (!id || id === exclude) continue;
    const r = el.getBoundingClientRect();
    const dx = Math.max(r.left - x, 0, x - r.right);
    const dy = Math.max(r.top - y, 0, y - r.bottom);
    const d = dx * dx + 4 * dy * dy; // prefer the card in the pointer's row
    if (!best || d < best.d) best = { id, d, r };
  }
  return best ? { id: best.id, side: sideOf(x, best.r) } : null;
}

export function MissionControl() {
  const close = useCallback(() => useMission.getState().toggle(false), []);
  const panel = useRef<HTMLDivElement>(null);
  const modalId = useRef(0);
  const menu = useContextMenu();
  const openMenu = menu.open;

  const wsId = useApp((s) => selectActiveWorkspace(s)?.id ?? null);
  const wsName = useApp((s) => selectActiveWorkspace(s)?.name ?? "");
  const projectDir = useApp((s) => selectActiveWorkspace(s)?.projectDir ?? null);
  const activeGroupId = useApp((s) => selectActiveGroup(s)?.id);
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
  const collapsed = useMission((s) => s.collapsed);
  const [renamingLane, setRenamingLane] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");

  // Output-rate sampling, the shared diagnostics poll and card output tails run only while open.
  useEffect(() => acquireRateSampler(), []);
  useDiagnosticsPoll(diagOn);
  useOutputTails(panel);

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
  // Keyboard order: the cards on screen (collapsed boxes hide theirs).
  const flat = useMemo(
    () => [...(collapsed[LEAD_BOX] ? [] : model.leads), ...model.lanes.flatMap((l) => (collapsed[l.groupId] ? [] : l.ids))],
    [model, collapsed],
  );
  const lamps = useMemo(() => {
    const out: Record<SessionId, FleetLamp> = {};
    for (const id of allIds) out[id] = sessionStatus(runtime[id], attn[id]).lamp;
    return out;
  }, [allIds, runtime, attn]);
  const rolesPresent = useMemo(() => {
    const set = new Set(Object.values(roles).filter((r): r is string => !!r));
    const builtins = BUILTIN_ROLES.filter((r) => set.has(r));
    return [...builtins, ...[...set].filter((r) => !(BUILTIN_ROLES as readonly string[]).includes(r)).sort()];
  }, [roles]);
  const riverSessions = useMemo(() => flat.map((id) => ({ id, role: roles[id] ?? null })), [flat, roles]);

  // Mission board: the file is watched + read only while this overlay is open (no polling). Owners are
  // matched by session name slug or role, so the team needs names (primitive strings: no render loops).
  const mission = useMissionFile(projectDir);
  const names = useApp(useShallow((s) => allIds.map((id) => s.persisted.sessions.find((m) => m.id === id)?.name ?? "")));
  const team = useMemo<TeamMember[]>(() => allIds.map((id, i) => ({ id, name: names[i] ?? "", role: roles[id] ?? null })), [allIds, names, roles]);
  const tasks = mission.doc?.tasks ?? NO_TASKS;
  const cardTasks = useMemo(() => {
    const out: Record<SessionId, Task> = {};
    for (const m of team) {
      const t = currentTaskFor(tasks, m);
      if (t) out[m.id] = t;
    }
    return out;
  }, [tasks, team]);
  const taskStats = progress(tasks);

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
  // Focus can end up on <body> (an element under it unmounted, a menu action ran): Esc still closes,
  // other keys bring focus back to the panel.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isTopModal(modalId.current) || panel.current?.contains(document.activeElement)) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else panel.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  useEffect(() => {
    if (flat.length && (!selected || !flat.includes(selected))) setSelected(flat[0]);
  }, [flat, selected]);
  useEffect(() => {
    if (!selected) return;
    const el = panel.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(selected)}"]`);
    // Not from a control: a click on a box's fold button that hid the selected card must not scroll the
    // canvas to the new selection.
    const a = document.activeElement as HTMLElement | null;
    const navigating = !!a && !/^(BUTTON|INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
    if (el && a !== el && navigating && panel.current?.contains(a)) el.focus({ preventScroll: false });
  }, [selected]);

  const jump = useCallback(
    (id: SessionId) => {
      close();
      jumpToSession(id);
    },
    [close],
  );

  /** Owner chip on the mission board: focus (and so select + scroll to) that session's card. */
  const selectCard = useCallback((id: SessionId) => {
    const el = panel.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`);
    if (el) el.focus();
    else setSelected(id);
  }, []);

  // ---- drag & drop / keyboard moves ---------------------------------------------------------------
  /** aria-live announcement (a trailing no-break space makes a repeated message announce again). */
  const say = useCallback((msg: string | null) => {
    if (msg) setAnnounce((a) => (a === msg ? `${msg} ` : msg));
  }, []);
  // A moved card re-mounts (new lane / reordered DOM) and loses focus: select it and focus it again.
  const onMoved = useCallback<OnMoved>(
    (id, msg) => {
      say(msg);
      if (!id || !msg) return;
      setSelected(id);
      requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`)?.focus());
    },
    [say],
  );
  // A dragged card that re-mounted never receives dragend: clear the shared drag state on any drop / end.
  useEffect(() => {
    window.addEventListener("drop", endAllMcDrags);
    window.addEventListener("dragend", endAllMcDrags, true);
    return () => {
      window.removeEventListener("drop", endAllMcDrags);
      window.removeEventListener("dragend", endAllMcDrags, true);
      endAllMcDrags();
    };
  }, []);

  /** Alt+←/→ reorders the selected card in its lane, Alt+↑/↓ moves it to the previous / next lane. */
  const keyboardMoveCard = (id: SessionId, key: string) => {
    const li = model.lanes.findIndex((l) => l.ids.includes(id));
    if (li < 0) {
      say("Leads stay in the lead box. Drag the card onto a lane to move it there.");
      return;
    }
    const lane = model.lanes[li];
    let msg: string | null;
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const left = key === "ArrowLeft";
      const pos = lane.ids.indexOf(id);
      const nb = lane.ids[left ? pos - 1 : pos + 1];
      if (!nb) {
        say(`“${sessionName(id)}” is already ${left ? "first" : "last"} in ${lane.name}`);
        return;
      }
      msg = moveCardToLane(id, lane.groupId, { id: nb, side: left ? "before" : "after" });
    } else {
      const up = key === "ArrowUp";
      const target = model.lanes[up ? li - 1 : li + 1];
      if (!target) {
        say(`No lane ${up ? "before" : "after"} ${lane.name}`);
        return;
      }
      useMission.getState().toggleCollapsed(target.groupId, false);
      msg = moveCardToLane(id, target.groupId, null);
    }
    onMoved(id, msg);
  };

  /** Alt+←/→ on a focused lane box moves the lane past its visible neighbour. */
  const keyboardMoveLane = (groupId: string, left: boolean) => {
    const li = model.lanes.findIndex((l) => l.groupId === groupId);
    const nb = model.lanes[left ? li - 1 : li + 1];
    if (li < 0 || !nb) {
      say(`Lane is already ${left ? "first" : "last"}`);
      return;
    }
    say(moveLane(groupId, nb.groupId, left ? "before" : "after"));
    requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>(`[data-node="lane:${CSS.escape(groupId)}"]`)?.focus());
  };

  const openCardMenu = useCallback(
    (e: MenuEvent, id: SessionId) => openMenu(e, buildSessionMenu(id, { surface: "mission", onNavigate: close })),
    [openMenu, close],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Ignore keys from dialogs stacked above (formation dialog / confirms / menus) and from outside.
    if (!isTopModal(modalId.current) || !panel.current?.contains(e.target as Node)) return;
    if (e.key === "Escape" || commandForEvent(e.nativeEvent) === "view.mission") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA" || tag === "BUTTON") return;
    const arrow = e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown";
    const altOnly = e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    // A lane box itself has focus (click on its empty area): F2 renames it, Alt+←/→ moves it.
    const node = (e.target as HTMLElement).dataset?.node;
    if (node?.startsWith("lane:")) {
      const gid = node.slice(5);
      if (e.key === "F2" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        setRenamingLane(gid);
        return;
      }
      if (altOnly && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        keyboardMoveLane(gid, e.key === "ArrowLeft");
        return;
      }
    }
    if (!flat.length) return;
    const i = selected ? flat.indexOf(selected) : -1;
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    const live = !!selected && isLive(useApp.getState().runtime[selected]);
    const act = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (altOnly && arrow) {
      // preventDefault also stops WebView2's Alt+← "history back".
      e.preventDefault();
      if (selected) keyboardMoveCard(selected, e.key);
    } else if (e.key === "Enter" && selected) act(() => jump(selected));
    else if ((e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) && selected) {
      act(() => {
        const r = panel.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(selected)}"]`)?.getBoundingClientRect();
        openCardMenu({ clientX: (r?.left ?? 40) + 12, clientY: (r?.top ?? 40) + 22 }, selected);
      });
    } else if (plain && selected && (e.key === "r" || e.key === "R") && !e.shiftKey) {
      act(() => {
        if (useApp.getState().runtime[selected]) void confirmRestart(selected, sessionName(selected), { mode: "continue" }, live);
      });
    } else if (plain && selected && (e.key === "s" || e.key === "S") && !e.shiftKey) {
      act(() => {
        if (live) void confirmStop(selected, sessionName(selected));
        else {
          const m = useApp.getState().persisted.sessions.find((x) => x.id === selected);
          const conv = m?.agent === "claude" || m?.agent === "codex";
          void startSession(selected, conv && m ? m.resumeOnRestore : { mode: "none" });
        }
      });
    } else if (plain && selected && (e.key === "m" || e.key === "M") && !e.shiftKey) act(() => messageSessions([selected], `“${sessionName(selected)}”`));
    else if (plain && selected && e.key === "Delete") act(() => void confirmRemove(selected));
    else if (plain && selected && e.key === "F2") act(() => requestRename(selected, "mission"));
    else if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
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
  const linkKey =
    model.lanes.map((l) => `${l.groupId}:${l.state}:${l.done}:${l.needs}`).join("|") +
    `|${model.signoff.length}|${model.leads.length}|m${taskStats.doing}:${taskStats.blocked}`;
  const links = useMemo<LinkSpec[]>(() => {
    const out: LinkSpec[] = [{ key: "mission", from: "mission", to: "lead", cls: taskStats.blocked ? "is-needs" : taskStats.doing ? "is-active" : "" }];
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
  const cardProps = { selected, onSelect: setSelected, onJump: jump, onMenu: openCardMenu, now, tasks: cardTasks, lamps, onMoved };
  const collapsedKey = Object.keys(collapsed).sort().join(",");

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
            <ReplayHeaderControls projectDir={projectDir} />
            <button
              type="button"
              className="mc-btn"
              disabled={model.counts.live === 0}
              title="Type one line to several running sessions (nothing is sent until you press Send)"
              onClick={() => messageSessions(allIds, "this workspace")}
            >
              message all…
            </button>
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
            <Links links={links} version={`${structure.join("|")}|${linkKey}|${collapsedKey}`} />
            <div className="mc-row">
              <MissionNode workspaceId={wsId} projectDir={projectDir} mission={mission} team={team} onSelectSession={selectCard} openMenu={openMenu} selectedSessionId={selected} />
            </div>
            {total === 0 ? (
              <EmptyMission groupId={activeGroupId} />
            ) : (
              <>
                <div className="mc-row">
                  <LeadNode leads={model.leads} lanes={model.lanes} allIds={allIds} collapsed={!!collapsed[LEAD_BOX]} {...cardProps} />
                </div>
                <div className="mc-lanes">
                  {model.lanes.map((l, i) => (
                    <LaneNode
                      key={l.groupId}
                      lane={l}
                      index={i + 1}
                      openMenu={openMenu}
                      taskCount={countOwned(tasks, team.filter((m) => l.ids.includes(m.id)))}
                      collapsed={!!collapsed[l.groupId]}
                      renaming={renamingLane === l.groupId}
                      onRenaming={setRenamingLane}
                      {...cardProps}
                    />
                  ))}
                  <NewLaneDrop wsId={wsId} onMoved={onMoved} onRenaming={setRenamingLane} />
                </div>
                <NewLaneDrop zone wsId={wsId} onMoved={onMoved} onRenaming={setRenamingLane} />
                <div className="mc-row mc-signoff-dock">
                  <SignoffNode ids={model.signoff} onJump={jump} onMenu={openCardMenu} />
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
          {taskStats.total > 0 && (
            <span title="Mission tasks done / total (.gridkeeper/mission.md)">
              tasks [ <b>{taskStats.done}</b>/<b>{taskStats.total}</b> ]
            </span>
          )}
          <span title="Terminal output of this workspace's sessions (PTY bytes, not tokens)">
            out [ <b>{formatRate(outTotal)}</b> ]
          </span>
          <WorkspaceCost ids={allIds} />
          <CostMeterHint ids={allIds} variant="mc" />
          <span className="mc-spacer" />
          <span className="mc-keys" title="Keyboard (selected card)">
            <kbd>←↑↓→</kbd> select · <kbd>enter</kbd> jump · <kbd>r</kbd> restart · <kbd>s</kbd> stop/start · <kbd>m</kbd> message · <kbd>del</kbd> close ·{" "}
            <kbd>F2</kbd> rename · <kbd>alt+←→</kbd> reorder · <kbd>alt+↑↓</kbd> move lane · <kbd>⇧F10</kbd> menu · <kbd>esc</kbd> close
          </span>
        </footer>
        <div className="mc-sr" role="status" aria-live="polite" aria-atomic="true">
          {announce}
        </div>
      </div>
      {menu.element}
    </div>,
    document.body,
  );
}

// ---- nodes -------------------------------------------------------------------------------------

interface CardProps {
  selected: SessionId | null;
  onSelect: (id: SessionId) => void;
  onJump: (id: SessionId) => void;
  onMenu: (e: MenuEvent, id: SessionId) => void;
  now: number;
  /** Current mission task per session (see currentTaskFor). */
  tasks: Record<SessionId, Task>;
  /** Lamp per session (collapsed one-line summaries). */
  lamps: Record<SessionId, FleetLamp>;
  /** A card / lane move finished (drag & drop): announce + refocus. */
  onMoved: OnMoved;
}

/** One lamp per session: the one-line summary of a collapsed box. */
function Lamps({ ids, lamps }: { ids: SessionId[]; lamps: Record<SessionId, FleetLamp> }) {
  return (
    <span className="mc-lamps" aria-hidden="true">
      {ids.map((id) => (
        <span key={id} className={`attn-lamp attn-lamp--${lamps[id] ?? "stopped"}`} title={`${sessionName(id)}: ${lamps[id] ?? "stopped"}`} />
      ))}
    </span>
  );
}

/** ▾ / ▸ in a box label: collapse to a one-line summary (Mission UI store, this run only). */
function FoldToggle({ k, collapsed, what }: { k: string; collapsed: boolean; what: string }) {
  return (
    <button
      type="button"
      className="mc-fold"
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? "Expand" : "Collapse"} ${what}`}
      title={collapsed ? "Expand" : "Collapse to one line"}
      onClick={(e) => {
        e.stopPropagation();
        useMission.getState().toggleCollapsed(k);
      }}
    >
      {collapsed ? "▸" : "▾"}
    </button>
  );
}

/** The lead box accepts a dragged non-lead card: dropping it makes that session a lead. */
function useLeadDrop(onMoved: OnMoved) {
  const [over, setOver] = useState(false);
  const dragging = useMcDragKind((s) => s.kind === "session");
  useEffect(() => {
    if (!dragging) setOver(false);
  }, [dragging]);
  const accepts = (e: DragEvent) => {
    const d = currentSessionDrag();
    return !!d && dragHas(e, SESSION_MIME) && metaOf(d.sessionId)?.role !== "lead";
  };
  return {
    over,
    handlers: {
      onDragOver: (e: DragEvent<HTMLDivElement>) => {
        if (!accepts(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      },
      onDragLeave: (e: DragEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e: DragEvent<HTMLDivElement>) => {
        setOver(false);
        const d = currentSessionDrag();
        if (!d || !accepts(e)) return;
        e.preventDefault();
        endSessionDrag();
        onMoved(d.sessionId, makeLead(d.sessionId));
      },
    },
  };
}

function LeadNode({
  leads,
  lanes,
  allIds,
  collapsed,
  selected,
  onSelect,
  onJump,
  onMenu,
  now,
  tasks,
  lamps,
  onMoved,
}: CardProps & { leads: SessionId[]; lanes: LaneModel[]; allIds: SessionId[]; collapsed: boolean }) {
  const liveLeads = useApp((s) => leads.filter((id) => isLive(s.runtime[id])).length);
  const drop = useLeadDrop(onMoved);
  const dropCls = drop.over ? " is-drop-target" : "";
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
      <div data-node="lead" className={`mc-node mc-lead is-placeholder${dropCls}`} {...drop.handlers}>
        <span className="mc-node-label">lead · orchestrator</span>
        {phases}
        <div>no lead yet — pick the session that coordinates the others, or drag its card here</div>
        <AssignLead ids={allIds} />
        <LeadControl leads={leads} />
      </div>
    );
  if (collapsed)
    return (
      <div data-node="lead" className={`mc-node mc-lead is-solid is-collapsed${dropCls}`} {...drop.handlers}>
        <span className="mc-node-label mc-box-label">
          <FoldToggle k={LEAD_BOX} collapsed what="lead box" />
          lead · orchestrator
        </span>
        <span className="mc-node-label mc-node-label-right">{leads.length === 1 ? "1 lead" : `${leads.length} leads`}</span>
        <div className="mc-collapsed-line">
          <Lamps ids={leads} lamps={lamps} />
          <span>
            {leads.map(sessionName).join(", ")} · {liveLeads} running
          </span>
          {lanes.length > 0 && <span className="mc-bracket">· {lanes.length === 1 ? "1 lane" : `${lanes.length} lanes`}</span>}
        </div>
      </div>
    );
  return (
    <div data-node="lead" className={`mc-node mc-lead is-solid${dropCls}`} {...drop.handlers}>
      <span className="mc-node-label mc-box-label">
        <FoldToggle k={LEAD_BOX} collapsed={false} what="lead box" />
        lead · orchestrator
      </span>
      <span className="mc-node-label mc-node-label-right">{leads.length === 1 ? "1 lead" : `${leads.length} leads`}</span>
      <div className="mc-node-actions">
        {phases}
        <span className="mc-spacer" />
        <button
          type="button"
          className="mc-btn"
          disabled={liveLeads === 0}
          title={liveLeads ? "Type a line to the lead (opens the composer; nothing is sent until you press Send)" : "The lead is not running"}
          onClick={() => messageSessions(leads, "the lead")}
        >
          message lead…
        </button>
      </div>
      <div className="mc-cards">
        {leads.map((id) => (
          <SessionCard
            key={id}
            id={id}
            selected={id === selected}
            onSelect={onSelect}
            onJump={onJump}
            onMenu={onMenu}
            now={now}
            task={tasks[id]?.text ?? null}
            taskState={tasks[id]?.state ?? null}
          />
        ))}
      </div>
      <LeadControl leads={leads} />
    </div>
  );
}

/** "assign lead…": a menu of this workspace's sessions; picking one gives it the lead role. */
function AssignLead({ ids }: { ids: SessionId[] }) {
  const menu = useContextMenu();
  const options = useApp(
    useShallow((s) =>
      ids.map((id) => {
        const m = s.persisted.sessions.find((x) => x.id === id);
        return `${id}${SEP}${m?.name ?? id}${SEP}${m?.agent ?? "powershell"}${SEP}${isLive(s.runtime[id]) ? "1" : ""}`;
      }),
    ),
  );
  if (!options.length) return null;
  const items: MenuItem[] = options.map((o) => {
    const [id, name, agent, live] = o.split(SEP);
    return {
      label: name,
      hint: live ? "running" : undefined,
      icon: <AgentGlyph agent={agent as Parameters<typeof AgentGlyph>[0]["agent"]} size={11} />,
      onSelect: () => useApp.getState().updateSessionMeta(id, { role: "lead" }),
    };
  });
  return (
    <div className="mc-assign">
      <button
        type="button"
        className="mc-btn is-primary"
        aria-haspopup="menu"
        aria-expanded={menu.isOpen}
        onClick={(e) => menu.openAt(e.currentTarget, items)}
      >
        assign lead… ▾
      </button>
      {menu.element}
    </div>
  );
}

function LaneNode({
  lane,
  index,
  openMenu,
  taskCount,
  selected,
  onSelect,
  onJump,
  onMenu,
  now,
  tasks,
  lamps,
  onMoved,
  collapsed,
  renaming,
  onRenaming,
}: CardProps & {
  lane: LaneModel;
  index: number;
  openMenu: OpenMenu;
  taskCount: number;
  collapsed: boolean;
  renaming: boolean;
  onRenaming: (groupId: string | null) => void;
}) {
  const progress = laneProgress(lane);
  const what = `lane “${lane.name}”`;
  const canRestart = useApp((s) => restartTargets(lane.ids, s.persisted.sessions, s.runtime).length > 0);
  // "remove lane" only for a really empty group (no hidden lead / browser pane) that is not the last one.
  const removable = useApp((s) => {
    for (const w of s.persisted.workspaces) {
      const g = w.groups.find((x) => x.id === lane.groupId);
      if (g) return g.sessionIds.length === 0 && w.groups.length > 1;
    }
    return false;
  });
  const drop = useLaneDrop(lane, collapsed, onMoved);
  const cls = [
    "mc-node",
    lane.live > 0 ? "is-solid" : "",
    lane.needs > 0 ? "is-needs" : "",
    !collapsed && lane.total >= 7 ? "is-wide" : "",
    collapsed ? "is-collapsed" : "",
    drop.state?.kind === "card" ? "is-drop-target" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const laneMenu = (e: MenuEvent) => openMenu(e, buildGroupMenu(lane.groupId, { onRename: () => onRenaming(lane.groupId) }));
  const anchor = drop.state?.kind === "card" ? drop.state.anchor : null;
  const label = (
    <span className="mc-node-label mc-box-label">
      <span
        className="mc-grip"
        draggable={!renaming}
        title="Drag to reorder lanes (or focus the lane and press Alt+←/→)"
        aria-hidden="true"
        onDragStart={(e) => {
          e.stopPropagation();
          beginLaneDrag({ groupId: lane.groupId });
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData(LANE_MIME, lane.groupId);
          const box = e.currentTarget.closest<HTMLElement>("[data-node]");
          if (box) e.dataTransfer.setDragImage(box, 14, 8);
        }}
        onDragEnd={endLaneDrag}
      >
        ⠿
      </span>
      <FoldToggle k={lane.groupId} collapsed={collapsed} what={what} />
      {renaming ? (
        <LaneRename groupId={lane.groupId} name={lane.name} onDone={() => onRenaming(null)} />
      ) : (
        <span className="mc-lane-name" title="Double-click to rename (F2 on the lane)" onDoubleClick={() => onRenaming(lane.groupId)}>
          lane {index} · {lane.name}
        </span>
      )}
    </span>
  );
  const box = {
    "data-node": `lane:${lane.groupId}`,
    "data-lane-drop": drop.state?.kind === "lane" ? drop.state.side : undefined,
    className: cls,
    tabIndex: -1,
    "aria-label": `Lane ${index}: ${lane.name}`,
    onContextMenu: (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("[data-card], input, button")) return;
      laneMenu(e);
    },
    ...drop.handlers,
  };
  if (collapsed)
    return (
      <div {...box}>
        {label}
        <span className="mc-node-label mc-node-label-right">{lane.total === 1 ? "1 agent" : `${lane.total} agents`}</span>
        <div className="mc-collapsed-line">
          <Lamps ids={lane.ids} lamps={lamps} />
          <span>{progress ? progress.label : "empty"}</span>
          {taskCount > 0 && <span>· {taskCount === 1 ? "1 task" : `${taskCount} tasks`}</span>}
          <span className="mc-lane-stats">
            {lane.working > 0 && <span className="is-working">{lane.working} working</span>}
            {lane.needs > 0 && <span className="is-needs">{lane.needs} need you</span>}
            {lane.errors > 0 && <span className="is-err">{lane.errors} error</span>}
          </span>
        </div>
      </div>
    );
  return (
    <div {...box}>
      {label}
      <span className="mc-node-label mc-node-label-right">{lane.total === 1 ? "1 agent" : `${lane.total} agents`}</span>
      <div className="mc-lane-actions" role="toolbar" aria-label={`${lane.name} actions`}>
        <QuickLaunchButton groupId={lane.groupId} variant="ghost" label="Add session" />
        {lane.total > 0 ? (
          <>
            <button type="button" className="mc-btn" disabled={lane.live === 0} title="Type one line to this lane's running sessions" onClick={() => messageSessions(lane.ids, what)}>
              message lane…
            </button>
            <button type="button" className="mc-btn" disabled={!canRestart} title="Restart every session of this lane (asks first)" onClick={() => void restartSessions(lane.ids, what)}>
              restart lane
            </button>
            <button type="button" className="mc-btn" disabled={lane.live === 0} title="Stop this lane's running sessions (asks first)" onClick={() => void stopSessions(lane.ids, what)}>
              stop lane
            </button>
          </>
        ) : (
          <>
            <button type="button" className="mc-btn is-primary" onClick={() => useMission.getState().openFormation({ groupId: lane.groupId })}>
              launch formation…
            </button>
            {removable && (
              <button type="button" className="mc-btn" title="Remove this empty lane (its group)" onClick={() => void deleteGroupFlow(lane.groupId)}>
                remove lane
              </button>
            )}
          </>
        )}
        <span className="mc-spacer" />
        <button
          type="button"
          className="mc-btn mc-btn-icon"
          aria-label={`More actions for ${lane.name}`}
          aria-haspopup="menu"
          title="More lane actions"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            laneMenu({ clientX: r.left, clientY: r.bottom + 2 });
          }}
        >
          ⋯
        </button>
      </div>
      {progress ? (
        <div className="mc-lane-head mc-micro">
          <span className="mc-progress" role="progressbar" aria-valuemin={0} aria-valuemax={lane.total} aria-valuenow={lane.done} aria-label={progress.label}>
            <span style={{ width: `${Math.round(progress.fraction * 100)}%` } as CSSProperties} />
          </span>
          <span>{progress.label}</span>
          {taskCount > 0 && <span title="Mission tasks owned by this lane's sessions">· {taskCount === 1 ? "1 task" : `${taskCount} tasks`}</span>}
          <span className="mc-lane-stats">
            {lane.working > 0 && <span className="is-working">{lane.working} working</span>}
            {lane.needs > 0 && <span className="is-needs">{lane.needs} need you</span>}
            {lane.errors > 0 && <span className="is-err">{lane.errors} error</span>}
          </span>
        </div>
      ) : (
        <div className="mc-empty">empty group — add a session, launch a formation or drag a card here</div>
      )}
      <div className="mc-cards">
        {lane.ids.map((id) => (
          <SessionCard
            key={id}
            id={id}
            selected={id === selected}
            onSelect={onSelect}
            onJump={onJump}
            onMenu={onMenu}
            now={now}
            task={tasks[id]?.text ?? null}
            taskState={tasks[id]?.state ?? null}
            dropSide={anchor?.id === id ? anchor.side : null}
          />
        ))}
      </div>
    </div>
  );
}

type LaneDropState = { kind: "card"; anchor: Anchor } | { kind: "lane"; side: DropSide } | null;

/**
 * A lane accepts a dragged card (insert next to the nearest card; a collapsed lane appends) and a
 * dragged lane (reorder before / after this one). State changes only when the target changes.
 */
function useLaneDrop(lane: LaneModel, collapsed: boolean, onMoved: OnMoved) {
  const [state, setState] = useState<LaneDropState>(null);
  const dragging = useMcDragKind((s) => s.kind !== null);
  useEffect(() => {
    if (!dragging) setState(null);
  }, [dragging]);
  const cardAnchor = (e: DragEvent<HTMLDivElement>, sessionId: SessionId) => (collapsed ? null : nearestCard(e.currentTarget, e.clientX, e.clientY, sessionId));
  return {
    state,
    handlers: {
      onDragOver: (e: DragEvent<HTMLDivElement>) => {
        const sd = currentSessionDrag();
        if (sd && dragHas(e, SESSION_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const anchor = cardAnchor(e, sd.sessionId);
          setState((p) => (p?.kind === "card" && p.anchor?.id === anchor?.id && p.anchor?.side === anchor?.side ? p : { kind: "card", anchor }));
          return;
        }
        const ld = currentLaneDrag();
        if (ld && dragHas(e, LANE_MIME) && ld.groupId !== lane.groupId) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          const side = sideOf(e.clientX, e.currentTarget.getBoundingClientRect());
          setState((p) => (p?.kind === "lane" && p.side === side ? p : { kind: "lane", side }));
        }
      },
      onDragLeave: (e: DragEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setState(null);
      },
      onDrop: (e: DragEvent<HTMLDivElement>) => {
        setState(null);
        const sd = currentSessionDrag();
        const ld = currentLaneDrag();
        if (sd && dragHas(e, SESSION_MIME)) {
          e.preventDefault();
          const anchor = cardAnchor(e, sd.sessionId);
          endSessionDrag();
          onMoved(sd.sessionId, moveCardToLane(sd.sessionId, lane.groupId, anchor));
        } else if (ld && dragHas(e, LANE_MIME)) {
          e.preventDefault();
          endLaneDrag();
          onMoved(null, moveLane(ld.groupId, lane.groupId, sideOf(e.clientX, e.currentTarget.getBoundingClientRect())));
        }
      },
    },
  };
}

/** Inline lane rename in the box label (same rules as a group tab: trimmed, unchanged / empty = no-op). */
function LaneRename({ groupId, name, onDone }: { groupId: string; name: string; onDone: () => void }) {
  const done = useRef(false);
  const finish = (value: string | null, input: HTMLInputElement) => {
    if (done.current) return;
    done.current = true;
    const t = value?.trim();
    if (t && t !== name) useApp.getState().renameGroup(groupId, t);
    const box = input.closest<HTMLElement>("[data-node]");
    onDone();
    requestAnimationFrame(() => box?.isConnected && box.focus());
  };
  return (
    <input
      className="mc-lane-rename"
      defaultValue={name}
      autoFocus
      spellCheck={false}
      maxLength={64}
      aria-label="Lane name"
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.currentTarget.value, e.currentTarget)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value, e.currentTarget);
        else if (e.key === "Escape") finish(null, e.currentTarget);
      }}
    />
  );
}

/**
 * "+ new lane": a tile at the end of the lanes (click = new empty lane, then rename it inline) and, while
 * a card is dragged, a drop zone under the lanes. Dropping a card on either creates "Lane N" with it.
 */
function NewLaneDrop({ wsId, zone, onMoved, onRenaming }: { wsId: string | null; zone?: boolean; onMoved: OnMoved; onRenaming: (groupId: string | null) => void }) {
  const dragging = useMcDragKind((s) => s.kind === "session");
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!dragging) setOver(false);
  }, [dragging]);
  if (zone && !dragging) return null;
  const handlers = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!currentSessionDrag() || !dragHas(e, SESSION_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!over) setOver(true);
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      setOver(false);
      const sd = currentSessionDrag();
      if (!sd || !dragHas(e, SESSION_MIME)) return;
      e.preventDefault();
      endSessionDrag();
      const gid = createLane(wsId);
      if (gid) onMoved(sd.sessionId, moveCardToLane(sd.sessionId, gid, null));
    },
  };
  if (zone)
    return (
      <div className="mc-row">
        <div className={`mc-newlane-zone${over ? " is-over" : ""}`} {...handlers}>
          + drop here → new lane
        </div>
      </div>
    );
  return (
    <button
      type="button"
      className={`mc-newlane${dragging ? " is-armed" : ""}${over ? " is-over" : ""}`}
      title="Add an empty lane (a new group in this workspace); drop a card here to move it into a new lane"
      disabled={!wsId}
      onClick={() => {
        const gid = createLane(wsId);
        if (gid) onRenaming(gid);
        onMoved(null, gid ? "New lane added" : null);
      }}
      {...handlers}
    >
      + new lane
    </button>
  );
}

function EmptyMission({ groupId }: { groupId: string | undefined }) {
  return (
    <div className="mc-row">
      <div data-node="lead" className="mc-node mc-lead is-placeholder">
        <span className="mc-node-label">mission</span>
        <div>No agents in this workspace yet.</div>
        <div className="mc-empty-actions">
          {groupId && <QuickLaunchButton groupId={groupId} variant="ghost" label="Add session" />}
          <button type="button" className="mc-btn is-primary" onClick={() => useMission.getState().openFormation({ groupId })}>
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
