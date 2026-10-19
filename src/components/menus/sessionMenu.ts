// One context menu for a session, shared by every surface that shows one: the terminal itself
// (right-click), the pane header (right-click / "…"), Mission Control cards, Fleet tiles and Comms rows.
// `sessionMenuState` reads the stores; `buildSessionMenu` turns that state + the surface context into
// items (pure apart from the actions the items run, so it is unit-tested with a plain state object).
//
// Rules: every destructive action confirms (close of a live session, force stop, restart of a live
// session, and stop from a surface where the pane is not on screen); nothing here types into an agent —
// "Message…" only opens the Broadcast composer with the session preselected.

import { confirmCloseSession, confirmForceStop, focusSession, jumpToSession } from "../../actions/commands";
import { openPort } from "../../actions/browser";
import { messageSessions } from "../../actions/groupActions";
import { handoffSubmenu } from "../../actions/handoff";
import { isBrowserMeta } from "../../lib/browserPanes";
import { usePorts } from "../../store/ports";
import { toggleSessionMute } from "../../actions/notifyPrefs";
import { clearSession, copyOutput, hideView, restartSession, showView, startSession, stopSession } from "../../actions/sessions";
import { BUILTIN_ROLES, isBuiltinRole, roleInfo } from "../../lib/roles";
import type { AgentKind, ResumeMode, SessionId } from "../../lib/types";
import { findGroupOf, isLive, useApp } from "../../store/appStore";
import { useFind } from "../../store/findStore";
import { requestRename } from "../../store/renameRequest";
import { confirmDialog } from "../../store/uiStore";
import { copyTerminalSelection, pasteIntoTerminal, selectAllInTerminal, zoomTerminal } from "../../terminal/registry";
import { copyHint, pasteHint } from "../../terminal/terminalKeys";
import type { MenuAction, MenuItem } from "../ui/Menu";
import { newSessionSubmenu, shortcutHint, splitSubmenu } from "./common";
import { t } from "../../i18n";

export type MenuSurface = "terminal" | "header" | "mission" | "fleet" | "comms";

export interface SessionMenuCtx {
  surface: MenuSurface;
  /** Terminal: text is selected (enables Copy). */
  hasSelection?: boolean;
  /** Header: inline rename in place. */
  onRename?: () => void;
  /** Overlay surfaces: called before navigating to the pane (closes the overlay). */
  onNavigate?: () => void;
}

export interface SessionMenuState {
  exists: boolean;
  /** Browser panes have no process: only navigation / rename / close apply. */
  isBrowser?: boolean;
  /** Local ports the session's process listens on (dev servers). */
  ports?: number[];
  name: string;
  agent: AgentKind | null;
  live: boolean;
  /** Has run in this app run (has runtime info). */
  hasRun: boolean;
  role: string | null;
  muted: boolean;
  hidden: boolean;
  groupId: string | null;
  index: number;
  count: number;
  maximized: boolean;
  resume: ResumeMode;
}

export function sessionMenuState(id: SessionId): SessionMenuState {
  const s = useApp.getState();
  const meta = s.persisted.sessions.find((m) => m.id === id);
  const loc = findGroupOf(id);
  const rt = s.runtime[id];
  return {
    exists: !!meta,
    isBrowser: isBrowserMeta(meta),
    ports: (usePorts.getState().bySession[id] ?? []).map((p) => p.port),
    name: meta?.name ?? t("command.sessionFallbackName"),
    agent: meta?.agent ?? null,
    live: isLive(rt),
    hasRun: !!rt,
    role: meta?.role ?? null,
    muted: !!s.persisted.settings.notifications?.mutedSessions?.includes(id),
    hidden: !!s.hiddenViews[id],
    groupId: loc?.group.id ?? null,
    index: loc ? loc.group.sessionIds.indexOf(id) : -1,
    count: loc?.group.sessionIds.length ?? 0,
    maximized: !!loc && loc.group.layout.maximized === id,
    resume: meta?.resumeOnRestore ?? { mode: "none" },
  };
}

/** Agents that keep a conversation (resume vs fresh matters). */
const isConversational = (a: AgentKind | null) => a === "claude" || a === "codex";

