// Lead control state: the user's autonomy policy per project folder and the queue of instructions (from the
// outbox, or auto-review requests) waiting to be sent. Ephemeral zustand store, except the policies, which
// live in localStorage keyed by the normalized project folder — deliberately NOT in the project folder, so an
// agent can never raise its own autonomy. The engine (actions/leadControl.ts) owns every side effect.

import { create } from "zustand";
import type { OutboxAction } from "../lib/outbox";
import type { SessionId } from "../lib/types";
import { dirKey } from "./missionDoc";

/**
 * - off: the outbox is ignored (files stay where they are), team.md is not written.
 * - advisor: team.md is maintained; every instruction becomes a proposal the user sends or dismisses.
 * - autopilot: message / review instructions are delivered automatically when the target is safe to type
 *   into (rate-limited); stop / restart always stay proposals. `paused` = advisor until resumed.
 */
export type ControlMode = "off" | "advisor" | "autopilot";

export interface ControlPolicy {
  mode: ControlMode;
  /** Autopilot paused by the user: behaves like advisor until resumed. */
  paused: boolean;
  /** Ask the lead to review a teammate's finished work. */
  autoReview: boolean;
  /** Put the last lines of each terminal into team.md. */
  shareOutput: boolean;
}

export const DEFAULT_POLICY: Readonly<ControlPolicy> = Object.freeze<ControlPolicy>({ mode: "off", paused: false, autoReview: true, shareOutput: false });

export const POLICY_STORAGE_PREFIX = "gridkeeper.leadControl.v1:";

/** What the engine actually does for a policy (paused autopilot = advisor). */
export function effectiveMode(p: Pick<ControlPolicy, "mode" | "paused">): ControlMode {
  return p.mode === "autopilot" && p.paused ? "advisor" : p.mode;
}

export interface Proposal {
  /** Unique: `${dirKey}|f|${file}` (outbox) or `${dirKey}|r|${reviewKey}` (auto-review). */
  key: string;
  dirKey: string;
  /** Project folder as the workspace spells it. */
  dir: string;
  source: "outbox" | "review";
  /** Outbox file name (source "outbox"). */
  file: string | null;
  /** The file's last-write time when it was parsed (0 for reviews). */
  modifiedMs: number;
  /** Sender as shown: "lead", "builder-1 (self-declared)", "auto-review". */
  from: string;
  /** Which lead is involved when that is known (sender lead, or the lead a review goes to). */
  lead: string | null;
  /** Raw "to:" tokens (for display). */
  to: string[];
  /** Resolved session ids, in team order. Reviews: the leads (the first live one gets it). */
  targets: SessionId[];
  /** Target names for display ("builder-1, builder-2"). */
  targetLabel: string;
  action: OutboxAction;
  /** Text typed into the target (message / review) or the reason given (stop / restart). Editable. */
  text: string;
  /** The user edited the text: a rewrite of the file no longer replaces it. */
  edited: boolean;
  warnings: string[];
  /** proposal: waits for the user. queued: autopilot delivers it at the next safe moment. */
  status: "proposal" | "queued";
  /** Why it was not sent (yet). */
  reason: string | null;
  createdAt: number;
  /** When autopilot queued it (give-up clock). */
  queuedAt: number | null;
  /** Targets that already received it (multi-target instructions). */
  delivered: SessionId[];
  /** A send / archive is in flight. */
  busy: boolean;
}

interface LeadControlStore {
  /** By dirKey. Missing = DEFAULT_POLICY. */
  policies: Record<string, ControlPolicy>;
  /** Folders the engine currently controls (dirKey -> folder): a workspace has that folder and mode != off. */
  active: Record<string, string>;
  proposals: Proposal[];
}

/** The webview's localStorage; null outside a browser (tests) or when blocked. */
function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : (window.localStorage ?? null);
  } catch {
    return null;
  }
}

function sanitize(raw: unknown): ControlPolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Record<keyof ControlPolicy, unknown>>;
  const mode: ControlMode = r.mode === "advisor" || r.mode === "autopilot" ? r.mode : "off";
  return {
    mode,
    paused: r.paused === true,
    autoReview: r.autoReview !== false,
    shareOutput: r.shareOutput === true,
  };
}

