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
import type { SessionId } from "../../lib/types";
import { isLive, selectActiveWorkspace, useApp } from "../../store/appStore";
import { countAutopilot, countQueued, countWaiting, DEFAULT_POLICY, editProposal, useLeadControl, type ControlMode } from "../../store/leadControl";
import { useMission } from "../../store/mission";
import { dirKey } from "../../store/missionDoc";
import { confirmDialog } from "../../store/uiStore";
import "../../styles/leadControl.css";

const MODES: { id: ControlMode; label: string; explain: string }[] = [
  { id: "off", label: "off", explain: "The lead is only a label: .gridkeeper/outbox is ignored and no team file is written." },
  { id: "advisor", label: "advisor", explain: "The lead sees the team in .gridkeeper/team.md; every instruction it writes waits here for your Send." },
  { id: "autopilot", label: "autopilot", explain: "Messages and review requests are typed in when the target is idle; stop / restart still wait for you." },
];

const AUTOPILOT_DETAIL = [
  "• message / review instructions from .gridkeeper/outbox/ are typed into the target and submitted with Enter — only while it is idle or done and not asking anything (never into a prompt or a permission question)",
  "• at most 1 automatic delivery per agent every 20 s and 8 per minute; an item that finds no safe moment within 10 minutes comes back here for you",
  "• stop / restart are never automatic: they stay here for you to confirm",
  "• with auto-review on, a teammate's finished work is sent to the lead for review",
  "• every automatic send is logged in the activity log",
].join("\n");

const SHARE_TIP =
  "Adds the last 15 lines of each terminal to .gridkeeper/team.md so the lead can follow along. Output may contain secrets (Gridkeeper masks the ones it recognizes); team.md lives in the git-ignored .gridkeeper folder.";
const REVIEW_TIP = "When a teammate finishes (new commits on its branch, or its task marked [x]), ask the lead to review it. Once per commit.";

