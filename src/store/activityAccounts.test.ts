import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../lib/types";
import { mapLifecycle, PENDING_ACCOUNT, resolveAccountName, resolvePendingAccounts, type ActivityEvent } from "./activity";

const accounts = [
  { id: "uuid-1", name: "account1" },
  { id: "uuid-2", name: "account2" },
  { id: "default-codex", name: "Codex home" },
];
const profiles = [{ id: "legacy-claude", name: "work" }];

describe("resolveAccountName", () => {
  it("finds Claude accounts in the multi-agent accounts list (not only profiles)", () => {
    expect(resolveAccountName("claude", "uuid-1", accounts, [])).toEqual({ name: "account1" });
    expect(resolveAccountName("claude", "uuid-2", accounts, profiles)).toEqual({ name: "account2" });
  });
  it("falls back to the historical profiles list", () => {
    expect(resolveAccountName("claude", "legacy-claude", accounts, profiles)).toEqual({ name: "work" });
  });
  it("works for other agents with accounts", () => {
    expect(resolveAccountName("codex", "default-codex", accounts, profiles)).toEqual({ name: "Codex home" });
    expect(resolveAccountName("generic", "uuid-1", accounts, profiles)).toEqual({ name: "account1" });
  });
  it("says Default only when there is no account id", () => {
    expect(resolveAccountName("claude", null, accounts, profiles)).toEqual({ name: "Default" });
    expect(resolveAccountName("codex", undefined, accounts, profiles)).toEqual({ name: "Default" });
    // Shells / custom commands without an account have no account bit at all.
    expect(resolveAccountName("powershell", null, accounts, profiles)).toBeNull();
    expect(resolveAccountName("generic", null, accounts, profiles)).toBeNull();
  });
  it("an id that is not loaded yet is pending, never 'default'", () => {
    expect(resolveAccountName("claude", "uuid-9", [], [])).toEqual({ name: null, pendingId: "uuid-9" });
  });
});

function info(): SessionInfo {
  return { id: "s", name: "s", agent: "claude", pid: 7, state: { state: "running" }, cwd: "C:\\", profileId: "uuid-1", commandDisplay: "", startedAt: "t1", endedAt: null, bytesOut: 0 };
}

describe("started event account text", () => {
  it("uses the resolved account name", () => {
    expect(mapLifecycle(undefined, info(), { profileName: "account1" })?.message).toBe("started claude · account account1");
  });
  it("writes a placeholder while the account is pending", () => {
    expect(mapLifecycle(undefined, info(), { profileName: null, accountPending: true })?.message).toBe(`started claude · ${PENDING_ACCOUNT}`);
  });
});

describe("resolvePendingAccounts", () => {
  const ev = (seq: number, pending?: string): ActivityEvent => ({
    seq,
    at: 0,
    sessionId: "s",
    sessionName: "s",
    role: null,
    agent: "claude",
    kind: "lifecycle",
    level: "info",
    message: pending ? `started claude · ${PENDING_ACCOUNT} · worktree x` : "exited",
    ...(pending ? { pendingAccountId: pending } : {}),
  });

  it("fills in names once the accounts load and drops the pending marker", () => {
    const out = resolvePendingAccounts([ev(1, "uuid-2"), ev(2)], (id) => accounts.find((a) => a.id === id)?.name);
    expect(out?.[0].message).toBe("started claude · account account2 · worktree x");
    expect(out?.[0].pendingAccountId).toBeUndefined();
    expect(out?.[1].message).toBe("exited");
  });
  it("returns null when nothing could be resolved", () => {
    expect(resolvePendingAccounts([ev(1, "uuid-9"), ev(2)], () => null)).toBeNull();
  });
});
