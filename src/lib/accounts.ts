// Pure helpers for agent accounts (grouping, status text, pickers, quick-launch cards).
// No store or IPC access here, so everything is unit-testable.

import type { Account, AccountAgentInfo, AgentAvailability, AgentKind, ClaudeProfile, SessionInfo } from "./types";

/** Which agent an account or launch belongs to: "claude", "codex", or a catalog preset id ("hermes"). */
export function agentKey(agent: AgentKind, preset?: string | null): string {
  return agent === "generic" ? (preset ?? "") : agent;
}

export function accountKey(a: Pick<Account, "agent" | "preset">): string {
  return agentKey(a.agent, a.preset);
}

/** Agent of a record that may predate accounts (ClaudeProfile without `agent` = Claude). */
export function asAccount(p: ClaudeProfile | Account): Account {
  const a = p as Partial<Account>;
  return { ...p, agent: a.agent ?? "claude", preset: a.preset ?? null, autoDetected: a.autoDetected ?? false, resolvedDir: a.resolvedDir ?? null };
}

/** "alice@example.com" → "a…@example.com". UI only; e-mails are never logged or persisted. */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return "…";
  return `${email[0]}…${email.slice(at)}`;
}

/** Name plus masked e-mail when the status command reported one: "work · a…@example.com". */
export function accountLabel(a: ClaudeProfile): string {
  const m = maskEmail(a.status.account);
  return m ? `${a.name} · ${m}` : a.name;
}

/**
 * Signed in for launch purposes: verified by the agent's status command, or (not verified yet) a
 * stored-login file exists. Before the first scan finishes, statuses are filename-only.
 */
export function isSignedIn(a: ClaudeProfile): boolean {
  if (a.status.loggedIn === true) return true;
  if (a.status.loggedIn === false) return false;
  return a.status.likelyAuthenticated;
}

export type StatusTone = "ok" | "warn" | "err" | "muted";

/** Status chip: Signed in / Not signed in / Unknown (and a few precise variants). */
export function accountStatus(a: ClaudeProfile | Account, hasStatusCommand = true): { text: string; tone: StatusTone } {
  const st = a.status;
  if (!st.dirExists && a.configDir) return { text: "Folder missing", tone: "err" };
  if (st.verified && st.loggedIn) return { text: "Signed in", tone: "ok" };
  if (st.verified && st.loggedIn === false) return { text: "Not signed in", tone: "err" };
  if (st.loggedIn === false) return { text: "Not signed in", tone: "err" };
  if (!hasStatusCommand) return st.likelyAuthenticated ? { text: "Configured", tone: "ok" } : { text: "Not set up", tone: "warn" };
  if (st.likelyAuthenticated) return { text: "Likely signed in", tone: "warn" };
  return { text: "Unknown", tone: "muted" };
}

export interface AccountGroup {
  key: string;
  label: string;
  info: AccountAgentInfo | null;
  accounts: Account[];
}

/** Accounts grouped by agent, in the backend's agent order; agents with accounts support but none yet are included. */
export function groupAccounts(accounts: Account[], infos: AccountAgentInfo[]): AccountGroup[] {
  const groups: AccountGroup[] = infos
    .filter((i) => i.isolation === "verified")
    .map((i) => ({ key: i.key, label: i.label, info: i, accounts: [] as Account[] }));
  for (const a of accounts) {
    const key = accountKey(a);
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, label: key === "claude" ? "Claude Code" : key === "codex" ? "Codex" : key, info: null, accounts: [] };
      groups.push(g);
    }
    g.accounts.push(a);
  }
  return groups;
}

export function accountsFor(accounts: Account[], agent: AgentKind, preset?: string | null): Account[] {
  const key = agentKey(agent, preset);
  return key ? accounts.filter((a) => accountKey(a) === key) : [];
}

/** Picker default: the last used account if still present, else the first signed-in one, else the first. */
export function defaultAccountId(list: Account[], lastId: string | null | undefined): string | null {
  if (lastId && list.some((a) => a.id === lastId)) return lastId;
  return (list.find(isSignedIn) ?? list[0])?.id ?? null;
}

/** Live sessions of `agent` already running on account `profileId` (null = no account / default). */
export function liveOnAccount(runtime: Record<string, SessionInfo>, agent: AgentKind, profileId: string | null): number {
  let n = 0;
  for (const id in runtime) {
    const r = runtime[id];
    const live = r.state.state === "running" || r.state.state === "starting" || r.state.state === "stopping";
    if (live && r.agent === agent && (r.profileId ?? null) === (profileId ?? null)) n++;
  }
  return n;
}

export interface LaunchOption {
  key: string;
  label: string;
  hint?: string;
  color?: string;
  agent: AgentKind;
  profileId?: string;
  preset?: string;
  disabled?: boolean;
}

/**
 * Quick-launch cards: one per signed-in account per agent ("Codex · work"). An agent with no
 * signed-in account gets one plain card (its default login), so nothing disappears before the scan.
 */
export function launchOptions(accounts: Account[], agents: AgentAvailability[]): LaunchOption[] {
  const missing = (k: AgentKind) => agents.some((a) => a.kind === k && !a.path);
  const perAccount = (agent: AgentKind, label: string, preset: string | undefined, disabled: boolean): LaunchOption[] => {
    const signed = accountsFor(accounts, agent, preset ?? null).filter(isSignedIn);
    const base = preset ? `tool:${preset}` : agent;
    if (signed.length === 0) return [{ key: base, label, agent, preset, disabled }];
    return signed.map((a) => ({ key: `${base}:${a.id}`, label, hint: a.name, color: a.color, agent, profileId: a.id, preset, disabled }));
  };
  const out: LaunchOption[] = [{ key: "ps", label: "PowerShell", agent: "powershell", disabled: missing("powershell") }];
  out.push(...perAccount("claude", "Claude Code", undefined, missing("claude")));
  out.push(...perAccount("codex", "Codex", undefined, missing("codex")));
  // Other agent CLIs found on this PC (broken installs are reported by detection and skipped here).
  for (const a of agents)
    if (a.preset && !a.error) out.push(...perAccount("generic", a.label ?? a.preset, a.preset, false));
  return out;
}