/** Surfaces where the pane is not on screen: plain stop asks first there. */
const offscreen = (s: MenuSurface) => s === "mission" || s === "fleet" || s === "comms";

export function roleSubmenu(id: SessionId, current: string | null, onCustom: () => void): MenuAction {
  const set = (role: string | null) => useApp.getState().updateSessionMeta(id, { role });
  const children: MenuItem[] = [{ label: t("menu.role.none"), checked: !current, onSelect: () => set(null) }];
  for (const r of BUILTIN_ROLES) {
    const info = roleInfo(r)!;
    children.push({ label: `${info.glyph}  ${info.label}`, checked: current === r, onSelect: () => set(r) });
  }
  children.push("separator", {
    label: current && !isBuiltinRole(current) ? t("menu.role.customCurrent", { role: current }) : t("menu.role.custom"),
    checked: current ? !isBuiltinRole(current) : undefined,
    onSelect: onCustom,
  });
  return { label: t("menu.role.label"), children };
}

export async function confirmRestart(id: SessionId, name: string, resume: ResumeMode, live: boolean): Promise<void> {
  if (live) {
    const fresh = resume.mode === "none";
    const ok = await confirmDialog({
      title: fresh ? t("menu.restart.titleFresh", { name }) : t("menu.restart.title", { name }),
      message: fresh ? t("menu.restart.messageFresh") : t("menu.restart.message"),
      confirmLabel: t("common.restart"),
      danger: true,
    });
    if (!ok) return;
  }
  await restartSession(id, resume);
}

export async function confirmStop(id: SessionId, name: string): Promise<void> {
  const ok = await confirmDialog({
    title: t("menu.stop.title", { name }),
    message: t("menu.stop.message"),
    confirmLabel: t("common.stop"),
    danger: true,
  });
  if (ok) await stopSession(id, false);
}

