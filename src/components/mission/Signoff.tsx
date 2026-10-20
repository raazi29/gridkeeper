// Mission Control's SIGN-OFF dock: sessions that finished or need you, each as a card with the evidence
// of what was done — branch, commits vs base, files / lines changed, uncommitted leftovers, last commit —
// from read-only git (fetched when the card appears and when its session turns done / waiting; no timer).
// Actions: jump (click), run tests (badge + log; components/testrun), merge… (merge assistant dialog;
// components/merge), review diff (Changes drawer focused on the worktree), hand off… (dialog with an
// editable line; nothing is typed into any agent until the user presses Send), context menu.

import { isMac } from "../../lib/platform";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  closeHandoff,
  evidencePath,
  handoffMenuItems,
  handoffTargetCount,
  pathKey,
  refreshBranchSummary,
  scheduleBranchSummary,
  sendHandoff,
  useBranchSummaries,
  useHandoff,
  type HandoffRequest,
  type SummaryEntry,
} from "../../actions/handoff";
import { notify } from "../../actions/notify";
import { useT } from "../../i18n";
import type { SessionId } from "../../lib/types";
import { isLive, useApp } from "../../store/appStore";
import { useAttention } from "../../store/attention";
import { useMission } from "../../store/mission";
import { useUi } from "../../store/uiStore";
import { Button } from "../ui/Button";
import { useContextMenu } from "../ui/Menu";
import { Modal } from "../ui/Modal";
import { LAMP_TEXT, sessionStatus } from "./derive";
import { RoleTag, roleStyle } from "./RoleTag";
import { summaryParts } from "./signoffModel";
import { runTestsForSession } from "../../store/testrun";
import { TestBadge } from "../testrun/TestBadge";
import { openMergeDialog } from "../merge/mergeStore";
import "../../styles/signoff.css";

type MenuEvent = { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void };

interface SignoffProps {
  ids: SessionId[];
  onJump: (id: SessionId) => void;
  onMenu: (e: MenuEvent, id: SessionId) => void;
}

export function SignoffNode({ ids, onJump, onMenu }: SignoffProps) {
  const t = useT();
  return (
    <div data-node="signoff" className={`mc-node mc-signoff so-node${ids.length ? " is-solid" : ""}`}>
      <span className="mc-node-label">{t("signoff.label")}</span>
      <span className="mc-node-label mc-node-label-right">{t("signoff.count", { count: ids.length })}</span>
      {ids.length === 0 ? (
        <div className="mc-empty">{t("signoff.empty")}</div>
      ) : (
        <div className="so-list">
          {ids.map((id) => (
            <SignoffCard key={id} id={id} onJump={onJump} onMenu={onMenu} />
          ))}
        </div>
      )}
      <HandoffDialogHost />
    </div>
  );
}

function SignoffCard({ id, onJump, onMenu }: { id: SessionId; onJump: (id: SessionId) => void; onMenu: (e: MenuEvent, id: SessionId) => void }) {
  const t = useT();
  const name = useApp((s) => s.persisted.sessions.find((x) => x.id === id)?.name);
  const role = useApp((s) => s.persisted.sessions.find((x) => x.id === id)?.role ?? null);
  const path = useApp((s) => evidencePath(s.persisted.sessions.find((x) => x.id === id)));
  const targets = useApp((s) => handoffTargetCount(id, s));
  const rt = useApp((s) => s.runtime[id]);
  const a = useAttention((s) => s.sessions[id]);
  const entry = useBranchSummaries((s) => (path ? s.byPath[pathKey(path)] : undefined));
  const menu = useContextMenu();

  // Evidence: once when the card appears (or its folder changes)…
  useEffect(() => {
    if (path) void refreshBranchSummary(path);
  }, [path]);
  // …and again (debounced) when the session turns done / waiting while shown. No polling.
  useEffect(() => {
    if (!path) return;
    return useAttention.subscribe((s, prev) => {
      const next = s.sessions[id]?.state;
      if (next !== prev.sessions[id]?.state && (next === "done" || next === "waiting")) scheduleBranchSummary(path);
    });
  }, [id, path]);

  if (name === undefined) return null;
  const st = sessionStatus(rt, a);
  const waiting = st.lamp === "waiting";
  const isRepo = !!entry?.summary?.isRepo;
  const mergeable = isRepo && !!entry?.summary?.branch && entry.summary.branch !== entry.summary.base && entry.summary.ahead > 0;

  const reviewDiff = () => {
    if (!path) return;
    useMission.getState().toggle(false);
    useUi.getState().openChanges(path);
  };

  return (
    <div
      className={`so-card is-${st.lamp}`}
      style={roleStyle(role)}
      data-signoff={id}
      onContextMenu={(e) => {
        // React bubbles events out of portals (the hand-off menu / dialog): only the card's own DOM counts.
        if (e.currentTarget.contains(e.target as Node)) onMenu(e, id);
      }}
    >
      <div className="so-row">
        <button type="button" className="so-jump" title={t("signoff.jumpTitle", { status: a?.lastMessage ?? LAMP_TEXT[st.lamp] })} onClick={() => onJump(id)}>
          <span className="mc-chip-sq" />
          <span className="so-name">{name}</span>
          <span className="mc-bracket">[ {waiting ? t("signoff.needsYou") : t("signoff.done")} ]</span>
          {waiting && <span className="mc-chip-go">{t("signoff.answer")}</span>}
        </button>
        <RoleTag role={role} bare />
        {a?.lastMessage && (
          <span className="so-msg" title={a.lastMessage}>
            {a.lastMessage}
          </span>
        )}
        <span className="mc-spacer" />
        <TestBadge path={path} />
        <span className="so-actions">
          <button type="button" className="mc-btn" disabled={!path} title={t("signoff.runTestsTitle")} onClick={() => void runTestsForSession(id)}>
            {t("signoff.runTests")}
          </button>
          <button
            type="button"
            className="mc-btn"
            disabled={!mergeable}
            title={mergeable ? t("signoff.mergeTitle") : t("signoff.mergeNone")}
            onClick={() => openMergeDialog(id)}
          >
            {t("signoff.merge")}
          </button>
          <button
            type="button"
            className="mc-btn"
            disabled={!isRepo}
            title={isRepo ? t("signoff.reviewTitle") : t("signoff.notRepo")}
            onClick={reviewDiff}
          >
            {t("signoff.review")}
          </button>
          <button
            type="button"
            className="mc-btn"
            disabled={targets === 0}
            aria-haspopup="menu"
            aria-expanded={menu.isOpen}
            title={targets ? t("signoff.handoffTitle") : t("signoff.handoffNone")}
            onClick={(e) => menu.openAt(e.currentTarget, handoffMenuItems(id))}
          >
            {t("signoff.handoff")}
          </button>
        </span>
      </div>
      {path && <Evidence entry={entry} />}
      {menu.element}
    </div>
  );
}

