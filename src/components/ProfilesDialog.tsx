// Accounts dialog (file kept as ProfilesDialog): accounts of every agent with account isolation
// (Claude Code, Codex, Hermes), grouped by agent. Accounts are found automatically; adding one
// creates an empty home folder and opens the agent's own sign-in in a pane. Remove = entry only.

import { APP_NAME } from "../lib/brand";
import { memo, useEffect, useMemo, useState } from "react";
import { addAccount, checkAccount, refreshAccounts, restoreDismissedAccounts, scanAccounts, signIn, useAccountScan } from "../actions/accounts";
import { notify } from "../actions/notify";
import { accountStatus, groupAccounts, isSignedIn, maskEmail, type AccountGroup } from "../lib/accounts";
import { errorMessage, ipc } from "../lib/ipc";
import type { Account, AccountAgentInfo, PlannedHome } from "../lib/types";
import { useApp } from "../store/appStore";
import { confirmDialog } from "../store/uiStore";
import { IconEdit, IconFolder, IconPlus, IconRestart, IconTrash } from "./icons";
import { Button, IconButton } from "./ui/Button";
import { Field, Input, Select, Toggle } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { pickFolder } from "./util/pick";

const COLORS = ["#7b61ff", "#58a6ff", "#3fb950", "#d29922", "#f85149", "#db61a2", "#39c5cf", "#a9a9b6"];

export function ProfilesDialog({ onClose }: { onClose: () => void }) {
  const accounts = useApp((s) => s.accounts);
  const infos = useApp((s) => s.accountAgents);
  const agents = useApp((s) => s.agents);
  const dismissed = useApp((s) => s.dismissedAccounts);
  const scanning = useAccountScan((s) => s.scanning);
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    void refreshAccounts();
  }, []);

  const groups = useMemo(() => groupAccounts(accounts, infos), [accounts, infos]);
  // Installed tools without account isolation (broken installs reported by detection are left out).
  const noIsolation = infos.filter((i) => i.isolation === "none" && !agents.some((a) => a.preset === i.preset && a.error));

  return (
    <Modal
      title="Accounts"
      onClose={onClose}
      width={720}
      headerExtra={
        <>
          <Button size="sm" icon={<IconRestart size={12} />} onClick={() => void scanAccounts()} disabled={scanning} title="Find account folders and check every sign-in again">
            {scanning ? "Scanning…" : "Rescan"}
          </Button>
          {!adding && (
            <Button size="sm" icon={<IconPlus size={12} />} onClick={() => setAdding(groups[0]?.key ?? "claude")}>
              Add account
            </Button>
          )}
        </>
      }
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <p className="explain explain-top">
        {APP_NAME} finds each agent's account folders automatically and checks sign-in with the agent's own status command. Every account is a separate home folder (
        <span className="mono">CLAUDE_CONFIG_DIR</span>, <span className="mono">CODEX_HOME</span>, <span className="mono">HERMES_HOME</span>) with its own login and history, so sessions on
        different accounts run side by side. {APP_NAME} never reads or copies credentials.
      </p>
      {adding && <AddAccountForm infos={infos.filter((i) => i.isolation === "verified")} initialKey={adding} onDone={() => setAdding(null)} />}
      {groups.map((g) => (
        <AgentGroup key={g.key} group={g} onAdd={() => setAdding(g.key)} />
      ))}
      {groups.length === 0 && <div className="empty-row">{scanning ? "Looking for accounts…" : "No accounts found yet. Use Rescan or Add account."}</div>}
      {dismissed > 0 && (
        <div className="field-msg accounts-hidden">
          {dismissed} removed account folder{dismissed === 1 ? " is" : "s are"} hidden from the scan.{" "}
          <button type="button" className="link-btn" onClick={() => void restoreDismissedAccounts()}>
            Show again
          </button>
        </div>
      )}
      {noIsolation.length > 0 && (
        <p className="explain">
          Also installed, without account isolation (each uses its single login): {noIsolation.map((i) => i.label).join(", ")}.
        </p>
      )}
    </Modal>
  );
}

/** Preferred name. */
export const AccountsDialog = ProfilesDialog;

function AgentGroup({ group, onAdd }: { group: AccountGroup; onAdd: () => void }) {
  const info = group.info;
  return (
    <div className="account-group">
      <div className="account-group-head">
        <span className="section-label">{group.label}</span>
        {info?.homeEnv && <span className="muted mono account-env">{info.homeEnv}</span>}
        {info && !info.installed && <span className="chip tone-warn">Not installed</span>}
        <button type="button" className="link-btn push-right" onClick={onAdd}>
          Add {group.label} account
        </button>
      </div>
      <div className="profile-list">
        {group.accounts.length === 0 && <div className="empty-row">No accounts yet.</div>}
        {group.accounts.map((a) => (
          <AccountRow key={a.id} account={a} info={info} />
        ))}
      </div>
    </div>
  );
}

