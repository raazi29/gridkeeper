// Merge assistant dialog (the first git write; ADR-020). From a sign-off card: a preview (commits,
// diffstat, fast-forward, conflict check — nothing written), an optional test gate (a green run on
// exactly the branch tip, in a clean worktree), the strategy and message, and the exact git commands.
// Pressing "Merge" is the one confirmation; Rust re-checks every guard, runs the commands in the main
// checkout and rolls back a failed step. Conflicts can be handed to the branch's agent (confirmed
// message). After a merge, "remove worktree + branch…" is a separate confirmed step.

import { useEffect, useMemo, useRef, useState } from "react";
import { pathKey, refreshBranchSummary, evidencePath } from "../../actions/handoff";
import { notify } from "../../actions/notify";
import { errorMessage, ipc } from "../../lib/ipc";
import type { MergeOutcome, MergePlan, MergePreview, MergeStrategy, WorktreeCleanupOutcome } from "../../lib/types";
import { recordActivity, sessionLabelOf } from "../../store/activity";
import { isLive, useApp } from "../../store/appStore";
import { dirKey, useMissionDocs } from "../../store/missionDoc";
import { commandFor, latestRunFor, openAskAgent, openTestLog, runTestsForSession, sessionTarget, useTestRuns } from "../../store/testrun";
import { confirmDialog } from "../../store/uiStore";
import { badgeText, badgeTone } from "../testrun/format";
import { useTicking } from "../testrun/TestBadge";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { closeMergeDialog, useMergeDialog, type MergeDialogRequest } from "./mergeStore";
import {
  buildRequest,
  conflictMessage,
  defaultMessage,
  defaultStrategy,
  gateText,
  liveUsersOf,
  mergeDisabledReasons,
  strategyOptions,
  taskForMember,
  testGate,
} from "./mergeModel";
import "../../styles/testrun.css";

const STRATEGY_TEXT: Record<MergeStrategy, string> = { fastForward: "fast-forward", mergeCommit: "merge commit", squash: "squash" };

export function MergeHost() {
  const req = useMergeDialog((s) => s.req);
  if (!req) return null;
  return <MergeDialog key={`${req.sessionId}:${req.path}`} req={req} />;
}

/** The session's mission task text (for the default commit message). */
function missionTaskOf(sessionId: string): string | null {
  const s = useApp.getState();
  const meta = s.persisted.sessions.find((m) => m.id === sessionId);
  const ws = s.persisted.workspaces.find((w) => w.groups.some((g) => g.sessionIds.includes(sessionId)));
  if (!meta || !ws?.projectDir) return null;
  const tasks = useMissionDocs.getState().byDir[dirKey(ws.projectDir)]?.doc?.tasks ?? [];
  return taskForMember(tasks, { name: meta.name, role: meta.role ?? null })?.text ?? null;
}