/** The terminal-style evidence line under a card. Non-repositories show nothing. */
function Evidence({ entry }: { entry: SummaryEntry | undefined }) {
  const t = useT();
  if (!entry)
    return (
      <div className="so-evidence is-loading" aria-live="polite">
        {t("signoff.readingGit")}
      </div>
    );
  if (entry.error)
    return (
      <div className="so-evidence is-error" title={entry.error}>
        {t("signoff.gitError", { error: entry.error })}
      </div>
    );
  const parts = summaryParts(entry.summary, Date.now());
  if (!parts.length) return null;
  return (
    <div className="so-evidence">
      {parts.map((p, i) => (
        <span key={p.kind} className={`so-part is-${p.kind}`} title={p.title}>
          {i > 0 && <span className="so-sep"> · </span>}
          {p.text}
        </span>
      ))}
    </div>
  );
}

// ---- hand-off dialog ---------------------------------------------------------------------------

function HandoffDialogHost() {
  const req = useHandoff((s) => s.request);
  if (!req) return null;
  return <HandoffDialog key={`${req.fromId}>${req.targetId}`} req={req} />;
}

function HandoffDialog({ req }: { req: HandoffRequest }) {
  const t = useT();
  const [text, setText] = useState(req.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targetWaiting = useAttention((s) => s.sessions[req.targetId]?.state === "waiting");
  const targetLive = useApp((s) => isLive(s.runtime[req.targetId]));
  const mc = useRef<HTMLElement | null>(null);

  // The Modal restores focus to the focused terminal on close; Mission Control is still open above it,
  // so give focus back to the Mission Control panel instead (after the Modal's own restore frame).
  useLayoutEffect(() => {
    mc.current = document.querySelector<HTMLElement>(".mc");
    return () => {
      const el = mc.current;
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (el?.isConnected && !document.activeElement?.closest(".modal")) el.focus();
        }),
      );
    };
  }, []);

  const blocked = !targetLive
    ? t("signoff.targetNotRunning", { name: req.targetName })
    : targetWaiting
      ? t("signoff.targetWaiting", { name: req.targetName })
      : null;

  const send = async () => {
    if (busy || blocked || !text.trim()) return;
    setBusy(true);
    setError(null);
    const r = await sendHandoff(req.fromId, req.targetId, text);
    setBusy(false);
    if (r.ok) {
      notify("info", t("signoff.handedOff", { name: req.targetName }));
      closeHandoff();
    } else setError(r.reason);
  };

  return (
    <Modal
      title={t("signoff.dialogTitle", { name: req.targetName })}
      onClose={closeHandoff}
      width={620}
      className="so-handoff"
      footer={
        <>
          <span className="so-handoff-note">{t("signoff.note", { name: req.targetName })}</span>
          <Button onClick={closeHandoff}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || !!blocked || !text.trim()} onClick={() => void send()}>
            {busy ? t("signoff.sending") : t("signoff.send")}
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="so-handoff-route mono">
          <span>{req.fromName}</span>
          <span className="so-sep">→</span>
          <span>{req.targetName}</span>
          <RoleTag role={req.targetRole} />
        </div>
        <textarea
          className="so-handoff-text"
          data-autofocus
          rows={5}
          spellCheck={false}
          value={text}
          aria-label={t("signoff.textAria")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (isMac ? e.metaKey : e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="so-handoff-hint">{t("signoff.hint", { keys: isMac ? "⌘↩" : "Ctrl+Enter" })}</div>
        {blocked && <div className="callout so-callout-warn">{blocked}</div>}
        {error && <div className="callout is-error">{error}</div>}
      </div>
    </Modal>
  );
}
