import { describe, expect, it } from "vitest";
import {
  accountKey,
  accountLabel,
  accountStatus,
  accountsFor,
  asAccount,
  defaultAccountId,
  groupAccounts,
  isSignedIn,
  launchOptions,
  liveOnAccount,
  maskEmail,
} from "./accounts";
import type { Account, AccountAgentInfo, AgentAvailability, ProfileStatus, SessionInfo } from "./types";

const st = (p: Partial<ProfileStatus> = {}): ProfileStatus => ({
  dirExists: true,
  likelyAuthenticated: false,
  verified: false,
  loggedIn: null,
  authMethod: null,
  account: null,
  note: null,
  ...p,
});

let n = 0;
const acct = (agent: Account["agent"], name: string, status: Partial<ProfileStatus> = {}, extra: Partial<Account> = {}): Account => ({
  id: `id${++n}`,
  name,
  configDir: name === "Default" ? null : `C:\\Users\\x\\.${agent}-${name}`,
  color: "#7B61FF",
  status: st(status),
  agent,
  preset: null,
  autoDetected: false,
  resolvedDir: null,
  ...extra,
});

const info = (key: string, label: string, isolation: "verified" | "none" = "verified"): AccountAgentInfo => ({
  key,
  agent: key === "claude" || key === "codex" ? key : "generic",
  preset: key === "claude" || key === "codex" ? null : key,
  label,
  isolation,
  homeEnv: null,
  defaultHome: null,
  installed: true,
  hasStatusCommand: key !== "hermes",
  loginArgs: [],
  deviceLoginArgs: null,
  loginHint: null,
  loginVerified: false,
  note: null,
});

const avail = (kind: AgentAvailability["kind"], extra: Partial<AgentAvailability> = {}): AgentAvailability => ({
  kind,
  path: "C:\\bin\\x.exe",
  version: "1",
  error: null,
  preset: null,
  label: null,
  supportsResume: true,
  ...extra,
});

