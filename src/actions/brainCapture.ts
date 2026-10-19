// Brain capture: turns what happens on the team into short SUGGESTED memories in `.gridkeeper/brain/inbox/`
// (rules: lib/brain.ts suggestFromBoard / suggestFromOutbox). Nothing enters notes/ without the user, unless they
// switched on auto-approve for the project (store/brain.ts prefs; then only Gridkeeper's own captures skip the
// inbox — files agents write into inbox/ always wait for the user).
//
// Sources, all observed through existing stores (no polling, no extra watches):
// - the mission board of every folder whose mission file is held (Mission Control open, or lead control on): a
//   task done with `- note: …` lines, an LGTM review, a blocker resolved, a review's new `fix: …` tasks;
// - lead control proposals: an outbox message from the lead that states a decision ("decided", "we will",
//   "always", "never").
// The first read of a board is the baseline (nothing is suggested for what was already there). Suggestions are
// scrubbed (no paths, e-mails, secret-looking tokens), deduplicated against the brain and within the session,
// at most 5 per change, announced with one toast.
// Agent-facing: stays English (typed into agents / written to files): the suggestion files' text; only the toast
// is translated.

import { t } from "../i18n";
import { isDuplicate, newNoteText, slugForTitle, suggestFromBoard, suggestFromOutbox, type BoardSnapshot, type Comparable, type Suggestion } from "../lib/brain";
import { errorMessage, ipc } from "../lib/ipc";
import { brainPrefs, openBrain, reloadBrain, useBrain } from "../store/brain";
import { useLeadControl, type Proposal } from "../store/leadControl";
import { dirKey, useMissionDocs } from "../store/missionDoc";
import { actionToast } from "../store/uiStore";

const MAX_PER_BATCH = 5;

/** The sender is a lead (not a teammate who called itself one). */
export function isLeadProposal(p: Pick<Proposal, "source" | "from" | "lead">): boolean {
  if (p.source !== "outbox" || p.from.endsWith("(self-declared)")) return false;
  return p.from === "lead" || p.lead !== null;
}

const sessionKeys = new Set<string>();
const queues = new Map<string, Promise<unknown>>();

function serial(dir: string, fn: () => Promise<void>): Promise<void> {
  const k = dirKey(dir);
  const run = (queues.get(k) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => {});
  queues.set(k, tail);
  void tail.then(() => {
    if (queues.get(k) === tail) queues.delete(k);
  });
  return run;
}

/** Write new (non-duplicate) suggestions for `dir`; returns how many were written. */
export function submitSuggestions(dir: string, list: readonly Suggestion[]): Promise<number> {
  let written = 0;
  return serial(dir, async () => {
    const fresh = list.filter((s) => {
      const k = `${dirKey(dir)}|${s.key}`;
      if (sessionKeys.has(k)) return false;
      sessionKeys.add(k);
      return true;
    });
    if (fresh.length === 0) return;
    let existing: Comparable[] = [];
    let taken: string[] = [];
    try {
      const idx = await ipc.brainList(dir);
      const all = [...idx.notes, ...idx.inbox];
      existing = all.map((n) => ({ title: n.title, excerpt: n.excerpt }));
      taken = all.map((n) => n.slug);
    } catch (e) {
      ipc.log("warn", `brain capture: could not list the brain: ${errorMessage(e)}`);
      return;
    }
    const auto = brainPrefs(dir).autoApprove;
    for (const s of fresh.slice(0, MAX_PER_BATCH)) {
      if (!s.title || isDuplicate({ title: s.title, body: s.body }, existing)) continue;
      const slug = slugForTitle(s.title, taken);
      taken.push(slug);
      const text = newNoteText({ title: s.title, kind: s.kind, tags: s.tags, source: s.source, confidence: auto ? "confirmed" : "suggested", body: s.body });
      try {
        await ipc.brainWrite(dir, slug, text, !auto, null);
        written++;
        existing.push({ title: s.title, excerpt: s.body });
      } catch (e) {
        ipc.log("warn", `brain capture: could not write a suggestion: ${errorMessage(e)}`);
      }
    }
    if (written === 0) return;
    if (useBrain.getState().byDir[dir]) void reloadBrain(dir);
    actionToast({
      kind: "info",
      message: t(auto ? "brain.capture.remembered" : "brain.capture.suggested", { count: written }),
      action: { label: t(auto ? "common.open" : "brain.capture.review"), run: () => openBrain({ dir, tab: auto ? "notes" : "inbox", select: null }) },
    });
  }).then(() => written);
}

/** Start capturing (once, from BrainLayer). Returns the uninstall function. */
export function installBrainCapture(): () => void {
  const boards = new Map<string, BoardSnapshot>();
  const onDocs = (byDir: ReturnType<typeof useMissionDocs.getState>["byDir"]) => {
    for (const [dir, e] of Object.entries(byDir)) {
      const file = e.file;
      if (!file?.exists || !e.doc) continue;
      const prev = boards.get(dir);
      if (prev && prev.text === file.text) continue;
      const next = { text: file.text, doc: e.doc };
      boards.set(dir, next);
      if (!prev || !brainPrefs(dir).capture) continue;
      const list = suggestFromBoard(prev, next);
      if (list.length) void submitSuggestions(dir, list);
    }
  };
  onDocs(useMissionDocs.getState().byDir);
  const offDocs = useMissionDocs.subscribe((s, old) => {
    if (s.byDir !== old.byDir) onDocs(s.byDir);
  });

  // Proposals that exist at install time are the baseline.
  const seen = new Set(useLeadControl.getState().proposals.map((p) => p.key));
  const offLead = useLeadControl.subscribe((s, old) => {
    if (s.proposals === old.proposals) return;
    for (const p of s.proposals) {
      if (seen.has(p.key)) continue;
      seen.add(p.key);
      if (!isLeadProposal(p) || !brainPrefs(p.dir).capture) continue;
      const list = suggestFromOutbox(p.text);
      if (list.length) void submitSuggestions(p.dir, list);
    }
  });
  return () => {
    offDocs();
    offLead();
  };
}

/** Test hook. */
export function resetBrainCaptureForTests(): void {
  sessionKeys.clear();
  queues.clear();
}
