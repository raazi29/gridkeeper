// Pane header: status, agent glyph, name (double-click to rename), account / worktree / cwd chips,
// and hover actions. Subscribes only to this session's metadata, coarse runtime state and profile.

import { memo, useCallback, useEffect, useRef, useState, type DragEvent, type MouseEvent } from "react";
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
import { useContextMenu } from "../components/ui/Menu";
import { clearRenameRequest, renameSeqFor, useRenameRequest } from "../store/renameRequest";
import { MutedGlyph } from "../components/MutedGlyph";
import { useSessionMuted } from "../actions/notifyPrefs";
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

// ---- header ---------------------------------------------------------------------------------

export const PaneHeader = memo(function PaneHeader({ sessionId, groupId, index, maximized }: PaneHeaderProps) {
  const meta = useApp(selectSessionMeta(sessionId));
  const rt = useRuntimeView(sessionId);
  const profileId = meta?.profileId ?? null;
  const profile = useApp((s) => (profileId ? s.accounts.find((p) => p.id === profileId) : undefined));
  const [editing, setEditing] = useState(false);
  const menu = useContextMenu();
  const menuWasOpen = useRef(false);
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

  const menuItems = () => buildSessionMenu(sessionId, { surface: "header", onRename: () => setEditing(true) });

  if (!meta) return <div className="pane-header" />;

  const status = statusInfo(rt);
  const cwdBase = basename(meta.cwd);
  const branch = meta.worktree ? (meta.worktree.branch ?? basename(meta.worktree.path)) : null;
  const profileWarn = !!profile && !isSignedIn(profile);

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
        menu.open(e, menuItems());
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
          className={`pane-icon-btn${menu.isOpen ? " is-active" : ""}`}
          title="More"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menu.isOpen}
          onMouseDown={() => (menuWasOpen.current = menu.isOpen)}
          onClick={(e) => {
            if (!menuWasOpen.current) menu.openAt(e.currentTarget, menuItems());
            menuWasOpen.current = false;
          }}
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
      {menu.element}
    </div>
  );
});