function MergeDialog({ req }: { req: MergeDialogRequest }) {
  const name = useApp((s) => s.persisted.sessions.find((m) => m.id === req.sessionId)?.name ?? "session");
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<MergeStrategy>("mergeCommit");
  const [message, setMessage] = useState("");
  const [requireTests, setRequireTests] = useState(false);
  const [hasCommand, setHasCommand] = useState(false);
  const touchedGate = useRef(false);
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [execError, setExecError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<MergeOutcome | null>(null);
  const [cleanup, setCleanup] = useState<WorktreeCleanupOutcome | null>(null);
  const run = useTestRuns((s) => latestRunFor(s, req.path));
  const now = useTicking(!!run && (run.status === "queued" || run.status === "running"));

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const p = await ipc.mergePreview(req.path, null);
      setPreview(p);
      setStrategy((cur) => (cur === "fastForward" && !p.canFastForward ? "mergeCommit" : preview ? cur : defaultStrategy(p)));
      setMessage((cur) => cur || defaultMessage(p.branch, missionTaskOf(req.sessionId), p.lastSubject));
    } catch (e) {
      setLoadError(errorMessage(e));
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    const t = sessionTarget(req.sessionId);
    if (t)
      void commandFor(t).then((c) => {
        setHasCommand(!!c);
        if (!touchedGate.current) setRequireTests(!!c);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const gate = testGate(preview, run, requireTests, hasCommand);
  const request = useMemo(() => buildRequest(preview, strategy, message, requireTests), [preview, strategy, message, requireTests]);
  const reasons = mergeDisabledReasons({ preview, strategy, message, gate, busy });

  // The exact commands for the current choice (pure on the Rust side), refreshed as the user edits.
  useEffect(() => {
    if (!request) {
      setPlan(null);
      return;
    }
    let alive = true;
    const t = window.setTimeout(() => {
      ipc
        .mergePlan(request)
        .then((p) => alive && setPlan(p))
        .catch(() => alive && setPlan(null));
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [request]);

  const merge = async () => {
    if (!request || reasons.length) return;
    setBusy(true);
    setExecError(null);
    const who = sessionLabelOf(req.sessionId);
    try {
      const out = await ipc.mergeExecute(request);
      setOutcome(out);
      const sha = out.newSha ? out.newSha.slice(0, 10) : "?";
      if (out.ok) {
        notify("info", `Merged ${request.branch} into ${request.base} (${STRATEGY_TEXT[request.strategy]})`);
        recordActivity({ sessionId: req.sessionId, sessionName: who.name, role: who.role, agent: who.agent, kind: "merge", level: "ok", message: `merged ${request.branch} into ${request.base} (${STRATEGY_TEXT[request.strategy]}) → ${sha}`, result: "merged" });
      } else {
        notify("error", `Merge failed${out.rolledBack ? " and was rolled back" : ""}: ${out.error ?? "git failed"}`);
        recordActivity({ sessionId: req.sessionId, sessionName: who.name, role: who.role, agent: who.agent, kind: "merge", level: "error", message: `merge of ${request.branch} into ${request.base} failed${out.conflicts.length ? ` (${out.conflicts.length} conflicts)` : ""}${out.rolledBack ? ", rolled back" : ""}`, result: "failed" });
      }
      void refreshBranchSummary(req.path);
    } catch (e) {
      // A refusal (a guard failed on the Rust side): nothing was written.
      setExecError(errorMessage(e));
      void load();
    }
    setBusy(false);
  };

  const handToAgent = (conflicts: MergePreview["conflicts"]) => {
    if (!preview?.branch || !preview.base) return;
    openAskAgent({ sessionId: req.sessionId, title: `Hand the conflicts to ${name}`, text: conflictMessage(preview.branch, preview.base, conflicts), kind: "merge" });
  };

  return (
    <Modal
      title={preview?.branch && preview.base ? `Merge ${preview.branch} → ${preview.base}` : `Merge · ${name}`}
      onClose={closeMergeDialog}
      width={760}
      className="mg-dialog"
      footer={
        outcome ? (
          <DoneFooter req={req} preview={preview} outcome={outcome} cleanup={cleanup} setCleanup={setCleanup} onHand={handToAgent} />
        ) : (
          <>
            <span className="mg-foot-note" title={reasons.join("\n") || undefined}>
              {reasons.length ? reasons[0] : `Runs ${plan?.commands.length ?? "…"} command${plan?.commands.length === 1 ? "" : "s"} in the main checkout.`}
            </span>
            <Button onClick={closeMergeDialog}>Cancel</Button>
            <Button variant="primary" disabled={reasons.length > 0 || !plan} onClick={() => void merge()}>
              {busy ? "Merging…" : `Merge into ${preview?.base ?? "base"}`}
            </Button>
          </>
        )
      }
    >
      {loading && !preview ? (
        <div className="tr-dim">Reading git (nothing is written)…</div>
      ) : loadError ? (
        <div className="callout is-error">{loadError}</div>
      ) : preview ? (
        outcome ? (
          <OutcomeView preview={preview} outcome={outcome} cleanup={cleanup} />
        ) : (
          <div className="mg-body">
            <PreviewSummary p={preview} loading={loading} onRefresh={() => void load()} />
            {preview.conflicts.length > 0 && (
              <div className="mg-section">
                <div className="mg-h">Conflicts ({preview.conflicts.length})</div>
                <ConflictList conflicts={preview.conflicts} />
                <Button size="sm" onClick={() => handToAgent(preview.conflicts)} disabled={!preview.branch}>
                  Hand to {name}…
                </Button>
              </div>
            )}
            {preview.blockers.length > 0 && (
              <div className="callout is-error mg-blockers">
                {preview.blockers.map((b) => (
                  <div key={b}>{b}</div>
                ))}
              </div>
            )}
            {preview.warnings.map((w) => (
              <div key={w} className="callout tr-callout-warn">
                {w}
              </div>
            ))}

            <div className="mg-section">
              <label className="mg-check">
                <input
                  type="checkbox"
                  checked={requireTests}
                  onChange={(e) => {
                    touchedGate.current = true;
                    setRequireTests(e.currentTarget.checked);
                  }}
                />
                Require green tests on this commit first
              </label>
              {requireTests && (
                <div className={`mg-gate is-${gate.state}`}>
                  <span>{gateText(gate)}</span>
                  {run && (
                    <button type="button" className={`tr-badge is-${badgeTone(run.status)}`} onClick={() => openTestLog(run.id)} title="Open the test log">
                      {badgeText(run, now)}
                    </button>
                  )}
                  {gate.state !== "ok" && gate.state !== "running" && (
                    <Button size="sm" onClick={() => void runTestsForSession(req.sessionId)}>
                      Run tests
                    </Button>
                  )}
                </div>
              )}
            </div>

            <div className="mg-section">
              <div className="mg-h">Strategy</div>
              <div className="mg-strategies" role="radiogroup" aria-label="Merge strategy">
                {strategyOptions(preview).map((o) => (
                  <label key={o.value} className={`mg-strategy${o.disabled ? " is-disabled" : ""}`} title={o.hint}>
                    <input type="radio" name="mg-strategy" value={o.value} checked={strategy === o.value} disabled={o.disabled} onChange={() => setStrategy(o.value)} />
                    <span className="mg-strategy-label">{o.label}</span>
                    <span className="tr-dim">{o.hint}</span>
                  </label>
                ))}
              </div>
              {strategy !== "fastForward" && (
                <input className="input mono mg-message" value={message} spellCheck={false} aria-label="Commit message" maxLength={500} onChange={(e) => setMessage(e.target.value)} />
              )}
            </div>

            <div className="mg-section">
              <div className="mg-h">Commands (exactly what runs)</div>
              <pre className="code-block mg-commands">{plan ? plan.commands.join("\n") : "…"}</pre>
              {plan && plan.onFailure.length > 0 && (
                <div className="tr-dim mg-onfail">
                  If a step fails: <span className="mono">{plan.onFailure.join("; ")}</span> — the checkout is put back, never left mid-merge.
                </div>
              )}
              <div className="tr-dim">Never forced, no checkout / reset / stash, no history rewrite, branches are not deleted.</div>
            </div>
            {execError && <div className="callout is-error">Refused, nothing was written: {execError}</div>}
          </div>
        )
      ) : null}
    </Modal>
  );
}

function PreviewSummary({ p, loading, onRefresh }: { p: MergePreview; loading: boolean; onRefresh: () => void }) {
  return (
    <div className="mg-section">
      <div className="mg-route mono">
        <span title={p.path}>{p.branch ?? "(no branch)"}</span>
        <span className="tr-dim"> {p.branchSha?.slice(0, 10)}</span>
        <span className="mg-arrow">→</span>
        <span title={p.mainPath ?? undefined}>{p.base ?? "(no base)"}</span>
        <span className="tr-dim"> in {p.mainPath ?? "?"}</span>
        <span className="mc-spacer" />
        <Button size="sm" onClick={onRefresh} disabled={loading}>
          {loading ? "Checking…" : "Check again"}
        </Button>
      </div>
      <div className="mg-stats">
        <span>
          {p.ahead} commit{p.ahead === 1 ? "" : "s"} to merge
        </span>
        {p.behind > 0 && <span className="tr-dim">· {p.base} is {p.behind} ahead</span>}
        <span>
          · {p.filesChanged} file{p.filesChanged === 1 ? "" : "s"} <span className="is-add">+{p.insertions}</span> <span className="is-del">−{p.deletions}</span>
        </span>
        <span className={p.clean === false ? "is-del" : p.clean ? "is-add" : "tr-dim"}>
          · {p.clean === null ? "conflict check unavailable" : p.clean ? (p.canFastForward ? "fast-forward possible" : "merges cleanly") : `${p.conflicts.length} conflicting file${p.conflicts.length === 1 ? "" : "s"}`}
        </span>
        {p.checkMethod && <span className="tr-dim">({p.checkMethod})</span>}
      </div>
      {p.commits.length > 0 && (
        <details className="mg-details" open={p.commits.length <= 6}>
          <summary>Commits</summary>
          <ul className="mg-commits mono">
            {p.commits.map((c) => (
              <li key={c.sha}>
                <span className="tr-dim">{c.sha.slice(0, 8)}</span> {c.subject} <span className="tr-dim">— {c.author}</span>
              </li>
            ))}
            {p.commitsTruncated && <li className="tr-dim">… more</li>}
          </ul>
        </details>
      )}
      {p.files.length > 0 && (
        <details className="mg-details">
          <summary>Files ({p.files.length}{p.filesTruncated ? "+" : ""})</summary>
          <ul className="mg-files mono">
            {p.files.map((f) => (
              <li key={f.path}>
                <span className="mg-letter">{f.status}</span> {f.origPath ? `${f.origPath} → ` : ""}
                {f.path}{" "}
                {f.binary ? (
                  <span className="tr-dim">binary</span>
                ) : (
                  <>
                    <span className="is-add">+{f.insertions}</span> <span className="is-del">−{f.deletions}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ConflictList({ conflicts }: { conflicts: MergePreview["conflicts"] }) {
  return (
    <ul className="mg-conflicts mono">
      {conflicts.map((c) => (
        <li key={c.path}>
          <span className="is-del">✗</span> {c.path} {c.kind !== "conflict" && <span className="tr-dim">({c.kind})</span>}
        </li>
      ))}
    </ul>
  );
}

function OutcomeView({ preview, outcome, cleanup }: { preview: MergePreview; outcome: MergeOutcome; cleanup: WorktreeCleanupOutcome | null }) {
  return (
    <div className="mg-body">
      {outcome.ok ? (
        <div className="callout mg-ok">
          Merged <span className="mono">{preview.branch}</span> into <span className="mono">{preview.base}</span> ({STRATEGY_TEXT[outcome.strategy]}).{" "}
          <span className="mono">{preview.base}</span> is now at <span className="mono">{outcome.newSha?.slice(0, 10) ?? "?"}</span>.
        </div>
      ) : (
        <div className="callout is-error">
          <div>
            The merge stopped{outcome.rolledBack ? " and the main checkout was put back (same HEAD, clean)." : "."}
          </div>
          {outcome.error && <pre className="mg-error mono">{outcome.error}</pre>}
        </div>
      )}
      {outcome.conflicts.length > 0 && (
        <div className="mg-section">
          <div className="mg-h">Conflicting files</div>
          <ConflictList conflicts={outcome.conflicts} />
        </div>
      )}
      <StepLog steps={outcome.steps} />
      {cleanup && (
        <div className={`callout ${cleanup.error ? "is-error" : "mg-ok"}`}>
          {cleanup.worktreeRemoved ? "Worktree removed" : "Worktree kept"}
          {cleanup.linksRemoved > 0 ? ` (${cleanup.linksRemoved} link${cleanup.linksRemoved === 1 ? "" : "s"} unlinked first, targets untouched)` : ""}
          {" · "}
          {cleanup.branchDeleted ? "branch deleted" : "branch kept"}
          {cleanup.error && <pre className="mg-error mono">{cleanup.error}</pre>}
          <StepLog steps={cleanup.steps} />
        </div>
      )}
    </div>
  );
}

function StepLog({ steps }: { steps: MergeOutcome["steps"] }) {
  if (!steps.length) return null;
  return (
    <details className="mg-details">
      <summary>What ran ({steps.length})</summary>
      <div className="mg-steps">
        {steps.map((s, i) => (
          <div key={i} className={`mg-step${s.ok ? "" : " is-failed"}`}>
            <div className="mono">
              {s.ok ? "✓" : "✗"} {s.command}
            </div>
            {s.output && <pre className="mono">{s.output}</pre>}
          </div>
        ))}
      </div>
    </details>
  );
}

function DoneFooter({
  req,
  preview,
  outcome,
  cleanup,
  setCleanup,
  onHand,
}: {
  req: MergeDialogRequest;
  preview: MergePreview | null;
  outcome: MergeOutcome;
  cleanup: WorktreeCleanupOutcome | null;
  setCleanup: (c: WorktreeCleanupOutcome) => void;
  onHand: (c: MergePreview["conflicts"]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const users = useApp((s) =>
    liveUsersOf(
      preview?.path ?? req.path,
      s.persisted.sessions.map((m) => ({ name: m.name, path: evidencePath(m), live: isLive(s.runtime[m.id]) })),
      pathKey,
    ).join(", "),
  );
  const canCleanup = outcome.ok && !cleanup?.worktreeRemoved;
  const cleanupBlocked = users ? `Stop ${users} first: ${users.includes(",") ? "they use" : "it uses"} the worktree.` : null;

  const removeWorktree = async () => {
    if (!preview?.base) return;
    setBusy(true);
    try {
      const plan = await ipc.mergeCleanupPlan(preview.path, preview.base);
      if (plan.blockers.length) {
        notify("error", plan.blockers.join(" "));
        setBusy(false);
        return;
      }
      const detail = [
        ...plan.links.map((l) => `• unlink ${l} (junction / symlink; the target is not touched)`),
        ...plan.commands.map((c) => `• ${c}`),
      ].join("\n");
      const ok = await confirmDialog({
        title: plan.branchMerged ? "Remove the worktree and the branch?" : "Remove the worktree?",
        message: plan.branchMerged
          ? `Deletes the worktree folder (${plan.path}) and the branch “${plan.branch}”, which is merged into ${preview.base}. Never forced: git refuses if anything is uncommitted.`
          : `Deletes the worktree folder (${plan.path}). The branch “${plan.branch}” is kept: it is not contained in ${preview.base} (a squash merge keeps the branch's own commits).`,
        detail,
        confirmLabel: "Remove",
        danger: true,
      });
      if (!ok) {
        setBusy(false);
        return;
      }
      const out = await ipc.mergeCleanup(plan.path, plan.branch, preview.base);
      setCleanup(out);
      const who = sessionLabelOf(req.sessionId);
      recordActivity({
        sessionId: req.sessionId,
        sessionName: who.name,
        role: who.role,
        agent: who.agent,
        kind: "worktree",
        level: out.error ? "error" : "ok",
        message: `${out.worktreeRemoved ? "worktree removed" : "worktree not removed"}${out.branchDeleted ? `, branch ${plan.branch} deleted` : ""}${out.error ? `: ${out.error}` : ""}`,
        result: out.worktreeRemoved ? "removed" : "failed",
      });
      notify(out.error ? "error" : "info", out.error ? `Clean-up stopped: ${out.error}` : "Worktree removed");
    } catch (e) {
      notify("error", `Clean-up refused: ${errorMessage(e)}`);
    }
    setBusy(false);
  };

  return (
    <>
      <span className="mg-foot-note">{outcome.ok ? "Done. Clean-up is a separate step." : "Nothing was merged."}</span>
      {!outcome.ok && outcome.conflicts.length > 0 && <Button onClick={() => onHand(outcome.conflicts)}>Hand to the agent…</Button>}
      {canCleanup && (
        <Button disabled={busy || !!cleanupBlocked} title={cleanupBlocked ?? "Shows the exact commands and asks before anything is removed"} onClick={() => void removeWorktree()}>
          {busy ? "Working…" : "Remove worktree + branch…"}
        </Button>
      )}
      <Button variant="primary" onClick={closeMergeDialog}>
        Close
      </Button>
    </>
  );
}