export function buildSessionMenu(id: SessionId, ctx: SessionMenuCtx, st: SessionMenuState = sessionMenuState(id)): MenuItem[] {
  if (!st.exists) return [{ label: t("menu.session.notFound"), disabled: true }];
  const { surface } = ctx;
  const inPane = surface === "terminal" || surface === "header";
  const keyHint = (k: string) => (surface === "mission" ? k : undefined);
  const items: MenuItem[] = [];
  const goto = () => {
    ctx.onNavigate?.();
    jumpToSession(id);
  };
  const rename = () => {
    if (ctx.onRename) ctx.onRename();
    else if (surface === "mission") requestRename(id, "mission");
    else if (surface === "terminal") requestRename(id, "pane");
    else {
      // Fleet / Comms: jumping focuses the terminal two frames later (focusSoon); ask for the inline
      // rename after that, or the terminal's focus would blur (and commit) the rename box at once.
      goto();
      window.setTimeout(() => requestRename(id, "pane"), 120);
    }
  };
  const customRole = () => {
    ctx.onNavigate?.();
    focusSession(id);
    useApp.getState().updateSettings({ inspectorOpen: true });
  };

  if (st.isBrowser) {
    // Browser panes (their own header menu has the navigation items): no process actions, no input.
    if (!inPane) items.push({ label: t("menu.session.jump"), hint: keyHint(t("keys.enter")), onSelect: goto });
    items.push({ label: t("menu.session.rename"), onSelect: rename }, "separator", { label: t("common.close"), danger: true, onSelect: () => void confirmCloseSession(id) });
    return items;
  }

  // ---- terminal clipboard / view tools
  if (surface === "terminal") {
    items.push(
      { label: t("common.copy"), hint: copyHint(), disabled: !ctx.hasSelection, onSelect: () => copyTerminalSelection(id) },
      { label: t("common.paste"), hint: pasteHint(), onSelect: () => pasteIntoTerminal(id) },
      { label: t("menu.session.selectAll"), onSelect: () => selectAllInTerminal(id) },
      { label: t("menu.session.find"), hint: shortcutHint("terminal.find"), onSelect: () => useFind.getState().open(id) },
      { label: t("menu.session.clear"), onSelect: () => void clearSession(id) },
      { label: t("menu.session.copyAllOutput"), onSelect: () => void copyOutput(id) },
      {
        label: t("menu.session.zoom"),
        children: [
          { label: t("menu.session.zoomIn"), hint: shortcutHint("terminal.zoomIn"), onSelect: () => void zoomTerminal(id, 1) },
          { label: t("menu.session.zoomOut"), hint: shortcutHint("terminal.zoomOut"), onSelect: () => void zoomTerminal(id, -1) },
          { label: t("menu.session.zoomReset"), hint: shortcutHint("terminal.zoomReset"), onSelect: () => void zoomTerminal(id, 0) },
        ],
      },
      "separator",
    );
  } else if (!inPane) {
    items.push({ label: t("menu.session.jump"), hint: keyHint(t("keys.enter")), onSelect: goto });
  }

  items.push({ label: t("menu.session.message"), hint: keyHint("M"), disabled: !st.live, onSelect: () => messageSessions([id], t("menu.quoted", { name: st.name })) });
  if (surface === "mission") items.push(handoffSubmenu(id));
  if (st.ports?.length) {
    items.push({
      label: t("menu.session.openInBrowser"),
      children: st.ports.map((port) => ({
        label: `localhost:${port}`,
        onSelect: () => {
          ctx.onNavigate?.();
          openPort(id, port);
        },
      })),
    });
  }

  // ---- layout (only where the pane is on screen)
  if (inPane && st.groupId) {
    items.push(newSessionSubmenu(st.groupId), splitSubmenu(st.groupId), {
      label: st.maximized ? t("menu.session.restore") : t("menu.session.maximize"),
      hint: shortcutHint("session.maximize"),
      onSelect: () => st.groupId && useApp.getState().updateLayout(st.groupId, { maximized: st.maximized ? null : id }),
    });
  }

  // ---- lifecycle
  items.push("separator");
  const conv = isConversational(st.agent);
  if (st.live) {
    items.push(
      { label: conv ? t("menu.session.restartResume") : t("common.restart"), hint: keyHint("R"), onSelect: () => void confirmRestart(id, st.name, { mode: "continue" }, true) },
      ...(conv ? [{ label: t("menu.session.restartFresh"), onSelect: () => void confirmRestart(id, st.name, { mode: "none" }, true) } as MenuAction] : []),
      { label: t("common.stop"), hint: keyHint("S"), onSelect: () => void (offscreen(surface) ? confirmStop(id, st.name) : stopSession(id, false)) },
      { label: t("menu.session.forceStop"), danger: true, onSelect: () => void confirmForceStop(id) },
    );
  } else {
    items.push(
      { label: conv ? t("menu.session.startResume") : t("common.start"), hint: keyHint("S"), onSelect: () => void startSession(id, conv ? st.resume : { mode: "none" }) },
      ...(conv ? [{ label: t("menu.session.startFresh"), onSelect: () => void restartSession(id, { mode: "none" }) } as MenuAction] : []),
    );
  }

  // ---- session settings
  items.push(
    "separator",
    { label: st.muted ? t("menu.unmuteNotifications") : t("menu.muteNotifications"), checked: st.muted, onSelect: () => toggleSessionMute(id) },
    roleSubmenu(id, st.role, customRole),
    { label: t("menu.session.rename"), hint: surface === "mission" ? "F2" : undefined, onSelect: rename },
  );
  if (!inPane) items.push({ label: t("menu.session.copyOutput"), onSelect: () => void copyOutput(id) });
  if (inPane) items.push(st.hidden ? { label: t("menu.session.showView"), onSelect: () => showView(id) } : { label: t("menu.session.hideView"), onSelect: () => hideView(id) });
  if (surface === "header" && st.groupId) {
    const gid = st.groupId;
    items.push(
      { label: t("menu.session.moveLeft"), disabled: st.index <= 0, onSelect: () => useApp.getState().moveSession(gid, st.index, st.index - 1) },
      { label: t("menu.session.moveRight"), disabled: st.index < 0 || st.index >= st.count - 1, onSelect: () => useApp.getState().moveSession(gid, st.index, st.index + 1) },
    );
  }

  items.push("separator", {
    label: st.live ? t("menu.session.closeConfirm") : t("common.close"),
    hint: surface === "mission" ? t("keys.delete") : inPane ? shortcutHint("session.close") : undefined,
    danger: true,
    onSelect: () => void confirmCloseSession(id),
  });
  return items;
}
