// Pane header: status, agent glyph, name (double-click to rename), account / worktree / cwd chips,
// and hover actions. Subscribes only to this session's metadata, coarse runtime state and profile.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import {
  clearSession,
  closeSession,
  copyOutput,
  hideView,
  renameSession,
  restartSession,
  startSession,
  stopSession,
} from "../actions/sessions";
import type { SessionId } from "../lib/types";
import { selectSessionMeta, useApp } from "../store/appStore";
import { focusTerminal } from "../terminal/registry";
import { confirmAction } from "./confirm";
import { QuickLaunchButton } from "../components/QuickLaunch";
import { AgentGlyph, IconBranch, IconClose, IconMaximize, IconMore, IconPlay, IconRestart, IconRestore, IconStop } from "./icons";
import { beginPaneDrag, endPaneDrag } from "./paneDrag";
import { AttentionLamp } from "../components/AttentionBits";
import { RoleTag } from "../components/mission/RoleTag";
import { roleMenuItems } from "../components/mission/roleMenu";
import { MutedGlyph } from "../components/MutedGlyph";
import { toggleSessionMute, useSessionMuted } from "../actions/notifyPrefs";
import { isSignedIn } from "../lib/accounts";

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
      return { cls: "running", label: rt.pid ? `Running · pid ${rt.pid}` : "Running" };
    case "starting":
      return { cls: "pending", label: "Starting" };
    case "stopping":
      return { cls: "pending", label: "Stopping" };
    case "exited":
      return rt.code !== null && rt.code !== 0
        ? { cls: "error", label: `Exited with code ${rt.code}` }
        : { cls: "idle", label: rt.code === null ? "Exited" : "Exited with code 0" };
    case "failed":
      return { cls: "error", label: rt.message ? `Failed: ${rt.message}` : "Failed" };
    default:
      return { cls: "idle", label: "Not started" };
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
  const meta = useApp(selectSessionMeta(sessionId));
  const rt = useRuntimeView(sessionId);
  const profileId = meta?.profileId ?? null;
  const profile = useApp((s) => (profileId ? s.accounts.find((p) => p.id === profileId) : undefined));
  const [editing, setEditing] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const muted = useSessionMuted(sessionId);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameDone = useRef(false);

  useEffect(() => {
    if (editing) {
      renameDone.current = false;
      inputRef.current?.select();
    }
  }, [editing]);

  const live = isLiveState(rt.state);
  const isAgent = meta?.agent === "claude" || meta?.agent === "codex";

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
    if (live && !(await confirmAction(`Restart "${meta?.name ?? "session"}"? The running process will be stopped.`, { title: "Restart session", confirmLabel: "Restart" })))
      return;
    void restartSession(sessionId);
  }, [live, meta?.name, sessionId]);

  const onStopOrStart = useCallback(
    async (e: MouseEvent) => {
      if (!live) {
        void startSession(sessionId, meta?.resumeOnRestore ?? { mode: "none" });
        return;
      }
      if (e.shiftKey) {
        if (await confirmAction(`Force-stop "${meta?.name ?? "session"}"? The process tree is terminated immediately and unsaved work may be lost.`, { title: "Force stop", confirmLabel: "Force stop" }))
          void stopSession(sessionId, true);
        return;
      }
      void stopSession(sessionId, false);
    },
    [live, meta?.name, meta?.resumeOnRestore, sessionId],
  );

  const onClose = useCallback(async () => {
    if (live && !(await confirmAction(`Close "${meta?.name ?? "session"}"? Its process is still running and will be stopped.`, { title: "Close session", confirmLabel: "Close" })))
      return;
    void closeSession(sessionId);
  }, [live, meta?.name, sessionId]);

  const closeMenu = useCallback(() => setMenuAnchor(null), []);
  const [roleAnchor, setRoleAnchor] = useState<HTMLElement | null>(null);
  const closeRoleMenu = useCallback(() => setRoleAnchor(null), []);

  if (!meta) return <div className="pane-header" />;

  const status = statusInfo(rt);
  const cwdBase = basename(meta.cwd);
  const branch = meta.worktree ? (meta.worktree.branch ?? basename(meta.worktree.path)) : null;
  const profileWarn = !!profile && !isSignedIn(profile);

  const menuItems: MenuItem[] = [
    { label: "Rename", onSelect: () => setEditing(true) },
    { label: "Copy output", onSelect: () => void copyOutput(sessionId) },
    { label: "Clear", onSelect: () => void clearSession(sessionId) },
    { label: "Hide view", onSelect: () => hideView(sessionId) },
    { label: "Role ▸", onSelect: () => setRoleAnchor(menuAnchor) },
    { label: muted ? "Unmute notifications" : "Mute notifications", onSelect: () => toggleSessionMute(sessionId) },
    {
      label: "Restart fresh",
      separatorBefore: true,
      onSelect: async () => {
        if (live && !(await confirmAction(`Restart "${meta.name}" with a fresh ${isAgent ? "conversation" : "process"}?`, { title: "Restart fresh", confirmLabel: "Restart" })))
          return;
        void restartSession(sessionId, { mode: "none" });
      },
    },
    {
      label: "Move left",
      separatorBefore: true,
      disabled: index <= 0,
      onSelect: () => useApp.getState().moveSession(groupId, index, index - 1),
    },
    {
      label: "Move right",
      disabled: index >= count - 1,
      onSelect: () => useApp.getState().moveSession(groupId, index, index + 1),
    },
    { label: "Close", separatorBefore: true, danger: true, onSelect: () => void onClose() },
  ];

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
        setMenuAnchor(e.currentTarget.querySelector<HTMLElement>(".pane-actions [aria-haspopup]") ?? e.currentTarget);
      }}
      onAuxClick={(e) => {
        // Middle-click closes, like a browser tab.
        if (e.button === 1 && !(e.target as HTMLElement).closest("input")) void onClose();
      }}
    >
      <div className="pane-title-area">
        <span className={`pane-dot pane-dot--${status.cls}`} title={status.label} aria-label={status.label} />
        <AttentionLamp sessionId={sessionId} />
        {muted && <MutedGlyph title="Notifications muted for this session (alerts still reach Comms)" />}
        <span className="pane-glyph" title={meta.agent}>
          <AgentGlyph agent={meta.agent} />
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
            title={`${meta.name} — double-click to rename`}
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditing(true);
            }}
          >
            {meta.name}
          </span>
        )}
        <RoleTag role={meta.role} />
        {(meta.agent === "claude" || profile) && (
          <span
            className={`pane-chip pane-chip--account${profileWarn ? " pane-chip--warn" : ""}`}
            title={
              profileWarn
                ? `Account "${profile?.name}" may not be signed in`
                : `Account: ${profile?.name ?? "Default"}`
            }
          >
            {profile && <span className="pane-chip-dot" style={{ background: profile.color }} />}
            {profile?.name ?? "Default"}
          </span>
        )}
        {branch && (
          <span className="pane-chip" title={`Worktree: ${meta.worktree?.path}`}>
            <IconBranch />
            {branch}
          </span>
        )}
        <span className="pane-cwd" title={meta.cwd}>
          {cwdBase}
        </span>
      </div>
      <div className="pane-actions">
        <QuickLaunchButton variant="icon" groupId={groupId} />
        <button
          type="button"
          className="pane-icon-btn"
          title={maximized ? "Restore" : "Maximize"}
          aria-label={maximized ? "Restore" : "Maximize"}
          onClick={toggleMaximize}
        >
          {maximized ? <IconRestore /> : <IconMaximize />}
        </button>
        <button type="button" className="pane-icon-btn" title="Restart" aria-label="Restart" onClick={() => void onRestart()}>
          <IconRestart />
        </button>
        <button
          type="button"
          className="pane-icon-btn"
          title={live ? "Stop (Shift+click to force)" : "Start"}
          aria-label={live ? "Stop" : "Start"}
          onClick={(e) => void onStopOrStart(e)}
        >
          {live ? <IconStop /> : <IconPlay />}
        </button>
        <button
          type="button"
          className={`pane-icon-btn${menuAnchor ? " is-active" : ""}`}
          title="More"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={!!menuAnchor}
          onClick={(e) => setMenuAnchor(menuAnchor ? null : e.currentTarget)}
        >
          <IconMore />
        </button>
        <button
          type="button"
          className="pane-icon-btn pane-icon-btn--close"
          title={live ? "Close session (stops the process)" : "Close session"}
          aria-label="Close session"
          onClick={() => void onClose()}
        >
          <IconClose />
        </button>
      </div>
      {menuAnchor && <PaneMenu anchor={menuAnchor} items={menuItems} onClose={closeMenu} />}
      {roleAnchor && <PaneMenu anchor={roleAnchor} items={roleMenuItems(sessionId, meta.role ?? null)} onClose={closeRoleMenu} />}
    </div>
  );
});