/** Every stored policy (bad entries are ignored). */
export function loadPolicies(): Record<string, ControlPolicy> {
  const out: Record<string, ControlPolicy> = {};
  const ls = storage();
  if (!ls) return out;
  try {
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (!k?.startsWith(POLICY_STORAGE_PREFIX)) continue;
      try {
        const p = sanitize(JSON.parse(ls.getItem(k) ?? "null"));
        if (p) out[k.slice(POLICY_STORAGE_PREFIX.length)] = p;
      } catch {
        /* damaged entry: default */
      }
    }
  } catch {
    /* storage blocked */
  }
  return out;
}

function savePolicy(key: string, p: ControlPolicy) {
  const ls = storage();
  if (!ls) return;
  try {
    if (p.mode === "off" && !p.paused && p.autoReview && !p.shareOutput) ls.removeItem(POLICY_STORAGE_PREFIX + key);
    else ls.setItem(POLICY_STORAGE_PREFIX + key, JSON.stringify(p));
  } catch {
    /* quota / blocked: the choice lasts until restart */
  }
}

export const useLeadControl = create<LeadControlStore>()(() => ({ policies: loadPolicies(), active: {}, proposals: [] }));

// ---- policies -------------------------------------------------------------------------------------

export function policyOf(dir: string | null | undefined): ControlPolicy {
  if (!dir) return DEFAULT_POLICY;
  return useLeadControl.getState().policies[dirKey(dir)] ?? DEFAULT_POLICY;
}

export function setPolicy(dir: string, patch: Partial<ControlPolicy>): ControlPolicy {
  const key = dirKey(dir);
  const cur = useLeadControl.getState().policies[key] ?? DEFAULT_POLICY;
  const next: ControlPolicy = { ...cur, ...patch };
  if (next.mode !== "autopilot") next.paused = false;
  savePolicy(key, next);
  useLeadControl.setState((s) => ({ policies: { ...s.policies, [key]: next } }));
  return next;
}

// ---- proposals ------------------------------------------------------------------------------------

export function getProposal(key: string): Proposal | undefined {
  return useLeadControl.getState().proposals.find((p) => p.key === key);
}

/** Insert or replace (by key, keeping its position). */
export function upsertProposal(p: Proposal): void {
  useLeadControl.setState((s) => {
    const i = s.proposals.findIndex((x) => x.key === p.key);
    if (i < 0) return { proposals: [...s.proposals, p] };
    const proposals = s.proposals.slice();
    proposals[i] = p;
    return { proposals };
  });
}

export function patchProposal(key: string, patch: Partial<Proposal>): void {
  useLeadControl.setState((s) => {
    const i = s.proposals.findIndex((x) => x.key === key);
    if (i < 0) return s;
    const proposals = s.proposals.slice();
    proposals[i] = { ...proposals[i], ...patch };
    return { proposals };
  });
}

export function removeProposal(key: string): void {
  useLeadControl.setState((s) => (s.proposals.some((p) => p.key === key) ? { proposals: s.proposals.filter((p) => p.key !== key) } : s));
}

export function removeDirProposals(dk: string): void {
  useLeadControl.setState((s) => (s.proposals.some((p) => p.dirKey === dk) ? { proposals: s.proposals.filter((p) => p.dirKey !== dk) } : s));
}

/** The user typed in a proposal's text box. */
export function editProposal(key: string, text: string): void {
  patchProposal(key, { text, edited: true });
}

// ---- primitive selectors (safe as zustand selector results) ----------------------------------------

/** Controlled folders in autopilot; `runningOnly` = not paused. */
export function countAutopilot(s: LeadControlStore, runningOnly: boolean): number {
  let n = 0;
  for (const k in s.active) {
    const p = s.policies[k];
    if (p?.mode === "autopilot" && (!runningOnly || !p.paused)) n++;
  }
  return n;
}

export function countQueued(s: LeadControlStore, dk?: string): number {
  let n = 0;
  for (const p of s.proposals) if (p.status === "queued" && (!dk || p.dirKey === dk)) n++;
  return n;
}

export function countWaiting(s: LeadControlStore, dk?: string): number {
  let n = 0;
  for (const p of s.proposals) if (p.status === "proposal" && (!dk || p.dirKey === dk)) n++;
  return n;
}

/** Test hook. */
export function resetLeadControlStoreForTests(): void {
  useLeadControl.setState({ policies: loadPolicies(), active: {}, proposals: [] });
}