describe("account helpers", () => {
  it("keys, masking and labels", () => {
    expect(accountKey({ agent: "codex", preset: null })).toBe("codex");
    expect(accountKey({ agent: "generic", preset: "hermes" })).toBe("hermes");
    expect(maskEmail("alice@example.com")).toBe("a…@example.com");
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("nodomain")).toBe("…");
    const a = acct("claude", "account1", { account: "bob@corp.io" });
    expect(accountLabel(a)).toBe("account1 · b…@corp.io");
    expect(accountLabel(acct("codex", "work"))).toBe("work");
    // Records from code that predates accounts are Claude accounts.
    const legacy = asAccount({ id: "p", name: "p", configDir: null, color: "#000000", status: st() });
    expect(legacy.agent).toBe("claude");
    expect(legacy.preset).toBeNull();
  });

  it("status chips", () => {
    expect(accountStatus(acct("codex", "w", { verified: true, loggedIn: true })).text).toBe("Signed in");
    expect(accountStatus(acct("codex", "w", { verified: true, loggedIn: false })).text).toBe("Not signed in");
    expect(accountStatus(acct("codex", "w", { dirExists: false })).text).toBe("Folder missing");
    expect(accountStatus(acct("codex", "w", { likelyAuthenticated: true })).text).toBe("Likely signed in");
    expect(accountStatus(acct("codex", "w")).text).toBe("Unknown");
    // A missing default home is not "folder missing" (Sign in creates it).
    expect(accountStatus(acct("codex", "Default", { dirExists: false, loggedIn: false })).text).toBe("Not signed in");
    expect(accountStatus(acct("generic", "Default", { likelyAuthenticated: true }), false).text).toBe("Configured");
    expect(accountStatus(acct("generic", "Default"), false).text).toBe("Not set up");
  });

  it("signed-in rule prefers verified status over file heuristics", () => {
    expect(isSignedIn(acct("claude", "a", { likelyAuthenticated: true }))).toBe(true);
    expect(isSignedIn(acct("claude", "a", { likelyAuthenticated: true, verified: true, loggedIn: false }))).toBe(false);
    expect(isSignedIn(acct("codex", "a", { verified: true, loggedIn: true }))).toBe(true);
    expect(isSignedIn(acct("codex", "a"))).toBe(false);
  });

  it("groups by agent in backend order, keeping empty supported agents", () => {
    const hermes = acct("generic", "Default", {}, { preset: "hermes" });
    const list = [acct("codex", "work"), acct("claude", "Default"), hermes, acct("claude", "account1")];
    const groups = groupAccounts(list, [info("claude", "Claude Code"), info("codex", "Codex"), info("hermes", "Hermes Agent"), info("kimi", "Kimi", "none")]);
    expect(groups.map((g) => g.key)).toEqual(["claude", "codex", "hermes"]);
    expect(groups[0].accounts.map((a) => a.name)).toEqual(["Default", "account1"]);
    expect(groups[2].accounts).toEqual([hermes]);
    const empty = groupAccounts([], [info("claude", "Claude Code"), info("codex", "Codex")]);
    expect(empty.map((g) => [g.key, g.accounts.length])).toEqual([
      ["claude", 0],
      ["codex", 0],
    ]);
  });

  it("picker lists and defaults", () => {
    const c1 = acct("codex", "a", { verified: true, loggedIn: false });
    const c2 = acct("codex", "b", { verified: true, loggedIn: true });
    const cl = acct("claude", "Default");
    const all = [cl, c1, c2];
    expect(accountsFor(all, "codex")).toEqual([c1, c2]);
    expect(accountsFor(all, "powershell")).toEqual([]);
    expect(accountsFor(all, "generic", null)).toEqual([]);
    expect(defaultAccountId([c1, c2], c1.id)).toBe(c1.id);
    expect(defaultAccountId([c1, c2], "gone")).toBe(c2.id);
    expect(defaultAccountId([c1], null)).toBe(c1.id);
    expect(defaultAccountId([], "x")).toBeNull();
  });

  it("counts live sessions per agent and account", () => {
    const run = (id: string, agent: SessionInfo["agent"], profileId: string | null, state: SessionInfo["state"] = { state: "running" }): SessionInfo => ({
      id,
      name: id,
      agent,
      pid: 1,
      state,
      cwd: "C:\\",
      profileId,
      commandDisplay: "",
      startedAt: null,
      endedAt: null,
      bytesOut: 0,
    });
    const rt = {
      a: run("a", "codex", "w"),
      b: run("b", "codex", "w", { state: "exited", code: 0 }),
      c: run("c", "claude", "w"),
      d: run("d", "codex", null),
    };
    expect(liveOnAccount(rt, "codex", "w")).toBe(1);
    expect(liveOnAccount(rt, "codex", null)).toBe(1);
    expect(liveOnAccount(rt, "claude", "w")).toBe(1);
  });

  it("quick launch: one card per signed-in account, plain card otherwise", () => {
    const work = acct("codex", "work", { verified: true, loggedIn: true });
    const off = acct("codex", "off", { verified: true, loggedIn: false });
    const c1 = acct("claude", "account1", { likelyAuthenticated: true });
    const c2 = acct("claude", "account2", { likelyAuthenticated: true });
    const hermes = acct("generic", "Default", { likelyAuthenticated: true }, { preset: "hermes" });
    const agents = [
      avail("powershell"),
      avail("claude"),
      avail("codex"),
      avail("generic", { preset: "hermes", label: "Hermes Agent" }),
      avail("generic", { preset: "kimi", label: "Kimi CLI" }),
      avail("generic", { preset: "gemini", label: "Gemini CLI", error: "not working" }),
    ];
    const opts = launchOptions([c1, c2, work, off, hermes], agents);
    expect(opts.map((o) => (o.hint ? `${o.label} · ${o.hint}` : o.label))).toEqual([
      "PowerShell",
      "Claude Code · account1",
      "Claude Code · account2",
      "Codex · work",
      "Hermes Agent · Default",
      "Kimi CLI",
    ]);
    expect(opts.find((o) => o.hint === "work")?.profileId).toBe(work.id);
    expect(opts.find((o) => o.label === "Hermes Agent")).toMatchObject({ agent: "generic", preset: "hermes", profileId: hermes.id });
    expect(new Set(opts.map((o) => o.key)).size).toBe(opts.length);

    // Nothing signed in (or not scanned yet) → plain per-agent cards; missing executables disable them.
    const plain = launchOptions([off], [avail("powershell"), avail("claude", { path: null }), avail("codex")]);
    expect(plain.map((o) => [o.label, o.profileId ?? null, !!o.disabled])).toEqual([
      ["PowerShell", null, false],
      ["Claude Code", null, true],
      ["Codex", null, false],
    ]);
  });
});