const AccountRow = memo(function AccountRow({ account, info }: { account: Account; info: AccountAgentInfo | null }) {
  const [checking, setChecking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account.name);
  const [color, setColor] = useState(account.color);
  const signingIn = useAccountScan((s) => !!s.signingIn[account.id]);
  const hasStatus = info?.hasStatusCommand ?? true;
  const st = accountStatus(account, hasStatus);
  const signedIn = isSignedIn(account);
  const email = maskEmail(account.status.account);

  const check = async () => {
    setChecking(true);
    try {
      await checkAccount(account.id);
    } catch (e) {
      notify("error", `Check failed: ${errorMessage(e)}`);
    } finally {
      setChecking(false);
    }
  };

  const save = async () => {
    try {
      await ipc.profileUpdate({ ...account, name: name.trim() || account.name, color });
      await refreshAccounts();
      setEditing(false);
    } catch (e) {
      notify("error", `Could not save account: ${errorMessage(e)}`);
    }
  };

  const remove = async () => {
    const inUse = useApp.getState().persisted.sessions.filter((m) => m.profileId === account.id).length;
    const ok = await confirmDialog({
      title: `Remove account “${account.name}”?`,
      message:
        `Removes the entry from ${APP_NAME} only. The folder — including its login and history — is NOT deleted, and the automatic scan will not add it again (use “Show again” to undo).` +
        (inUse ? ` ${inUse} session definition${inUse === 1 ? " uses" : "s use"} it and will need another account on next start.` : ""),
      detail: account.configDir ?? account.resolvedDir ?? undefined,
      confirmLabel: "Remove entry",
      danger: true,
    });
    if (!ok) return;
    try {
      await ipc.profileDelete(account.id);
      await refreshAccounts();
    } catch (e) {
      notify("error", `Could not remove account: ${errorMessage(e)}`);
    }
  };

  return (
    <div className="profile-row">
      <span className="dot dot-lg" style={{ background: editing ? color : account.color }} />
      <div className="profile-main">
        {editing ? (
          <div className="profile-edit">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Account name"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void save();
                }
              }}
            />
            <ColorPicker value={color} onChange={setColor} />
            <Button size="sm" variant="primary" onClick={() => void save()}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="profile-name-row">
            <span className="profile-name">{account.name}</span>
            {email && <span className="muted profile-account">{email}</span>}
            <span className={`chip tone-${st.tone}`}>{signingIn ? "Signing in…" : st.text}</span>
            {account.status.authMethod && account.status.authMethod !== "none" && <span className="chip">{account.status.authMethod}</span>}
            {account.autoDetected && <span className="chip" title="Found automatically by the account scan">auto-detected</span>}
          </div>
        )}
        <div className="profile-dir mono" title={account.resolvedDir ?? account.configDir ?? undefined}>
          {account.configDir ?? `Default (${account.resolvedDir ?? "agent's default folder"})`}
        </div>
        {account.status.note && <div className="field-msg">{account.status.note}</div>}
      </div>
      {!editing && (
        <div className="profile-actions">
          {!signedIn && info?.isolation === "verified" && (
            <Button size="sm" variant="primary" onClick={() => signIn(account)} disabled={signingIn} title={info.loginHint ?? undefined}>
              {signingIn ? "Signing in…" : hasStatus ? "Sign in" : "Set up"}
            </Button>
          )}
          {!signedIn && info?.deviceLoginArgs && !signingIn && (
            <Button size="sm" variant="ghost" onClick={() => signIn(account, { device: true })} title={`Sign in with a device code (${info.deviceLoginArgs.join(" ")})`}>
              Device code
            </Button>
          )}
          {hasStatus && (
            <Button size="sm" onClick={() => void check()} disabled={checking}>
              {checking ? "Checking…" : "Check"}
            </Button>
          )}
          <IconButton size="sm" label="Rename / colour" onClick={() => setEditing(true)}>
            <IconEdit size={13} />
          </IconButton>
          <IconButton size="sm" label="Remove account entry" onClick={() => void remove()}>
            <IconTrash size={13} />
          </IconButton>
        </div>
      )}
    </div>
  );
});

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="color-picker" role="radiogroup" aria-label="Colour">
      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value.toLowerCase() === c}
          aria-label={c}
          className={`swatch${value.toLowerCase() === c ? " is-selected" : ""}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  );
}

function AddAccountForm({ infos, initialKey, onDone }: { infos: AccountAgentInfo[]; initialKey: string; onDone: () => void }) {
  const count = useApp((s) => s.accounts.length);
  const [key, setKey] = useState(infos.some((i) => i.key === initialKey) ? initialKey : (infos[0]?.key ?? ""));
  const info = infos.find((i) => i.key === key) ?? null;
  const [name, setName] = useState("");
  const [customDir, setCustomDir] = useState("");
  const [useExisting, setUseExisting] = useState(false);
  const [device, setDevice] = useState(false);
  const [color, setColor] = useState(COLORS[count % COLORS.length]);
  const [plan, setPlan] = useState<PlannedHome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Path preview for the new home (listing only; nothing is created until submit).
  useEffect(() => {
    setPlan(null);
    setUseExisting(false);
    setError(null);
    if (!info || !name.trim() || customDir.trim()) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      ipc
        .accountsPlanHome(info.agent, info.preset, name)
        .then((p) => !cancelled && setPlan(p))
        .catch((e) => {
          if (!cancelled) setError(errorMessage(e));
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [info, name, customDir]);

  const blocked = !!plan && plan.exists && !plan.empty && !useExisting;
  const submit = async () => {
    setError(null);
    if (!info) return;
    if (!name.trim()) {
      setError("Enter a name");
      return;
    }
    if (blocked) {
      setError("That folder already exists and is not empty. Use it as is, or pick another name.");
      return;
    }
    setBusy(true);
    try {
      const a = await addAccount(info, name, { useExisting: useExisting || !!customDir.trim(), homeDir: customDir.trim() || null, color, device });
      notify("info", `Account “${a.name}” added`);
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <div className="empty-row">No agent with account support is available.</div>;
  const loginText = info.loginArgs.length ? `${info.key} ${(device && info.deviceLoginArgs ? info.deviceLoginArgs : info.loginArgs).join(" ")}` : `${info.key}, then /login`;

  return (
    <div
      className="add-profile"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.target as HTMLElement).tagName === "INPUT") {
          e.preventDefault();
          void submit();
        }
      }}
    >
      <div className="section-label">New account</div>
      <Field label="Agent" htmlFor="aa-agent" hint={!info.installed ? `${info.label} is not installed on this PC` : undefined}>
        <Select id="aa-agent" value={key} onChange={(e) => setKey(e.target.value)}>
          {infos.map((i) => (
            <option key={i.key} value={i.key}>
              {i.label}
              {i.installed ? "" : " (not installed)"}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Name" htmlFor="aa-name">
        <Input id="aa-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. work" data-autofocus autoFocus />
      </Field>
      <Field
        label="Folder"
        htmlFor="aa-dir"
        error={error}
        hint={
          customDir.trim()
            ? "This folder is used as is (created if missing)."
            : plan
              ? plan.exists
                ? plan.empty
                  ? `${plan.path} — exists and is empty; it will be used.`
                  : `${plan.path} — already exists and is not empty.`
                : `${plan.path} — a new empty folder.`
              : "Created automatically from the name. Choose a folder only to use a different location."
        }
      >
        <div className="input-group">
          <Input id="aa-dir" mono value={customDir} onChange={(e) => setCustomDir(e.target.value)} placeholder={plan?.path ?? "automatic"} />
          <Button
            icon={<IconFolder size={13} />}
            onClick={async () => {
              const d = await pickFolder(`${info.label} home folder`);
              if (d) setCustomDir(d);
            }}
          >
            Browse…
          </Button>
        </div>
      </Field>
      {plan && plan.exists && !plan.empty && !customDir.trim() && (
        <Toggle checked={useExisting} onChange={setUseExisting} label="Use existing folder" hint="Added as is; nothing in it is changed." />
      )}
      {info.deviceLoginArgs && <Toggle checked={device} onChange={setDevice} label="Sign in with a device code" hint="For when the browser is on another device." />}
      <Field label="Colour">
        <ColorPicker value={color} onChange={setColor} />
      </Field>
      <p className="explain">
        After creating the folder, a pane opens running <span className="mono">{loginText}</span> with <span className="mono">{info.homeEnv}</span> set to it — the agent's own sign-in.
        {" "}The account is marked ready as soon as the agent reports it is signed in. {APP_NAME} never
        copies credentials between accounts.
      </p>
      <div className="row-end">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void submit()} disabled={busy || blocked}>
          {busy ? "Creating…" : "Create & sign in"}
        </Button>
      </div>
    </div>
  );
}
