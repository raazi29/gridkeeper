// One pane: header + terminal body + state overlays (or a browser pane, see BrowserPane.tsx).
// Re-renders only when this session's metadata, coarse runtime state, focus or hidden flag change —
// never on terminal output.

import { memo, useCallback, useEffect, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import { closeSession, restartSession, showView, startSession } from "../actions/sessions";
import type { SessionId } from "../lib/types";
import { selectSessionMeta, useApp } from "../store/appStore";
import { TerminalView } from "../terminal/TerminalView";
import { disposeTerminal, focusTerminal } from "../terminal/registry";
import { PaneFindBar } from "../components/FindBar";
import { PaneHeader, useRuntimeView } from "./PaneHeader";
import { currentPaneDrag, endPaneDrag } from "./paneDrag";
import { BrowserPane } from "./BrowserPane";
import { useSaberBlade, type BladeState } from "./saberBlade";
import { useT } from "../i18n";
import { HeldLaunchHint } from "../components/MemoryGuard";
import { useMemGuard } from "../store/memguard";

export interface PaneProps {
  sessionId: SessionId;
  groupId: string;
  index: number;
  count: number;
  /** Group on screen. */
  visible: boolean;
  maximized: boolean;
}

/** A pane of either kind: terminal session or browser page. */
export const Pane = memo(function Pane(props: PaneProps) {
  const browser = useApp((s) => selectSessionMeta(props.sessionId)(s)?.kind === "browser");
  return browser ? <BrowserPane {...props} /> : <TerminalPane {...props} />;
});

/** Drag & drop target for reordering panes within a group (shared by both pane kinds). */
export function usePaneDrop(sessionId: SessionId, groupId: string) {
  const [dropTarget, setDropTarget] = useState(false);
  const acceptsDrag = (e: DragEvent) => {
    const d = currentPaneDrag();
    return !!d && d.groupId === groupId && d.sessionId !== sessionId && e.dataTransfer.types.includes("application/x-gridkeeper-pane");
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!acceptsDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!dropTarget) setDropTarget(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDropTarget(false);
    const d = currentPaneDrag();
    endPaneDrag();
    if (!d || d.groupId !== groupId || d.sessionId === sessionId) return;
    e.preventDefault();
    const ids = findIds(groupId);
    const from = ids.indexOf(d.sessionId);
    const to = ids.indexOf(sessionId);
    if (from >= 0 && to >= 0) useApp.getState().moveSession(groupId, from, to);
  };
  return { dropTarget, onDragOver, onDragLeave, onDrop };
}

const TerminalPane = memo(function TerminalPane({ sessionId, groupId, index, count, visible, maximized }: PaneProps) {
  const t = useT();
  const focused = useApp((s) => s.focusedSessionId === sessionId);
  const hidden = useApp((s) => !!s.hiddenViews[sessionId]);
  const agent = useApp((s) => selectSessionMeta(sessionId)(s)?.agent);
  const resumeOnRestore = useApp((s) => selectSessionMeta(sessionId)(s)?.resumeOnRestore);
  const rt = useRuntimeView(sessionId);
  const { dropTarget, onDragOver, onDragLeave, onDrop } = usePaneDrop(sessionId, groupId);
  const alive = rt.state === "starting" || rt.state === "running";
  // Launch held by the low-memory guard: the footer explains it, so no Start overlay meanwhile.
  const held = useMemGuard((s) => s.held.some((h) => h.id === sessionId));
  const blade = useSaberBlade(sessionId, focused, alive, visible && !hidden);

  // Hidden view: free the terminal entirely (Rust keeps the process + bounded buffer; Show replays it).
  useEffect(() => {
    if (hidden) disposeTerminal(sessionId);
  }, [hidden, sessionId]);

  const focus = useCallback(
    (e: MouseEvent) => {
      if (useApp.getState().focusedSessionId !== sessionId) useApp.getState().setFocused(sessionId);
      const target = e.target as HTMLElement;
      // Keyboard focus to the terminal, except for controls and the terminal itself (xterm focuses itself).
      if (target.closest("input, button, textarea, [role=menu], .xterm, .pane-name")) return;
      requestAnimationFrame(() => {
        if (document.activeElement?.tagName !== "INPUT") focusTerminal(sessionId);
      });
    },
    [sessionId],
  );

  const start = useCallback(
    (fresh: boolean) => {
      focusTerminal(sessionId);
      void startSession(sessionId, fresh ? { mode: "none" } : (resumeOnRestore ?? { mode: "none" }));
    },
    [resumeOnRestore, sessionId],
  );

  const isAgent = agent === "claude" || agent === "codex";

  let overlay: ReactNode = null;
  if (hidden) {
    overlay = (
      <div className="pane-overlay pane-overlay--solid">
        <div className="pane-overlay-text">{t("pane.hiddenView")}</div>
        <button type="button" className="lay-btn lay-btn--ghost" onClick={() => showView(sessionId)}>
          {t("pane.show")}
        </button>
      </div>
    );
  } else if (rt.state === "idle" && !held) {
    overlay = (
      <div className="pane-overlay pane-overlay--delayed">
        <div className="pane-overlay-actions">
          <button type="button" className="lay-btn lay-btn--primary" onClick={() => start(false)}>
            {t("common.start")}
          </button>
          {isAgent && (
            <button type="button" className="lay-btn lay-btn--ghost" onClick={() => start(true)}>
              {t("pane.startFresh")}
            </button>
          )}
        </div>
      </div>
    );
  } else if (rt.state === "failed") {
    const cwdGone = !!rt.message && rt.message.includes("Working directory");
    overlay = (
      <div className="pane-overlay pane-overlay--dim">
        <div className="pane-error">
          <div className="pane-error-title">{cwdGone ? t("pane.cwdUnavailable") : t("pane.failedToStart")}</div>
          {rt.message && <div className="pane-error-message">{rt.message}</div>}
          <div className="pane-overlay-actions">
            <button type="button" className="lay-btn lay-btn--primary" onClick={() => start(false)}>
              {t("common.retry")}
            </button>
            <button type="button" className="lay-btn lay-btn--ghost" onClick={() => void closeSession(sessionId)}>
              {t("common.close")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="pane"
      data-focused={focused || undefined}
      data-alive={alive || undefined}
      data-drop-target={dropTarget || undefined}
      onMouseDownCapture={focus}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <PaneHeader sessionId={sessionId} groupId={groupId} index={index} count={count} maximized={maximized} />
      <PaneBlade blade={blade} />
      <div className="pane-body">
        {!hidden && <TerminalView sessionId={sessionId} visible={visible} />}
        {!hidden && <PaneFindBar sessionId={sessionId} />}
        {overlay}
      </div>
      {rt.state === "exited" && !hidden && (
        <div className="pane-exitbar">
          <span className={`pane-exitbar-label${rt.code !== null && rt.code !== 0 ? " is-error" : ""}`}>
            {rt.code === null ? t("session.state.exited") : t("pane.status.exitedCode", { code: rt.code })}
          </span>
          <span className="pane-exitbar-sep">·</span>
          <button type="button" className="pane-link" onClick={() => void restartSession(sessionId, { mode: "none" })}>
            {t("common.restart")}
          </button>
          {isAgent && (
            <>
              <span className="pane-exitbar-sep">·</span>
              <button type="button" className="pane-link" onClick={() => void restartSession(sessionId, { mode: "continue" })}>
                {t("pane.resume")}
              </button>
            </>
          )}
          <span className="pane-exitbar-sep">·</span>
          <button type="button" className="pane-link" onClick={() => void closeSession(sessionId)}>
            {t("common.close")}
          </button>
        </div>
      )}
      {!hidden && <SilentHint sessionId={sessionId} />}
      {!hidden && <HeldLaunchHint sessionId={sessionId} />}
      {dropTarget && <div className="pane-drop-indicator" />}
    </div>
  );
});

/** The saber blade along the top edge (styled only while saber effects are on; see styles/saber.css). */
export function PaneBlade({ blade }: { blade: BladeState }) {
  return <div key={blade.key} className="pane-blade" data-anim={blade.anim ?? undefined} onAnimationEnd={blade.onAnimationEnd} aria-hidden="true" />;
}

const SILENT_MS = 12000;

/** Watchdog hint: a running session that has produced no output at all for a while is probably stuck. */
const SilentHint = memo(function SilentHint({ sessionId }: { sessionId: SessionId }) {
  const t = useT();
  const silentSince = useApp((s) => {
    const r = s.runtime[sessionId];
    return r && r.state.state === "running" && r.bytesOut === 0 ? (r.startedAt ?? null) : null;
  });
  const [show, setShow] = useState(false);
  useEffect(() => {
    setShow(false);
    if (!silentSince) return;
    const wait = Math.max(0, SILENT_MS - (Date.now() - Date.parse(silentSince)));
    const timer = window.setTimeout(() => setShow(true), wait);
    return () => window.clearTimeout(timer);
  }, [silentSince]);
  if (!show || !silentSince) return null;
  return (
    <div className="pane-exitbar">
      <span className="pane-exitbar-label">{t("pane.silent", { seconds: Math.round(SILENT_MS / 1000) })}</span>
      <span className="pane-exitbar-sep">·</span>
      <button type="button" className="pane-link" onClick={() => void restartSession(sessionId, { mode: "none" })}>
        {t("common.restart")}
      </button>
    </div>
  );
});

function findIds(groupId: string): string[] {
  for (const w of useApp.getState().persisted.workspaces)
    for (const g of w.groups) if (g.id === groupId) return g.sessionIds;
  return [];
}
