// Pane header: status, agent glyph, name (double-click to rename), account / worktree / cwd chips,
// and hover actions. Subscribes only to this session's metadata, coarse runtime state and profile.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { closeSession, renameSession, restartSession, startSession, stopSession } from "../actions/sessions";
import type { SessionId } from "../lib/types";
import { selectSessionMeta, useApp } from "../store/appStore";
import { focusTerminal } from "../terminal/registry";
import { confirmAction } from "./confirm";
import { QuickLaunchButton } from "../components/QuickLaunch";
import { AgentGlyph, IconBranch, IconClose, IconMaximize, IconMore, IconPlay, IconRestart, IconRestore, IconStop } from "./icons";
import { beginPaneDrag, endPaneDrag } from "./paneDrag";
import { AttentionLamp } from "../components/AttentionBits";
import { RoleTag } from "../components/mission/RoleTag";
import { buildSessionMenu } from "../components/menus/sessionMenu";
import { useContextMenu, type MenuItem as AppMenuItem } from "../components/ui/Menu";
import { clearRenameRequest, renameSeqFor, useRenameRequest } from "../store/renameRequest";
import { MutedGlyph } from "../components/MutedGlyph";
import { useSessionMuted } from "../actions/notifyPrefs";
import { isSignedIn } from "../lib/accounts";
import { goHome, openExternal, openPort, popOut, reload } from "../actions/browser";
import { ownOrigin, useBrowserNav, viewOf, type BrowserView } from "../browser/nav";
import { currentEngine } from "../browser/engine";
import { portChipLabel } from "../lib/browserPanes";
import { usePorts } from "../store/ports";
import { copyText } from "../components/util/pick";
import { MeterChip } from "../components/MeterChip";
import { HookChip } from "../components/HookChip";
import { IconGlobe } from "./icons";
import { t, useT } from "../i18n";

function browserStatus(view: BrowserView, loading: boolean): { cls: string; label: string } {
  if (view === "start") return { cls: "idle", label: t("pane.browser.startPage") };
  if (view === "refused" || view === "unreachable" || view === "blocked" || view === "invalid")
    return { cls: "error", label: view === "unreachable" ? t("pane.browser.notReachable") : t("pane.browser.cannotShow") };
  if (loading) return { cls: "pending", label: t("pane.browser.loading") };
  return { cls: "running", label: view === "file" ? t("pane.browser.localFile") : t("pane.browser.loaded") };
}

export interface PaneHeaderProps {
  sessionId: SessionId;
  groupId: string;
  index: number;
  count: number;
  maximized: boolean;
}

export type CoarseState = "idle" | "starting" | "running" | "stopping" | "exited" | "failed";

export interface RuntimeView {
  state: CoarseState;
  code: number | null;
  message: string | null;
  pid: number | null;
}

/** Narrow, shallow-comparable runtime projection (ignores bytesOut and other churn). */
export function useRuntimeView(id: SessionId): RuntimeView {
  return useApp(
    useShallow((s) => {
      const r = s.runtime[id];
      if (!r) return { state: "idle" as CoarseState, code: null, message: null, pid: null };
      return {
        state: r.state.state as CoarseState,
        code: r.state.state === "exited" ? r.state.code : null,
        message: r.state.state === "failed" ? r.state.message : null,
        pid: r.pid,
      };
    }),
  );
}

export const isLiveState = (s: CoarseState) => s === "starting" || s === "running" || s === "stopping";

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function statusInfo(rt: RuntimeView): { cls: string; label: string } {
  switch (rt.state) {
    case "running":
      return { cls: "running", label: rt.pid ? t("pane.status.runningPid", { pid: rt.pid }) : t("session.state.running") };
    case "starting":
      return { cls: "pending", label: t("session.state.starting") };
    case "stopping":
      return { cls: "pending", label: t("session.state.stopping") };
    case "exited":
      return rt.code !== null && rt.code !== 0
        ? { cls: "error", label: t("pane.status.exitedCode", { code: rt.code }) }
        : { cls: "idle", label: rt.code === null ? t("session.state.exited") : t("pane.status.exitedCode", { code: 0 }) };
    case "failed":
      return { cls: "error", label: rt.message ? t("pane.status.failedMessage", { message: rt.message }) : t("session.state.failed") };
    default:
      return { cls: "idle", label: t("session.state.notStarted") };
  }
}

