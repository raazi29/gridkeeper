// Lead control, inside Mission Control's lead box: the user decides how much the lead may coordinate the team
// in this project folder — off · advisor · autopilot — plus auto-review, output sharing, pause, and the list of
// instructions waiting for the user (from → to, action, editable text, Send / Dismiss). Also renders the
// autopilot badge in Mission Control's header (portal) and, via AutopilotChip, in the main status bar, so
// autopilot is visible and pausable with Mission Control closed. The engine is actions/leadControl.ts.

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { briefLeads, dismissProposal, sendProposal, setAutopilotPaused, setControlMode, setControlOptions } from "../../actions/leadControl";
import { channelBriefText } from "../../actions/missionBrief";
import { notify } from "../../actions/notify";
import { t as translate, useT, type MessageKey } from "../../i18n";
import type { SessionId } from "../../lib/types";
import { isLive, selectActiveWorkspace, useApp } from "../../store/appStore";
import { countAutopilot, countQueued, countWaiting, DEFAULT_POLICY, editProposal, useLeadControl, type ControlMode } from "../../store/leadControl";
import { useMission } from "../../store/mission";
import { dirKey } from "../../store/missionDoc";
import { confirmDialog } from "../../store/uiStore";
import "../../styles/leadControl.css";

// Labels and explanations are catalog keys, translated at render.
const MODES: { id: ControlMode; label: MessageKey; explain: MessageKey }[] = [
  { id: "off", label: "lead.mode.off", explain: "lead.explain.off" },
  { id: "advisor", label: "lead.mode.advisor", explain: "lead.explain.advisor" },
  { id: "autopilot", label: "lead.mode.autopilot", explain: "lead.explain.autopilot" },
];

const AUTOPILOT_DETAIL: readonly MessageKey[] = ["lead.autopilot.detail1", "lead.autopilot.detail2", "lead.autopilot.detail3", "lead.autopilot.detail4", "lead.autopilot.detail5"];

/** The confirmation's bullet list, one line per point. */
function autopilotDetail(): string {
  return AUTOPILOT_DETAIL.map((k) => translate(k)).join("\n");
}

