// Account actions: load / scan accounts of every agent, add one, and run an agent's own sign-in
// in a pane. Credentials never pass through Gridkeeper: each agent signs in with its own
// official flow (`/login`, `codex login`, `hermes setup`) inside its isolated home folder.

import { create } from "zustand";
import { accountKey, isSignedIn } from "../lib/accounts";
import { errorMessage, ipc } from "../lib/ipc";
import type { Account, AccountAgentInfo, SessionId } from "../lib/types";
import { isLive, selectActiveGroup, selectActiveWorkspace, useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { writeLocalNotice } from "../terminal/registry";
import { notify } from "./notify";
import { newSession } from "./sessions";
import { t } from "../i18n";

interface ScanState {
  scanning: boolean;
  /** Account ids with a sign-in pane being watched. */
  signingIn: Record<string, SessionId>;
}

export const useAccountScan = create<ScanState>()(() => ({ scanning: false, signingIn: {} }));

/** Saved accounts with filename-only status (instant). */
export async function refreshAccounts(): Promise<void> {
  try {
    const snap = await ipc.accountsList();
    mergeAccounts(snap.accounts, snap.dismissed, false);
  } catch (e) {
    notify("error", t("accounts.toast.loadFailed", { error: errorMessage(e) }));
  }
}

export async function loadAccountAgents(): Promise<void> {
  try {
    useApp.getState().setAccountAgents(await ipc.accountsSpecs());
  } catch {
    /* backend unavailable */
  }
}

/**
 * Replace the account list. `verified` lists carry fresh status; otherwise a status verified
 * earlier in this run is kept (a filename-only list must not downgrade "Signed in" to "Likely").
 */
function mergeAccounts(next: Account[], dismissed: number, verified: boolean) {
  const prev = new Map(useApp.getState().accounts.map((a) => [a.id, a]));
  const list = verified
    ? next
    : next.map((a) => {
        const p = prev.get(a.id);
        return p?.status.verified && a.status.dirExists ? { ...a, status: p.status } : a;
      });
  useApp.getState().setAccounts(list, dismissed);
}

let scanInFlight: Promise<void> | null = null;

/** Detect new account homes and verify all accounts (runs at startup and on "Rescan"). */
export function scanAccounts(opts: { announce?: boolean } = {}): Promise<void> {
  if (scanInFlight) return scanInFlight;
  useAccountScan.setState({ scanning: true });
  scanInFlight = (async () => {
    const before = new Set(useApp.getState().accounts.map((a) => a.id));
    try {
      const snap = await ipc.accountsScan();
      mergeAccounts(snap.accounts, snap.dismissed, true);
      const added = snap.accounts.filter((a) => a.autoDetected && !before.has(a.id));
      if (opts.announce !== false && added.length > 0 && before.size > 0) {
        const infos = useApp.getState().accountAgents;
        const names = added.map((a) => `${infos.find((i) => i.key === accountKey(a))?.label ?? accountKey(a)} · ${a.name}`);
        notify("info", t("accounts.toast.found", { count: added.length, names: names.join(", ") }), 6000);
      }
    } catch (e) {
      notify("error", t("accounts.toast.scanFailed", { error: errorMessage(e) }));
    } finally {
      useAccountScan.setState({ scanning: false });
      scanInFlight = null;
    }
  })();
  return scanInFlight;
}

export function infoFor(a: Pick<Account, "agent" | "preset">): AccountAgentInfo | undefined {
  return useApp.getState().accountAgents.find((i) => i.key === accountKey(a));
}

/** Run the account's status command and store the result. */
export async function checkAccount(id: string): Promise<Account | undefined> {
  const status = await ipc.profileCheck(id);
  const s = useApp.getState();
  const accounts = s.accounts.map((a) => (a.id === id ? { ...a, status } : a));
  s.setAccounts(accounts);
  return accounts.find((a) => a.id === id);
}

function parentDir(p: string | null | undefined): string | null {
  if (!p) return null;
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return i > 0 ? trimmed.slice(0, i) : null;
}

const WATCH_MS = 6000;
const WATCH_MAX_MS = 15 * 60_000;

/** Poll the account's status while its sign-in pane runs; toast when it becomes signed in. */
function watchSignIn(sessionId: SessionId, accountId: string, label: string, hasStatus: boolean) {
  useAccountScan.setState((s) => ({ signingIn: { ...s.signingIn, [accountId]: sessionId } }));
  const started = Date.now();
  let busy = false;
  let sawLive = false;
  let bannerShown = false;
  const stop = () => {
    window.clearInterval(timer);
    unsub();
    useAccountScan.setState((s) => {
      const { [accountId]: _, ...rest } = s.signingIn;
      return { signingIn: rest };
    });
  };
  const tick = async (final: boolean) => {
    if (busy) return;
    busy = true;
    try {
      const a = await checkAccount(accountId);
      const done = hasStatus ? a?.status.verified && a.status.loggedIn === true : !!a && isSignedIn(a);
      if (done) {
        notify("info", hasStatus ? t("accounts.toast.signedIn", { label }) : t("accounts.toast.setUp", { label }), 6000);
        stop();
      } else if (final) {
        notify("warn", t("accounts.toast.signInIncomplete", { label }), 8000);
        stop();
      }
    } catch {
      if (final) stop();
    } finally {
      busy = false;
    }
  };
  const timer = window.setInterval(() => {
    const st = useApp.getState();
    if (!st.persisted.sessions.some((m) => m.id === sessionId) || Date.now() - started > WATCH_MAX_MS) return stop();
    if (isLive(st.runtime[sessionId]) && hasStatus) void tick(false);
  }, WATCH_MS);
  const unsub = useApp.subscribe((s) => {
    const rt = s.runtime[sessionId];
    if (isLive(rt)) {
      sawLive = true;
      if (!bannerShown && rt?.state.state === "running") {
        bannerShown = true;
        const hint = infoFor(s.accounts.find((a) => a.id === accountId) ?? { agent: rt.agent, preset: null })?.loginHint;
        // Terminal content (the agent's own login hint, from the backend): stays English.
        if (hint) window.setTimeout(() => writeLocalNotice(sessionId, `[Gridkeeper] ${label}: ${hint}`), 200);
      }
    } else if (sawLive && rt && (rt.state.state === "exited" || rt.state.state === "failed")) {
      // The login process ended (codex login exits 0 on success): one last check.
      sawLive = false;
      window.setTimeout(() => void tick(true), 500);
    }
  });
}

/**
 * Open a pane in the active group running the agent's own sign-in for `account`
 * (Claude: `claude` + type /login; Codex: `codex login`; Hermes: `hermes setup`).
 */
export function signIn(account: Account, opts: { device?: boolean } = {}): SessionId | null {
  const info = infoFor(account);
  if (!info || info.isolation !== "verified") {
    notify("error", t("accounts.toast.noSignInSupport"));
    return null;
  }
  const watching = useAccountScan.getState().signingIn[account.id];
  if (watching && isLive(useApp.getState().runtime[watching])) {
    useApp.getState().setFocused(watching);
    return watching;
  }
  const s = useApp.getState();
  const ws = selectActiveWorkspace(s);
  const group = selectActiveGroup(s);
  if (!ws || !group) {
    notify("error", t("accounts.toast.openWorkspace"));
    return null;
  }
  const cwd = ws.projectDir ?? parentDir(account.resolvedDir ?? account.configDir);
  if (!cwd) {
    notify("error", t("accounts.toast.chooseFolder"));
    return null;
  }
  const args = (opts.device && info.deviceLoginArgs) || info.loginArgs;
  const label = `${info.label} · ${account.name}`;
  const id = newSession({
    groupId: group.id,
    agent: account.agent,
    preset: account.preset,
    profileId: account.id,
    cwd,
    name: t("accounts.signInSessionName", { label }),
    args,
    autoStart: false,
    resumeOnRestore: { mode: "none" },
    noAutoRetry: true,
  });
  useUi.getState().markVisited(ws.id);
  if (info.loginHint) notify("info", `${label}: ${info.loginHint}`, 9000);
  watchSignIn(id, account.id, label, info.hasStatusCommand);
  return id;
}

/** "Add account": create an empty home for the agent, then start its sign-in. */
export async function addAccount(
  info: AccountAgentInfo,
  name: string,
  opts: { useExisting?: boolean; homeDir?: string | null; color?: string | null; device?: boolean; signIn?: boolean } = {},
): Promise<Account> {
  const account = await ipc.accountsCreate(info.agent, info.preset, name.trim(), !!opts.useExisting, opts.homeDir ?? null, opts.color ?? null);
  await refreshAccounts();
  if (opts.signIn !== false) signIn(account, { device: opts.device });
  return account;
}

export async function restoreDismissedAccounts(): Promise<void> {
  try {
    await ipc.accountsRestoreDismissed();
    await scanAccounts();
  } catch (e) {
    notify("error", errorMessage(e));
  }
}
