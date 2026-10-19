// Accounts dialog (file kept as ProfilesDialog): accounts of every agent with account isolation
// (Claude Code, Codex, Hermes), grouped by agent. Accounts are found automatically; adding one
// creates an empty home folder and opens the agent's own sign-in in a pane. Remove = entry only.

import { APP_NAME } from "../lib/brand";
import { memo, useEffect, useMemo, useState } from "react";
import { addAccount, checkAccount, refreshAccounts, restoreDismissedAccounts, scanAccounts, signIn, useAccountScan } from "../actions/accounts";
import { notify } from "../actions/notify";
import { useT } from "../i18n";
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
  const t = useT();
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
      title={t("accounts.title")}
      onClose={onClose}
      width={720}
      headerExtra={
        <>
          <Button size="sm" icon={<IconRestart size={12} />} onClick={() => void scanAccounts()} disabled={scanning} title={t("accounts.rescanTitle")}>
            {scanning ? t("accounts.scanning") : t("accounts.rescan")}
          </Button>
          {!adding && (
            <Button size="sm" icon={<IconPlus size={12} />} onClick={() => setAdding(groups[0]?.key ?? "claude")}>
              {t("accounts.add")}
            </Button>
          )}
        </>
      }
      footer={<Button onClick={onClose}>{t("common.done")}</Button>}
    >
      <p className="explain explain-top">{t.rich("accounts.explain", { app: APP_NAME, mono: (c) => <span className="mono">{c}</span> })}</p>
      {adding && <AddAccountForm infos={infos.filter((i) => i.isolation === "verified")} initialKey={adding} onDone={() => setAdding(null)} />}
      {groups.map((g) => (
        <AgentGroup key={g.key} group={g} onAdd={() => setAdding(g.key)} />
      ))}
      {groups.length === 0 && <div className="empty-row">{scanning ? t("accounts.looking") : t("accounts.none")}</div>}
      {dismissed > 0 && (
        <div className="field-msg accounts-hidden">
          {t("accounts.hiddenFolders", { count: dismissed })}{" "}
          <button type="button" className="link-btn" onClick={() => void restoreDismissedAccounts()}>
            {t("accounts.showAgain")}
          </button>
        </div>
      )}
      {noIsolation.length > 0 && <p className="explain">{t("accounts.noIsolation", { tools: noIsolation.map((i) => i.label).join(", ") })}</p>}
    </Modal>
  );
}

/** Preferred name. */
export const AccountsDialog = ProfilesDialog;

function AgentGroup({ group, onAdd }: { group: AccountGroup; onAdd: () => void }) {
  const t = useT();
  const info = group.info;
  return (
    <div className="account-group">
      <div className="account-group-head">
        <span className="section-label">{group.label}</span>
        {info?.homeEnv && <span className="muted mono account-env">{info.homeEnv}</span>}
        {info && !info.installed && <span className="chip tone-warn">{t("accounts.notInstalled")}</span>}
        <button type="button" className="link-btn push-right" onClick={onAdd}>
          {t("accounts.addFor", { agent: group.label })}
        </button>
      </div>
      <div className="profile-list">
        {group.accounts.length === 0 && <div className="empty-row">{t("accounts.noneForAgent")}</div>}
        {group.accounts.map((a) => (
          <AccountRow key={a.id} account={a} info={info} />
        ))}
      </div>
    </div>
  );
}