function gridkeeperDir(dir: string): string {
  const sep = dir.includes("\\") || !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}.gridkeeper${sep}`;
}

export interface LeadControlProps {
  /** Lead sessions of the active workspace (may be empty). */
  leads: SessionId[];
}

export function LeadControl({ leads }: LeadControlProps) {
  const t = useT();
  const projectDir = useApp((s) => selectActiveWorkspace(s)?.projectDir ?? null);
  const key = projectDir ? dirKey(projectDir) : "";
  const mode = useLeadControl((s) => (s.policies[key] ?? DEFAULT_POLICY).mode);
  const paused = useLeadControl((s) => (s.policies[key] ?? DEFAULT_POLICY).paused);
  const autoReview = useLeadControl((s) => (s.policies[key] ?? DEFAULT_POLICY).autoReview);
  const shareOutput = useLeadControl((s) => (s.policies[key] ?? DEFAULT_POLICY).shareOutput);
  const keys = useLeadControl(useShallow((s) => s.proposals.filter((p) => p.dirKey === key).map((p) => p.key)));
  const queued = useLeadControl((s) => countQueued(s, key));
  const waiting = useLeadControl((s) => countWaiting(s, key));
  const liveLeads = useApp((s) => leads.filter((id) => isLive(s.runtime[id])).length);

  const hint = leads.length === 0 && <div className="lc-hint">{t("lead.assignHint")}</div>;
  if (!projectDir) return leads.length === 0 ? hint || null : <div className="lc-hint">{t("lead.needsFolder")}</div>;
  if (leads.length === 0 && mode === "off") return hint || null;

  const current = MODES.find((m) => m.id === mode) ?? MODES[0];
  const gk = gridkeeperDir(projectDir);

  const choose = async (next: ControlMode) => {
    if (next === mode) return;
    if (next === "autopilot") {
      const pending = useLeadControl.getState().proposals.filter((p) => p.dirKey === key && p.status === "proposal" && (p.action === "message" || p.action === "review") && !p.edited).length;
      const ok = await confirmDialog({
        title: t("lead.autopilot.confirmTitle"),
        message: pending ? t("lead.autopilot.confirmMessagePending", { count: pending }) : t("lead.autopilot.confirmMessage"),
        detail: autopilotDetail(),
        confirmLabel: t("lead.autopilot.confirm"),
        danger: true,
      });
      if (!ok) return;
    }
    setControlMode(projectDir, next);
  };

  const briefLead = async () => {
    // Agent-facing: stays English (typed into agents / written to files). Shown as the dialog's detail.
    const text = channelBriefText("lead", `${gk}mission.md`);
    const ok = await confirmDialog({
      title: t("lead.brief.title"),
      message: t("lead.brief.message"),
      detail: text,
      confirmLabel: t("lead.brief.send"),
    });
    if (!ok) return;
    const ids = leads.filter((id) => isLive(useApp.getState().runtime[id]));
    const r = await briefLeads(ids, text);
    if (r.sent.length)
      notify(
        r.skipped.length ? "warn" : "info",
        r.skipped.length ? t("lead.brief.sentSkipped", { names: r.sent.join(", "), skipped: r.skipped.join(", ") }) : t("lead.brief.sent", { names: r.sent.join(", ") }),
      );
    else notify("warn", r.skipped.length ? t("lead.brief.notSent", { names: r.skipped.join(", ") }) : t("lead.brief.noLead"));
  };

  return (
    <div className={`lc is-${mode}${paused ? " is-paused" : ""}`} role="group" aria-label={t("lead.aria")}>
      {hint}
      <div className="lc-row">
        <span className="mc-micro lc-label">{t("lead.label")}</span>
        <div className="lc-seg" role="radiogroup" aria-label={t("lead.modeAria")}>
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={mode === m.id}
              className={`lc-seg-btn is-${m.id}${mode === m.id ? " is-on" : ""}`}
              title={t(m.explain)}
              onClick={() => void choose(m.id)}
            >
              {t(m.label)}
            </button>
          ))}
        </div>
        <span className="lc-explain" title={t(current.explain)}>
          {mode === "autopilot" && paused ? t("lead.pausedExplain") : t(current.explain)}
        </span>
      </div>
      {mode !== "off" && (
        <div className="lc-row lc-options">
          <label className="lc-check" title={t("lead.reviewTip")}>
            <input type="checkbox" checked={autoReview} onChange={(e) => setControlOptions(projectDir, { autoReview: e.currentTarget.checked })} />
            {t("lead.autoReview")}
          </label>
          <label className="lc-check" title={t("lead.shareTip")}>
            <input type="checkbox" checked={shareOutput} onChange={(e) => setControlOptions(projectDir, { shareOutput: e.currentTarget.checked })} />
            {t("lead.shareOutput")}
          </label>
          {mode === "autopilot" && (
            <button
              type="button"
              className={`mc-btn${paused ? " is-primary" : ""}`}
              title={paused ? t("lead.resumeTitle") : t("lead.pauseTitle")}
              onClick={() => setControlOptions(projectDir, { paused: !paused })}
            >
              {paused ? t("lead.resumeAutopilot") : t("lead.pause")}
            </button>
          )}
          <span className="mc-spacer" />
          <span className="lc-files" title={t("lead.filesTitle", { dir: gk })}>
            team.md · outbox
          </span>
          <button
            type="button"
            className="mc-btn"
            disabled={liveLeads === 0}
            title={liveLeads ? t("lead.briefTitle") : t("lead.notRunning")}
            onClick={() => void briefLead()}
          >
            {t("lead.briefButton")}
          </button>
        </div>
      )}
      {keys.length > 0 ? (
        <ul className="lc-props" aria-label={t("lead.props.aria")}>
          {keys.map((k) => (
            <ProposalRow key={k} pkey={k} />
          ))}
        </ul>
      ) : (
        mode !== "off" && <div className="lc-empty">{t("lead.empty")}</div>
      )}
      <HeaderBadge dir={projectDir} mode={mode} paused={paused} queued={queued} waiting={waiting} />
    </div>
  );
}

function ProposalRow({ pkey }: { pkey: string }) {
  const t = useT();
  const p = useLeadControl((s) => s.proposals.find((x) => x.key === pkey));
  const [pending, setPending] = useState(false);
  if (!p) return null;
  const typed = p.action === "message" || p.action === "review";
  const busy = p.busy || pending;
  const canSend = !busy && p.targets.length > 0 && (!typed || p.text.trim().length > 0);
  const run = async (fn: () => Promise<{ ok: boolean; reason?: string }>, toast: boolean) => {
    setPending(true);
    try {
      const r = await fn();
      if (!r.ok && toast && r.reason) notify("warn", r.reason);
    } finally {
      setPending(false);
    }
  };
  const fromText = p.lead && p.lead !== p.from && p.source === "outbox" ? `${p.from} (${p.lead})` : p.from;
  return (
    <li className={`lc-prop is-${p.status}${busy ? " is-busy" : ""}`}>
      <div className="lc-prop-head">
        <span className="lc-prop-from" title={p.source === "review" ? t("lead.prop.fromReview") : t("lead.prop.fromOutbox")}>
          {fromText}
        </span>
        <span className="lc-arrow">→</span>
        <span className="lc-prop-to" title={p.to.length ? t("lead.prop.toTitle", { names: p.to.join(", ") }) : undefined}>
          {p.targetLabel}
        </span>
        <span className={`lc-action is-${p.action}`}>{t("lead.prop.action", { action: p.action })}</span>
        {p.status === "queued" && <span className="lc-tag is-auto">{t("lead.prop.queued")}</span>}
        {p.delivered.length > 0 && p.source === "outbox" && <span className="lc-tag">{t("lead.prop.delivered", { count: p.delivered.length })}</span>}
        <span className="mc-spacer" />
        {p.file && (
          <span className="lc-file" title={`.gridkeeper/outbox/${p.file}`}>
            {p.file}
          </span>
        )}
      </div>
      {typed ? (
        <textarea
          className="lc-text"
          value={p.text}
          rows={Math.min(6, Math.max(2, Math.ceil(p.text.length / 90)))}
          spellCheck={false}
          disabled={busy}
          aria-label={t("lead.prop.textAria", { targets: p.targetLabel })}
          onChange={(e) => editProposal(p.key, e.target.value)}
        />
      ) : (
        <div className="lc-life">
          {p.text ? t("lead.prop.lifeReason", { action: p.action, targets: p.targetLabel, reason: p.text }) : t("lead.prop.life", { action: p.action, targets: p.targetLabel })}
        </div>
      )}
      {p.warnings.map((w, i) => (
        <div key={i} className="lc-warn">
          ⚠ {w}
        </div>
      ))}
      {p.reason && (
        <div className="lc-reason">{p.status === "queued" ? t("lead.prop.waiting", { reason: p.reason }) : t("lead.prop.notSent", { reason: p.reason })}</div>
      )}
      <div className="lc-prop-actions">
        <button
          type="button"
          className="mc-btn is-primary"
          disabled={!canSend}
          title={typed ? t("lead.prop.sendTitle") : t("lead.prop.confirmTitle", { action: p.action })}
          onClick={() => void run(() => sendProposal(p.key), !typed)}
        >
          {busy ? t("lead.prop.sending") : typed ? (p.status === "queued" ? t("lead.prop.sendNow") : t("lead.prop.send")) : t("lead.prop.lifeButton", { action: p.action })}
        </button>
        <button
          type="button"
          className="mc-btn"
          disabled={busy}
          title={p.file ? t("lead.prop.dismissFileTitle") : t("lead.prop.dismissReviewTitle")}
          onClick={() => void run(() => dismissProposal(p.key), true)}
        >
          {t("lead.prop.dismiss")}
        </button>
      </div>
    </li>
  );
}

/**
 * Autopilot / pending badge in Mission Control's header strip: a slot inserted next to the header's actions
 * (found from this component's own marker element; an ancestor's ref is not attached yet when a child's
 * layout effect runs).
 */
function HeaderBadge({ dir, mode, paused, queued, waiting }: { dir: string; mode: ControlMode; paused: boolean; queued: number; waiting: number }) {
  const t = useT();
  const marker = useRef<HTMLSpanElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const head = marker.current?.closest(".mc")?.querySelector<HTMLElement>(".mc-head");
    if (!head) return;
    const el = document.createElement("span");
    el.className = "lc-head-slot";
    const actions = Array.from(head.children).find((c) => c.classList.contains("mc-head-actions")) ?? null;
    head.insertBefore(el, actions);
    setSlot(el);
    return () => {
      el.remove();
      setSlot(null);
    };
  }, []);
  const anchor = <span ref={marker} hidden />;
  if (!slot || (mode !== "autopilot" && waiting === 0)) return anchor;
  const auto = mode === "autopilot";
  const badge = createPortal(
    <span className={`lc-head-badge${auto && !paused ? " is-auto" : ""}`} role="status">
      {auto
        ? [
            paused ? t("lead.badge.autopilotPaused") : t("lead.badge.autopilot"),
            ...(queued > 0 ? [t("lead.status.queued", { count: queued })] : []),
            ...(waiting > 0 ? [t("lead.status.toReview", { count: waiting })] : []),
          ].join(" · ")
        : t("lead.badge.control", { count: waiting })}
      {auto && (
        <button type="button" className="lc-head-btn" title={paused ? t("lead.resumeTitle") : t("lead.badge.pauseTitle")} onClick={() => setControlOptions(dir, { paused: !paused })}>
          {paused ? t("lead.resume") : t("lead.pause")}
        </button>
      )}
    </span>,
    slot,
  );
  return (
    <>
      {anchor}
      {badge}
    </>
  );
}

/** Status bar chip: visible while any controlled workspace is in autopilot (also with Mission Control closed). */
export function AutopilotChip() {
  const t = useT();
  const total = useLeadControl((s) => countAutopilot(s, false));
  const running = useLeadControl((s) => countAutopilot(s, true));
  const queued = useLeadControl((s) => countQueued(s));
  const waiting = useLeadControl((s) => countWaiting(s));
  if (total === 0) return null;
  const paused = running === 0;
  const open = () => {
    const s = useApp.getState();
    const active = s.persisted.workspaces.find((w) => w.id === s.persisted.activeWorkspaceId);
    const lc = useLeadControl.getState();
    const isAuto = (dir: string | null) => !!dir && lc.policies[dirKey(dir)]?.mode === "autopilot" && !!lc.active[dirKey(dir)];
    if (!isAuto(active?.projectDir ?? null)) {
      const target = s.persisted.workspaces.find((w) => isAuto(w.projectDir));
      if (target) s.setActiveWorkspace(target.id);
    }
    useMission.getState().toggle(true);
  };
  return (
    <>
      <button
        type="button"
        className={`sb-item sb-btn lc-sb${paused ? " is-paused" : " is-auto"}`}
        title={paused ? t("lead.chip.titlePaused") : t("lead.chip.title")}
        onClick={open}
      >
        <span className="lc-sb-glyph">◆</span>
        {[
          paused ? t("lead.chip.autopilotPaused") : t("lead.chip.autopilot"),
          t("lead.status.queued", { count: queued }),
          ...(waiting > 0 ? [t("lead.status.toReview", { count: waiting })] : []),
        ].join(" · ")}
      </button>
      <button type="button" className="sb-item sb-btn lc-sb-pause" title={paused ? t("lead.chip.resumeTitle") : t("lead.chip.pauseTitle")} onClick={() => setAutopilotPaused(!paused)}>
        {paused ? t("lead.resume") : t("lead.pause")}
      </button>
      <span className="sb-div" />
    </>
  );
}