function gridkeeperDir(dir: string): string {
  const sep = dir.includes("\\") || !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}.gridkeeper${sep}`;
}

export interface LeadControlProps {
  /** Lead sessions of the active workspace (may be empty). */
  leads: SessionId[];
}

export function LeadControl({ leads }: LeadControlProps) {
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

  const hint = leads.length === 0 && <div className="lc-hint">assign a lead to let it coordinate the team</div>;
  if (!projectDir) return leads.length === 0 ? hint || null : <div className="lc-hint">lead control needs a project folder (see the mission board)</div>;
  if (leads.length === 0 && mode === "off") return hint || null;

  const current = MODES.find((m) => m.id === mode) ?? MODES[0];
  const gk = gridkeeperDir(projectDir);

  const choose = async (next: ControlMode) => {
    if (next === mode) return;
    if (next === "autopilot") {
      const pending = useLeadControl.getState().proposals.filter((p) => p.dirKey === key && p.status === "proposal" && (p.action === "message" || p.action === "review") && !p.edited).length;
      const ok = await confirmDialog({
        title: "Turn on autopilot for this project?",
        message: `Gridkeeper will deliver the lead's instructions without asking you first:${pending ? ` ${pending} waiting instruction${pending === 1 ? "" : "s"} will be delivered automatically too.` : ""} Pause any time here or in the status bar.`,
        detail: AUTOPILOT_DETAIL,
        confirmLabel: "Turn on autopilot",
        danger: true,
      });
      if (!ok) return;
    }
    setControlMode(projectDir, next);
  };

  const briefLead = async () => {
    const text = channelBriefText("lead", `${gk}mission.md`);
    const ok = await confirmDialog({
      title: "Tell the lead how to coordinate?",
      message: "This line is typed into the running lead and submitted with Enter. A lead that is asking you something is skipped.",
      detail: text,
      confirmLabel: "Send",
    });
    if (!ok) return;
    const ids = leads.filter((id) => isLive(useApp.getState().runtime[id]));
    const r = await briefLeads(ids, text);
    if (r.sent.length) notify(r.skipped.length ? "warn" : "info", `Lead briefed: ${r.sent.join(", ")}${r.skipped.length ? ` · skipped (asking something): ${r.skipped.join(", ")}` : ""}`);
    else notify("warn", r.skipped.length ? `Not sent: ${r.skipped.join(", ")} is asking something — answer it first` : "No lead is running");
  };

  return (
    <div className={`lc is-${mode}${paused ? " is-paused" : ""}`} role="group" aria-label="Lead control">
      {hint}
      <div className="lc-row">
        <span className="mc-micro lc-label">lead control</span>
        <div className="lc-seg" role="radiogroup" aria-label="How much the lead may do">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={mode === m.id}
              className={`lc-seg-btn is-${m.id}${mode === m.id ? " is-on" : ""}`}
              title={m.explain}
              onClick={() => void choose(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <span className="lc-explain" title={current.explain}>
          {mode === "autopilot" && paused ? "Autopilot is paused: every instruction waits here for your Send until you resume." : current.explain}
        </span>
      </div>
      {mode !== "off" && (
        <div className="lc-row lc-options">
          <label className="lc-check" title={REVIEW_TIP}>
            <input type="checkbox" checked={autoReview} onChange={(e) => setControlOptions(projectDir, { autoReview: e.currentTarget.checked })} />
            auto-review
          </label>
          <label className="lc-check" title={SHARE_TIP}>
            <input type="checkbox" checked={shareOutput} onChange={(e) => setControlOptions(projectDir, { shareOutput: e.currentTarget.checked })} />
            share recent output with the lead
          </label>
          {mode === "autopilot" && (
            <button
              type="button"
              className={`mc-btn${paused ? " is-primary" : ""}`}
              title={paused ? "Deliver automatically again" : "Stop automatic delivery (instructions wait for your Send) until you resume"}
              onClick={() => setControlOptions(projectDir, { paused: !paused })}
            >
              {paused ? "resume autopilot" : "pause"}
            </button>
          )}
          <span className="mc-spacer" />
          <span className="lc-files" title={`${gk}team.md (generated) · ${gk}outbox\\ (instructions)`}>
            team.md · outbox
          </span>
          <button
            type="button"
            className="mc-btn"
            disabled={liveLeads === 0}
            title={liveLeads ? "Type one line into the lead that explains team.md and the outbox (shows it first)" : "The lead is not running"}
            onClick={() => void briefLead()}
          >
            brief lead…
          </button>
        </div>
      )}
      {keys.length > 0 ? (
        <ul className="lc-props" aria-label="Instructions waiting">
          {keys.map((k) => (
            <ProposalRow key={k} pkey={k} />
          ))}
        </ul>
      ) : (
        mode !== "off" && <div className="lc-empty">no instructions waiting — the lead writes them as files in .gridkeeper/outbox/</div>
      )}
      <HeaderBadge dir={projectDir} mode={mode} paused={paused} queued={queued} waiting={waiting} />
    </div>
  );
}

function ProposalRow({ pkey }: { pkey: string }) {
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
        <span className="lc-prop-from" title={p.source === "review" ? "Gridkeeper noticed finished work" : "Self-declared sender of the outbox file"}>
          {fromText}
        </span>
        <span className="lc-arrow">→</span>
        <span className="lc-prop-to" title={p.to.length ? `to: ${p.to.join(", ")}` : undefined}>
          {p.targetLabel}
        </span>
        <span className={`lc-action is-${p.action}`}>{p.action}</span>
        {p.status === "queued" && <span className="lc-tag is-auto">autopilot · queued</span>}
        {p.delivered.length > 0 && p.source === "outbox" && <span className="lc-tag">{p.delivered.length} delivered</span>}
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
          aria-label={`Instruction for ${p.targetLabel}`}
          onChange={(e) => editProposal(p.key, e.target.value)}
        />
      ) : (
        <div className="lc-life">
          {p.action === "stop" ? "Stop" : "Restart"} {p.targetLabel}
          {p.text ? ` — “${p.text}”` : ""}. You confirm each one.
        </div>
      )}
      {p.warnings.map((w, i) => (
        <div key={i} className="lc-warn">
          ⚠ {w}
        </div>
      ))}
      {p.reason && (
        <div className="lc-reason">
          {p.status === "queued" ? "waiting: " : "not sent: "}
          {p.reason}
        </div>
      )}
      <div className="lc-prop-actions">
        <button
          type="button"
          className="mc-btn is-primary"
          disabled={!canSend}
          title={typed ? "Type it into the target and press Enter (refused while the target is asking something)" : `Asks you to confirm the ${p.action} of each target`}
          onClick={() => void run(() => sendProposal(p.key), !typed)}
        >
          {busy ? "sending…" : typed ? (p.status === "queued" ? "send now" : "send") : `${p.action}…`}
        </button>
        <button
          type="button"
          className="mc-btn"
          disabled={busy}
          title={p.file ? "Move the file to .gridkeeper/outbox/dismissed/ (nothing is sent)" : "Forget this review request"}
          onClick={() => void run(() => dismissProposal(p.key), true)}
        >
          dismiss
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
      {auto ? (
        <>
          ◆ autopilot{paused ? " paused" : ""}
          {queued > 0 && ` · ${queued} queued`}
          {waiting > 0 && ` · ${waiting} to review`}
        </>
      ) : (
        <>◇ lead control · {waiting} to review</>
      )}
      {auto && (
        <button type="button" className="lc-head-btn" title={paused ? "Deliver automatically again" : "Stop automatic delivery until you resume"} onClick={() => setControlOptions(dir, { paused: !paused })}>
          {paused ? "resume" : "pause"}
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
        title={`Lead control autopilot${paused ? " (paused)" : ""}: the lead's instructions are ${paused ? "waiting for your Send" : "delivered automatically when the target is idle"}. Click to open Mission Control.`}
        onClick={open}
      >
        <span className="lc-sb-glyph">◆</span>
        autopilot{paused ? " paused" : ""} · {queued} queued{waiting > 0 ? ` · ${waiting} to review` : ""}
      </button>
      <button
        type="button"
        className="sb-item sb-btn lc-sb-pause"
        title={paused ? "Resume automatic delivery" : "Pause automatic delivery in every project (instructions wait for your Send)"}
        onClick={() => setAutopilotPaused(!paused)}
      >
        {paused ? "resume" : "pause"}
      </button>
      <span className="sb-div" />
    </>
  );
}