const AccountRow = memo(function AccountRow({ account, info }: { account: Account; info: AccountAgentInfo | null }) {
  const t = useT();
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
      notify("error", t("accounts.toast.checkFailed", { error: errorMessage(e) }));
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
      notify("error", t("accounts.toast.saveFailed", { error: errorMessage(e) }));
    }
  };

  const remove = async () => {
    const inUse = useApp.getState().persisted.sessions.filter((m) => m.profileId === account.id).length;
    const ok = await confirmDialog({
      title: t("accounts.removeTitle", { name: account.name }),
      message: inUse ? t("accounts.removeMessageInUse", { app: APP_NAME, count: inUse }) : t("accounts.removeMessage", { app: APP_NAME }),
      detail: account.configDir ?? account.resolvedDir ?? undefined,
      confirmLabel: t("accounts.removeConfirm"),
      danger: true,
    });
    if (!ok) return;
    try {
      await ipc.profileDelete(account.id);
      await refreshAccounts();
    } catch (e) {
      notify("error", t("accounts.toast.removeFailed", { error: errorMessage(e) }));
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
              aria-label={t("accounts.nameAria")}
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
              {t("common.save")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        ) : (
          <div className="profile-name-row">
            <span className="profile-name">{account.name}</span>
            {email && <span className="muted profile-account">{email}</span>}
            <span className={`chip tone-${st.tone}`}>{signingIn ? t("accounts.signingIn") : st.text}</span>
            {account.status.authMethod && account.status.authMethod !== "none" && <span className="chip">{account.status.authMethod}</span>}
            {account.autoDetected && (
              <span className="chip" title={t("accounts.autoDetectedTitle")}>
                {t("accounts.autoDetected")}
              </span>
            )}
          </div>
        )}
        <div className="profile-dir mono" title={account.resolvedDir ?? account.configDir ?? undefined}>
          {account.configDir ?? (account.resolvedDir ? t("accounts.defaultDir", { dir: account.resolvedDir }) : t("accounts.defaultDirUnknown"))}
        </div>
        {account.status.note && <div className="field-msg">{account.status.note}</div>}
      </div>
      {!editing && (
        <div className="profile-actions">
          {!signedIn && info?.isolation === "verified" && (
            <Button size="sm" variant="primary" onClick={() => signIn(account)} disabled={signingIn} title={info.loginHint ?? undefined}>
              {signingIn ? t("accounts.signingIn") : hasStatus ? t("accounts.signIn") : t("accounts.setUp")}
            </Button>
          )}
          {!signedIn && info?.deviceLoginArgs && !signingIn && (
            <Button size="sm" variant="ghost" onClick={() => signIn(account, { device: true })} title={t("accounts.deviceCodeTitle", { args: info.deviceLoginArgs.join(" ") })}>
              {t("accounts.deviceCode")}
            </Button>
          )}
          {hasStatus && (
            <Button size="sm" onClick={() => void check()} disabled={checking}>
              {checking ? t("accounts.checking") : t("accounts.check")}
            </Button>
          )}
          <IconButton size="sm" label={t("accounts.renameColour")} onClick={() => setEditing(true)}>
            <IconEdit size={13} />
          </IconButton>
          <IconButton size="sm" label={t("accounts.removeEntry")} onClick={() => void remove()}>
            <IconTrash size={13} />
          </IconButton>
        </div>
      )}
    </div>
  );
});

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const t = useT();
  return (
    <div className="color-picker" role="radiogroup" aria-label={t("accounts.colour")}>
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
  const t = useT();
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
    const timer = window.setTimeout(() => {
      ipc
        .accountsPlanHome(info.agent, info.preset, name)
        .then((p) => !cancelled && setPlan(p))
        .catch((e) => {
          if (!cancelled) setError(errorMessage(e));
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [info, name, customDir]);

  const blocked = !!plan && plan.exists && !plan.empty && !useExisting;
  const submit = async () => {
    setError(null);
    if (!info) return;
    if (!name.trim()) {
      setError(t("accounts.form.nameRequired"));
      return;
    }
    if (blocked) {
      setError(t("accounts.form.folderNotEmpty"));
      return;
    }
    setBusy(true);
    try {
      const a = await addAccount(info, name, { useExisting: useExisting || !!customDir.trim(), homeDir: customDir.trim() || null, color, device });
      notify("info", t("accounts.toast.added", { name: a.name }));
      onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <div className="empty-row">{t("accounts.form.noAgents")}</div>;
  // The command line itself is shown verbatim; only the "then /login" wording follows the UI language.
  const loginText = info.loginArgs.length
    ? `${info.key} ${(device && info.deviceLoginArgs ? info.deviceLoginArgs : info.loginArgs).join(" ")}`
    : t("accounts.form.loginThenSlash", { command: info.key });

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
      <div className="section-label">{t("accounts.form.title")}</div>
      <Field label={t("accounts.form.agent")} htmlFor="aa-agent" hint={!info.installed ? t("accounts.form.notInstalledHint", { agent: info.label }) : undefined}>
        <Select id="aa-agent" value={key} onChange={(e) => setKey(e.target.value)}>
          {infos.map((i) => (
            <option key={i.key} value={i.key}>
              {i.installed ? i.label : t("accounts.form.optionNotInstalled", { agent: i.label })}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("accounts.form.name")} htmlFor="aa-name">
        <Input id="aa-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("accounts.form.namePlaceholder")} data-autofocus autoFocus />
      </Field>
      <Field
        label={t("accounts.form.folder")}
        htmlFor="aa-dir"
        error={error}
        hint={
          customDir.trim()
            ? t("accounts.form.folderCustom")
            : plan
              ? plan.exists
                ? plan.empty
                  ? t("accounts.form.folderEmpty", { path: plan.path })
                  : t("accounts.form.folderExists", { path: plan.path })
                : t("accounts.form.folderNew", { path: plan.path })
              : t("accounts.form.folderAuto")
        }
      >
        <div className="input-group">
          <Input id="aa-dir" mono value={customDir} onChange={(e) => setCustomDir(e.target.value)} placeholder={plan?.path ?? t("accounts.form.automatic")} />
          <Button
            icon={<IconFolder size={13} />}
            onClick={async () => {
              const d = await pickFolder(t("accounts.form.homeFolder", { agent: info.label }));
              if (d) setCustomDir(d);
            }}
          >
            {t("common.browse")}
          </Button>
        </div>
      </Field>
      {plan && plan.exists && !plan.empty && !customDir.trim() && (
        <Toggle checked={useExisting} onChange={setUseExisting} label={t("accounts.form.useExisting")} hint={t("accounts.form.useExistingHint")} />
      )}
      {info.deviceLoginArgs && <Toggle checked={device} onChange={setDevice} label={t("accounts.form.device")} hint={t("accounts.form.deviceHint")} />}
      <Field label={t("accounts.colour")}>
        <ColorPicker value={color} onChange={setColor} />
      </Field>
      <p className="explain">
        {t.rich("accounts.form.explain", { app: APP_NAME, command: loginText, env: info.homeEnv, mono: (c) => <span className="mono">{c}</span> })}
      </p>
      <div className="row-end">
        <Button variant="ghost" onClick={onDone}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" onClick={() => void submit()} disabled={busy || blocked}>
          {busy ? t("accounts.form.creating") : t("accounts.form.create")}
        </Button>
      </div>
    </div>
  );
}