// ---- menu -----------------------------------------------------------------------------------

interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
}

function PaneMenu({ anchor, items, onClose }: { anchor: HTMLElement; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const menu = ref.current;
    const w = menu?.offsetWidth ?? 180;
    const h = menu?.offsetHeight ?? 240;
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    const left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
    setPos({ top, left });
    menu?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [anchor]);

  useEffect(() => {
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        const i = btns.indexOf(document.activeElement as HTMLButtonElement);
        const next = e.key === "ArrowDown" ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
        btns[next]?.focus();
      }
    };
    const onBlur = () => onClose();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div
      ref={ref}
      className="pane-menu"
      role="menu"
      style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden", top: 0, left: 0 }}
    >
      {items.map((it) => (
        <div key={it.label}>
          {it.separatorBefore && <div className="pane-menu-sep" />}
          <button
            type="button"
            role="menuitem"
            className={`pane-menu-item${it.danger ? " pane-menu-item--danger" : ""}`}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
          >
            {it.label}
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ---- header ---------------------------------------------------------------------------------

export const PaneHeader = memo(function PaneHeader({ sessionId, groupId, index, count, maximized }: PaneHeaderProps) {
  const t = useT();
  const meta = useApp(selectSessionMeta(sessionId));
  const rt = useRuntimeView(sessionId);
  const profileId = meta?.profileId ?? null;
  const profile = useApp((s) => (profileId ? s.accounts.find((p) => p.id === profileId) : undefined));
  const [editing, setEditing] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  // Terminal panes: the shared session menu (same as the terminal's right-click); browser panes: PaneMenu.
  const appMenu = useContextMenu();
  const appMenuWasOpen = useRef(false);
  const muted = useSessionMuted(sessionId);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameDone = useRef(false);
  const renameSeq = useRenameRequest(renameSeqFor(sessionId, "pane"));

  useEffect(() => {
    if (editing) {
      renameDone.current = false;
      inputRef.current?.select();
    }
  }, [editing]);

  // "Rename…" from the terminal / Fleet / Comms context menu.
  useEffect(() => {
    if (!renameSeq) return;
    clearRenameRequest();
    setEditing(true);
  }, [renameSeq]);

  const live = isLiveState(rt.state);

  const commitRename = useCallback(
    (value: string) => {
      if (renameDone.current) return;
      renameDone.current = true;
      setEditing(false);
      renameSession(sessionId, value);
      focusTerminal(sessionId);
    },
    [sessionId],
  );

  const toggleMaximize = useCallback(() => {
    useApp.getState().updateLayout(groupId, { maximized: maximized ? null : sessionId });
  }, [groupId, maximized, sessionId]);

  const onRestart = useCallback(async () => {
    const name = meta?.name ?? t("command.sessionFallbackName");
    if (live && !(await confirmAction(t("pane.confirm.restartMessage", { name }), { title: t("pane.confirm.restartTitle"), confirmLabel: t("common.restart") })))
      return;
    void restartSession(sessionId);
  }, [live, meta?.name, sessionId, t]);

  const onStopOrStart = useCallback(
    async (e: MouseEvent) => {
      if (!live) {
        void startSession(sessionId, meta?.resumeOnRestore ?? { mode: "none" });
        return;
      }
      if (e.shiftKey) {
        const name = meta?.name ?? t("command.sessionFallbackName");
        if (await confirmAction(t("pane.confirm.forceStopMessage", { name }), { title: t("pane.confirm.forceStopTitle"), confirmLabel: t("command.forceStop.confirm") }))
          void stopSession(sessionId, true);
        return;
      }
      void stopSession(sessionId, false);
    },
    [live, meta?.name, meta?.resumeOnRestore, sessionId, t],
  );

  const onClose = useCallback(async () => {
    const name = meta?.name ?? t("command.sessionFallbackName");
    if (live && !(await confirmAction(t("pane.confirm.closeMessage", { name }), { title: t("pane.closeSession"), confirmLabel: t("common.close") })))
      return;
    void closeSession(sessionId);
  }, [live, meta?.name, sessionId, t]);

  const closeMenu = useCallback(() => setMenuAnchor(null), []);
  const [portsAnchor, setPortsAnchor] = useState<HTMLElement | null>(null);
  const closePortsMenu = useCallback(() => setPortsAnchor(null), []);
  const ports = usePorts((s) => s.bySession[sessionId]);
  const browserState = useBrowserNav(
    useShallow((s) => {
      const n = s.panes[sessionId];
      return { view: viewOf(n, ownOrigin(), currentEngine()), loading: !!n?.loading, url: n?.url ?? null };
    }),
  );

  if (!meta) return <div className="pane-header" />;
  const isBrowser = meta.kind === "browser";

  const status = isBrowser ? browserStatus(browserState.view, browserState.loading) : statusInfo(rt);
  const cwdBase = basename(meta.cwd);
  const branch = meta.worktree ? (meta.worktree.branch ?? basename(meta.worktree.path)) : null;
  const profileWarn = !!profile && !isSignedIn(profile);

  const moveItems: MenuItem[] = [
    {
      label: t("pane.menu.moveLeft"),
      separatorBefore: true,
      disabled: index <= 0,
      onSelect: () => useApp.getState().moveSession(groupId, index, index - 1),
    },
    {
      label: t("pane.menu.moveRight"),
      disabled: index >= count - 1,
      onSelect: () => useApp.getState().moveSession(groupId, index, index + 1),
    },
  ];
  const browserItems: MenuItem[] = [
    { label: t("common.rename"), onSelect: () => setEditing(true) },
    {
      label: meta.titleAsName ? `✓ ${t("pane.menu.titleAsName")}` : t("pane.menu.titleAsName"),
      onSelect: () => useApp.getState().updateSessionMeta(sessionId, { titleAsName: !meta.titleAsName }),
    },
    { label: t("pane.menu.reload"), separatorBefore: true, disabled: !browserState.url, onSelect: () => reload(sessionId) },
    { label: t("pane.menu.popOut"), disabled: !browserState.url, onSelect: () => void popOut(sessionId) },
    { label: t("pane.menu.openExternal"), disabled: !browserState.url?.startsWith("http"), onSelect: () => openExternal(browserState.url) },
    { label: t("pane.menu.copyAddress"), disabled: !browserState.url, onSelect: () => void copyText(browserState.url ?? "", t("pane.menu.addressCopied")) },
    { label: t("pane.menu.startPage"), disabled: !browserState.url, onSelect: () => goHome(sessionId) },
    ...moveItems,
    { label: t("common.close"), separatorBefore: true, danger: true, onSelect: () => void closeSession(sessionId) },
  ];

  const portItems: MenuItem[] = (ports ?? []).map((p) => ({
    label: t("pane.menu.openPort", { port: p.port }),
    onSelect: () => openPort(sessionId, p.port),
  }));
  const portLabel = isBrowser ? null : portChipLabel(ports);
  const sessionMenuItems = (): AppMenuItem[] => buildSessionMenu(sessionId, { surface: "header", onRename: () => setEditing(true) });

  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    if (editing) {
      e.preventDefault();
      return;
    }
    beginPaneDrag({ groupId, index, sessionId });
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-gridkeeper-pane", sessionId);
  };

  return (
    <div
      className="pane-header"
      draggable={!editing}
      onDragStart={onDragStart}
      onDragEnd={endPaneDrag}
      onDoubleClick={(e) => {
        if (!(e.target as HTMLElement).closest("button, input")) toggleMaximize();
      }}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest("input")) return;
        e.preventDefault();
        if (!isBrowser) appMenu.open(e, sessionMenuItems());
        else setMenuAnchor(e.currentTarget.querySelector<HTMLElement>(".pane-actions [aria-haspopup]") ?? e.currentTarget);
      }}
      onAuxClick={(e) => {
        // Middle-click closes, like a browser tab.
        if (e.button === 1 && !(e.target as HTMLElement).closest("input")) void onClose();
      }}
    >
      <div className="pane-title-area">
        <span className={`pane-dot pane-dot--${status.cls}`} title={status.label} aria-label={status.label} />
        {!isBrowser && <AttentionLamp sessionId={sessionId} />}
        {muted && !isBrowser && <MutedGlyph title={t("pane.mutedTitle")} />}
        <span className="pane-glyph" title={isBrowser ? t("pane.browserPane") : meta.agent}>
          {isBrowser ? <IconGlobe /> : <AgentGlyph agent={meta.agent} />}
        </span>
        {editing ? (
          <input
            ref={inputRef}
            className="pane-rename"
            defaultValue={meta.name}
            spellCheck={false}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitRename(e.currentTarget.value);
              else if (e.key === "Escape") {
                renameDone.current = true;
                setEditing(false);
                focusTerminal(sessionId);
              }
            }}
            onBlur={(e) => commitRename(e.currentTarget.value)}
            onDoubleClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="pane-name"
            title={t("pane.nameTitle", { name: meta.name })}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            {meta.name}
          </span>
        )}
        {!isBrowser && <RoleTag role={meta.role} />}
        {!isBrowser && <HookChip sessionId={sessionId} />}
        {!isBrowser && <MeterChip sessionId={sessionId} variant="pane" />}
        {portLabel && (
          <button
            type="button"
            className="pane-chip pane-chip--port"
            title={t("pane.portsTitle", { ports: (ports ?? []).map((p) => `:${p.port}`).join(", ") })}
            onClick={(e) => {
              if (ports && ports.length > 1) setPortsAnchor(portsAnchor ? null : e.currentTarget);
              else if (ports?.[0]) openPort(sessionId, ports[0].port);
            }}
          >
            {portLabel}
          </button>
        )}
        {!isBrowser && (meta.agent === "claude" || profile) && (
          <span
            className={`pane-chip pane-chip--account${profileWarn ? " pane-chip--warn" : ""}`}
            title={
              profileWarn
                ? t("pane.accountWarn", { name: profile?.name })
                : t("pane.account", { name: profile?.name ?? t("pane.accountDefault") })
            }
          >
            {profile && <span className="pane-chip-dot" style={{ background: profile.color }} />}
            <span className="pane-chip-text">{profile?.name ?? t("pane.accountDefault")}</span>
          </span>
        )}
        {branch && (
          <span className="pane-chip pane-chip--branch" title={t("pane.branchTitle", { branch, path: meta.worktree?.path ?? "" })}>
            <IconBranch />
            <span className="pane-chip-text">{branch}</span>
          </span>
        )}
        {!isBrowser && (
          <span className="pane-cwd" title={meta.cwd}>
            {cwdBase}
          </span>
        )}
      </div>
      <div className="pane-actions">
        <QuickLaunchButton variant="icon" groupId={groupId} />
        <button
          type="button"
          className="pane-icon-btn"
          title={maximized ? t("pane.restore") : t("pane.maximize")}
          aria-label={maximized ? t("pane.restore") : t("pane.maximize")}
          onClick={toggleMaximize}
        >
          {maximized ? <IconRestore /> : <IconMaximize />}
        </button>
        {!isBrowser && (
          <>
            <button type="button" className="pane-icon-btn" title={t("common.restart")} aria-label={t("common.restart")} onClick={() => void onRestart()}>
              <IconRestart />
            </button>
            <button
              type="button"
              className="pane-icon-btn"
              title={live ? t("pane.stopTitle") : t("common.start")}
              aria-label={live ? t("common.stop") : t("common.start")}
              onClick={(e) => void onStopOrStart(e)}
            >
              {live ? <IconStop /> : <IconPlay />}
            </button>
          </>
        )}
        <button
          type="button"
          className={`pane-icon-btn${menuAnchor || appMenu.isOpen ? " is-active" : ""}`}
          title={t("pane.more")}
          aria-label={t("pane.moreActions")}
          aria-haspopup="menu"
          aria-expanded={!!menuAnchor || appMenu.isOpen}
          onMouseDown={() => (appMenuWasOpen.current = appMenu.isOpen)}
          onClick={(e) => {
            if (isBrowser) setMenuAnchor(menuAnchor ? null : e.currentTarget);
            else if (!appMenuWasOpen.current) appMenu.openAt(e.currentTarget, sessionMenuItems());
            appMenuWasOpen.current = false;
          }}
        >
          <IconMore />
        </button>
        <button
          type="button"
          className="pane-icon-btn pane-icon-btn--close"
          title={live ? t("pane.closeSessionLive") : t("pane.closeSession")}
          aria-label={t("pane.closeSession")}
          onClick={() => void onClose()}
        >
          <IconClose />
        </button>
      </div>
      {menuAnchor && <PaneMenu anchor={menuAnchor} items={browserItems} onClose={closeMenu} />}
      {appMenu.element}
      {portsAnchor && <PaneMenu anchor={portsAnchor} items={portItems} onClose={closePortsMenu} />}
    </div>
  );
});
