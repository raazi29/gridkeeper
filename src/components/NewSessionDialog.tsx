// New session dialog (also used by split commands). Launches 1–8 identical sessions.

import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { checkAccount, signIn } from "../actions/accounts";
import { notify } from "../actions/notify";
import { newSession } from "../actions/sessions";
import { useT } from "../i18n";
import { accountsFor, accountStatus, defaultAccountId, isSignedIn, liveOnAccount, maskEmail } from "../lib/accounts";
import { errorMessage, ipc } from "../lib/ipc";
import { executablePlaceholder, folderPlaceholder, isMac } from "../lib/platform";
import type { AgentKind, GitInfo, LayoutPreset, WorktreeRef } from "../lib/types";
import { selectActiveWorkspace, useApp } from "../store/appStore";
import { confirmDialog, useUi } from "../store/uiStore";
import { IconBranch, IconFolder, IconWarn } from "./icons";
import { Button } from "./ui/Button";
import { Field, Input, Segmented, Select } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { RolePicker } from "./mission/RoleTag";
import { recordActivity } from "../store/activity";
import { MemoryPressureNotice } from "./ResourceWarnings";
import { pickExecutable, pickFolder } from "./util/pick";
import { AGENT_LABEL } from "./util/session";
import { defaultWorktreePath, isValidBranchName, splitArgs } from "./util/text";

type WtMode = "none" | "existing" | "new";
type PathState = { status: "idle" | "checking" | "ok" | "missing" | "unknown"; normalized?: string };

const AGENTS: AgentKind[] = ["powershell", "claude", "codex", "generic"];

export function NewSessionDialog({ groupId, preset, onClose }: { groupId?: string; preset?: LayoutPreset; onClose: () => void }) {
  const t = useT();
  const last = useUi((s) => s.lastSession);
  const agents = useApp((s) => s.agents);
  const agentPaths = useApp((s) => s.persisted.settings.agentPaths);
  const accounts = useApp((s) => s.accounts);
  const accountAgents = useApp((s) => s.accountAgents);
  const ws = useApp((s) => (groupId ? s.persisted.workspaces.find((w) => w.groups.some((g) => g.id === groupId)) : undefined) ?? selectActiveWorkspace(s));
  const groups = useApp(useShallow((s) => {
    const w = (groupId ? s.persisted.workspaces.find((x) => x.groups.some((g) => g.id === groupId)) : undefined) ?? selectActiveWorkspace(s);
    return w?.groups.map((g) => `${g.id}\u0000${g.name}`) ?? [];
  }));

  const [agent, setAgent] = useState<AgentKind>(last.agent);
  /** Account of the selected agent (Claude / Codex / catalog tool with account support). */
  const [profileId, setProfileId] = useState<string | null>(null);
  const [cwd, setCwd] = useState(ws?.projectDir ?? "");
  const [pathState, setPathState] = useState<PathState>({ status: "idle" });
  const [git, setGit] = useState<GitInfo | null>(null);
  const [wtMode, setWtMode] = useState<WtMode>("none");
  const [wtExisting, setWtExisting] = useState("");
  const [branch, setBranch] = useState("");
  const [newBranch, setNewBranch] = useState(true);
  const [wtPath, setWtPath] = useState("");
  const [wtPathEdited, setWtPathEdited] = useState(false);
  const [name, setName] = useState("");
  const [role, setRole] = useState<string | null>(null);
  const [argsText, setArgsText] = useState("");
  const [command, setCommand] = useState("");
  /** Catalog tool id when agent = generic ("" = custom command). */
  const [tool, setTool] = useState("");
  const tools = useMemo(() => agents.filter((a) => a.preset && !a.error), [agents]);
  const [count, setCount] = useState(1);
  const [target, setTarget] = useState(groupId ?? ws?.activeGroupId ?? ws?.groups[0]?.id ?? "");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const checkSeq = useRef(0);

  // ---- working directory validation (on mount, blur, picker return) -----------
  const validateCwd = async (path: string): Promise<PathState> => {
    const seq = ++checkSeq.current;
    const p = path.trim();
    setGit(null);
    let result: PathState = { status: "idle" };
    if (!p) {
      setPathState(result);
      return result;
    }
    setPathState({ status: "checking" });
    try {
      const info = await ipc.pathInfo(p);
      result = !info.exists || !info.isDir ? { status: "missing" } : { status: "ok", normalized: info.normalized ?? p };
      if (seq !== checkSeq.current) return result;
      setPathState(result);
      if (result.status === "ok") {
        try {
          const g = await ipc.gitInfo(result.normalized ?? p);
          if (seq === checkSeq.current) setGit(g.isRepo ? g : null);
        } catch {
          /* not a repo / backend unavailable */
        }
      }
    } catch {
      result = { status: "unknown" };
      if (seq === checkSeq.current) setPathState(result);
    }
    return result;
  };

  useEffect(() => {
    void validateCwd(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!git?.isRepo) setWtMode("none");
  }, [git]);

  useEffect(() => {
    if (!wtPathEdited && git?.root) setWtPath(branch.trim() ? defaultWorktreePath(git.root, branch) : "");
  }, [branch, git, wtPathEdited]);

  // ---- derived -------------------------------------------------------------------
  const availability = useMemo(() => {
    const map: Record<AgentKind, { ok: boolean; unknown: boolean; text: string }> = {} as never;
    for (const k of AGENTS) {
      if (k === "generic") {
        map[k] = { ok: true, unknown: false, text: t("newSession.availGeneric") };
        continue;
      }
      const configured = agentPaths[k as keyof typeof agentPaths];
      const a = agents.find((x) => x.kind === k);
      if (a?.path) map[k] = { ok: true, unknown: false, text: `${a.path}${a.version ? ` — ${a.version}` : ""}` };
      else if (configured) map[k] = { ok: true, unknown: false, text: t("newSession.availFromSettings", { path: configured }) };
      else if (!a) map[k] = { ok: true, unknown: true, text: t("newSession.availNotDetected") };
      else map[k] = { ok: false, unknown: false, text: a.error ? t("newSession.availNotFoundError", { error: a.error }) : t("newSession.availNotFound") };
    }
    return map;
  }, [agents, agentPaths, t]);

  const accountList = useMemo(
    () => (agent === "claude" || agent === "codex" ? accountsFor(accounts, agent) : agent === "generic" && tool ? accountsFor(accounts, "generic", tool) : []),
    [accounts, agent, tool],
  );
  const accountInfo = accountAgents.find((i) => i.key === (agent === "generic" ? tool : agent));
  const hasStatus = accountInfo?.hasStatusCommand ?? true;
  // The picker shows for any agent with at least one account (Claude always, as before).
  const showAccounts = agent === "claude" || accountList.length > 0;
  useEffect(() => {
    setProfileId((cur) => defaultAccountId(accountList, cur ?? last.profileId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountList]);
  const profile = accountList.find((p) => p.id === profileId) ?? null;
  const sameProfileLive = useApp((s) => (agent === "claude" || agent === "codex" ? liveOnAccount(s.runtime, agent, profileId) : 0));

  const args = useMemo(() => splitArgs(argsText), [argsText]);
  const avail = availability[agent];
  const branchOk = wtMode !== "new" || isValidBranchName(branch);
  const cwdError =
    pathState.status === "missing" ? t("newSession.cwdMissing") : submitted && !cwd.trim() ? t("newSession.cwdRequired") : null;
  const commandError = agent === "generic" && !tool && submitted && !command.trim() ? t("newSession.commandRequired") : null;
  const canSubmit =
    !busy &&
    avail.ok &&
    !!cwd.trim() &&
    pathState.status !== "missing" &&
    pathState.status !== "checking" &&
    (agent !== "generic" || !!tool || !!command.trim()) &&
    !!target &&
    (wtMode !== "existing" || !!wtExisting) &&
    (wtMode !== "new" || (branchOk && !!wtPath.trim()));

  const checkProfile = async () => {
    if (!profile) return;
    setChecking(true);
    try {
      await checkAccount(profile.id);
    } catch (e) {
      notify("error", t("newSession.accountCheckFailed", { error: errorMessage(e) }));
    } finally {
      setChecking(false);
    }
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setSubmitted(true);
    if (!canSubmit) return;
    setBusy(true);
    try {
      let ps = pathState;
      if (ps.status === "idle") ps = await validateCwd(cwd); // typed path + Enter without blur
      if (ps.status === "missing") return;
      const baseCwd = ps.normalized ?? cwd.trim();
      let worktree: WorktreeRef | null = null;
      if (wtMode === "existing") {
        const w = git?.worktrees.find((x) => x.path === wtExisting);
        if (w) worktree = { path: w.path, branch: w.branch };
      } else if (wtMode === "new" && git?.root) {
        const b = branch.trim();
        const p = wtPath.trim();
        // The git command itself is shown verbatim (never translated).
        const cmd = newBranch ? `git worktree add -b ${b} "${p}"` : `git worktree add "${p}" ${b}`;
        const ok = await confirmDialog({
          title: t("newSession.worktreeConfirmTitle"),
          message: newBranch
            ? git.branch
              ? t("newSession.worktreeConfirmNew", { branch: b, base: git.branch })
              : t("newSession.worktreeConfirmNewNoBase", { branch: b })
            : t("newSession.worktreeConfirmExisting", { branch: b }),
          detail: `cd "${git.root}"\n${cmd}`,
          confirmLabel: t("newSession.worktreeConfirm"),
        });
        if (!ok) {
          setBusy(false);
          return;
        }
        try {
          const info = await ipc.gitWorktreeAdd(git.root, p, b, newBranch);
          worktree = { path: info.path, branch: info.branch ?? b };
          notify("info", t("newSession.worktreeCreated", { path: info.path }));
          recordActivity({ sessionId: null, sessionName: "worktree", role: null, agent: null, kind: "worktree", level: "ok", message: `worktree created: ${info.branch ?? b}`, result: "created" });
        } catch (err) {
          notify("error", t("newSession.worktreeFailed", { error: errorMessage(err) }));
          setBusy(false);
          return;
        }
      }

      const app = useApp.getState();
      if (preset) app.updateLayout(target, { preset, maximized: null });
      const n = Math.min(8, Math.max(1, count));
      for (let i = 0; i < n; i++) {
        newSession({
          groupId: target,
          agent,
          cwd: baseCwd,
          name: name.trim() ? (n > 1 ? `${name.trim()} ${i + 1}` : name.trim()) : undefined,
          profileId: showAccounts ? profileId : null,
          command: agent === "generic" && !tool ? command.trim() : null,
          preset: agent === "generic" && tool ? tool : null,
          args,
          worktree,
          role,
        });
      }
      useUi.getState().setLastSession({ agent, profileId: showAccounts && profileId ? profileId : last.profileId });
      // Make sure the target group is visible.
      const loc = app.persisted.workspaces.find((w) => w.groups.some((g) => g.id === target));
      if (loc) {
        if (app.persisted.activeWorkspaceId !== loc.id) app.setActiveWorkspace(loc.id);
        app.setActiveGroup(loc.id, target);
        useUi.getState().markVisited(loc.id);
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const title = preset === "columns" ? t("newSession.titleSplitColumns") : preset === "rows" ? t("newSession.titleSplitRows") : t("newSession.title");

  return (
    <Modal
      title={title}
      onClose={onClose}
      width={580}
      footer={
        <>
          <span className="footer-note">{t.rich("newSession.footerHint", { kbd: (c) => <kbd className="kbd">{c}</kbd> })}</span>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? t("newSession.starting") : count > 1 ? t("newSession.startMany", { count }) : t("newSession.startOne")}
          </Button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => {
          // Enter in any text field submits (Ctrl+Enter, ⌘↩ on macOS, from anywhere).
          if (e.key !== "Enter" || e.shiftKey || e.altKey) return;
          const el = e.target as HTMLElement;
          if ((isMac ? e.metaKey : e.ctrlKey) || (el.tagName === "INPUT" && (el as HTMLInputElement).type !== "checkbox")) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <MemoryPressureNotice count={count} />
        <Field label={t("newSession.agent")}>
          <Segmented
            ariaLabel={t("newSession.agent")}
            value={agent}
            onChange={setAgent}
            options={AGENTS.map((k) => ({
              value: k,
              label: AGENT_LABEL[k],
              title: availability[k].text,
              badge: !availability[k].ok ? <span className="dot is-err seg-dot" /> : null,
            }))}
          />
          <div className={`field-msg${avail.ok ? (avail.unknown ? " is-warn" : "") : " is-error"} mono-ish`} title={avail.text}>
            {avail.text}
          </div>
        </Field>

        {agent === "generic" && tools.length > 0 && (
          <Field label={t("newSession.tool")} htmlFor="ns-tool" hint={t("newSession.toolHint")}>
            <Select id="ns-tool" value={tool} onChange={(e) => setTool(e.target.value)}>
              {tools.map((tl) => (
                <option key={tl.preset!} value={tl.preset!}>
                  {tl.label}
                  {tl.version ? ` — ${tl.version}` : ""}
                </option>
              ))}
              <option value="">{t("newSession.customCommand")}</option>
            </Select>
          </Field>
        )}

        {showAccounts && (
          <Field
            label={t("newSession.account")}
            warn={
              agent === "claude" && (sameProfileLive > 0 || count > 1) ? (
                <span className="warn-inline">
                  <IconWarn size={12} />
                  {sameProfileLive > 0 ? t("newSession.claudeShareLive", { count: sameProfileLive }) : t("newSession.claudeShareMany", { count })}
                </span>
              ) : agent === "codex" && (sameProfileLive > 0 || count > 1) ? (
                <span className="warn-inline">
                  <IconWarn size={12} />
                  {sameProfileLive > 0 ? t("newSession.codexShareLive", { count: sameProfileLive }) : t("newSession.codexShareMany", { count })}
                </span>
              ) : undefined
            }
          >
            <div className="input-group">
              <Select value={profileId ?? ""} onChange={(e) => setProfileId(e.target.value || null)} aria-label={t("newSession.accountAria", { agent: accountInfo?.label ?? AGENT_LABEL[agent] })}>
                {accountList.length === 0 && <option value="">{t("newSession.defaultAccount")}</option>}
                {accountList.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {maskEmail(p.status.account) ? ` · ${maskEmail(p.status.account)}` : ""} — {accountStatus(p, hasStatus).text}
                  </option>
                ))}
              </Select>
              {hasStatus && (
                <Button onClick={() => void checkProfile()} disabled={!profile || checking}>
                  {checking ? t("newSession.checking") : t("newSession.check")}
                </Button>
              )}
            </div>
            {profile && (
              <div className="profile-line">
                <span className="dot" style={{ background: profile.color }} />
                <span className={`chip tone-${accountStatus(profile, hasStatus).tone}`}>{accountStatus(profile, hasStatus).text}</span>
                {profile.status.authMethod && profile.status.authMethod !== "none" && <span className="muted">{profile.status.authMethod}</span>}
                {!isSignedIn(profile) && accountInfo?.isolation === "verified" && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      signIn(profile);
                      onClose();
                    }}
                  >
                    {t("newSession.signIn")}
                  </button>
                )}
                <button type="button" className="link-btn push-right" onClick={() => useUi.getState().openDialog({ kind: "profiles" })}>
                  {t("newSession.manageAccounts")}
                </button>
              </div>
            )}
            {!profile && (
              <button type="button" className="link-btn" onClick={() => useUi.getState().openDialog({ kind: "profiles" })}>
                {t("newSession.addAccounts")}
              </button>
            )}
          </Field>
        )}

        {agent === "generic" && !tool && (
          <Field label={t("newSession.command")} htmlFor="ns-cmd" error={commandError} hint={t("newSession.commandHint")}>
            <div className="input-group">
              <Input id="ns-cmd" mono value={command} onChange={(e) => setCommand(e.target.value)} placeholder={executablePlaceholder()} invalid={!!commandError} />
              <Button
                icon={<IconFolder size={13} />}
                onClick={async () => {
                  const p = await pickExecutable(t("newSession.chooseExecutable"));
                  if (p) setCommand(p);
                }}
              >
                {t("common.browse")}
              </Button>
            </div>
          </Field>
        )}

        <Field label={t("newSession.directory")} htmlFor="ns-cwd" error={cwdError} hint={pathState.status === "unknown" ? t("newSession.cwdUnverified") : undefined}>
          <div className="input-group">
            <Input
              id="ns-cwd"
              mono
              value={cwd}
              invalid={!!cwdError}
              onChange={(e) => {
                setCwd(e.target.value);
                setPathState({ status: "idle" });
                setGit(null);
              }}
              onBlur={(e) => void validateCwd(e.currentTarget.value)}
              placeholder={folderPlaceholder()}
            />
            <Button
              icon={<IconFolder size={13} />}
              onClick={async () => {
                const d = await pickFolder(t("newSession.workingDirectory"), cwd || ws?.projectDir);
                if (d) {
                  setCwd(d);
                  void validateCwd(d);
                }
              }}
            >
              {t("common.browse")}
            </Button>
          </div>
        </Field>

        {git?.isRepo && (
          <Field label={t("newSession.gitWorktree")}>
            <Segmented
              size="sm"
              ariaLabel={t("newSession.worktreeAria")}
              value={wtMode}
              onChange={setWtMode}
              options={[
                { value: "none", label: t("newSession.worktreeNone") },
                { value: "existing", label: t("newSession.worktreeExisting"), disabled: git.worktrees.length === 0 },
                { value: "new", label: t("newSession.worktreeNew") },
              ]}
            />
            {wtMode === "none" && (
              <div className="field-msg">
                <IconBranch size={11} />{" "}
                {t.rich(git.dirty ? "newSession.worktreeSharedDirty" : "newSession.worktreeShared", {
                  branch: git.branch ?? t("newSession.detached"),
                  b: (c) => <span className="mono">{c}</span>,
                })}
              </div>
            )}
            {wtMode === "existing" && (
              <Select value={wtExisting} onChange={(e) => setWtExisting(e.target.value)} aria-label={t("newSession.worktreeExisting")} className="mt-6">
                <option value="">{t("newSession.chooseWorktree")}</option>
                {git.worktrees.map((w) => (
                  <option key={w.path} value={w.path}>
                    {w.isMain ? t("newSession.worktreeMain", { branch: w.branch ?? t("newSession.detached") }) : (w.branch ?? t("newSession.detached"))} — {w.path}
                  </option>
                ))}
              </Select>
            )}
            {wtMode === "new" && (
              <div className="wt-new">
                <div className="input-row">
                  <Input mono value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={t("newSession.branchPlaceholder")} aria-label={t("newSession.branchName")} invalid={submitted && !branchOk} />
                  <label className="check">
                    <input type="checkbox" checked={newBranch} onChange={(e) => setNewBranch(e.target.checked)} />
                    {t("newSession.newBranch")}
                  </label>
                </div>
                <Input
                  mono
                  value={wtPath}
                  onChange={(e) => {
                    setWtPath(e.target.value);
                    setWtPathEdited(true);
                  }}
                  placeholder={t("newSession.worktreeFolder")}
                  aria-label={t("newSession.worktreePath")}
                />
                <div className="field-msg">
                  {branch && !branchOk ? <span className="is-error-text">{t("newSession.invalidBranch")}</span> : t("newSession.confirmHint")}
                </div>
              </div>
            )}
          </Field>
        )}

        <Field label={t("newSession.name")} htmlFor="ns-name">
          <Input id="ns-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("newSession.namePlaceholder", { agent: AGENT_LABEL[agent] })} />
        </Field>

        <Field label={t("newSession.role")} htmlFor="ns-role" hint={t("newSession.roleHint")}>
          <RolePicker id="ns-role" value={role} onChange={setRole} />
        </Field>

        <Field label={t("newSession.arguments")} htmlFor="ns-args" hint={args.length ? <span className="mono">{args.map((a) => (/\s/.test(a) || a === "" ? JSON.stringify(a) : a)).join("  ")}</span> : t("newSession.argumentsHint")}>
          <Input id="ns-args" mono value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder={agent === "claude" ? "--model opus" : agent === "codex" ? "--model gpt-5" : ""} />
        </Field>

        <div className="field-pair">
          <Field label={t("newSession.count")}>
            <div className="stepper" role="group" aria-label={t("newSession.countAria")}>
              <button type="button" className="stepper-btn" aria-label={t("newSession.fewer")} disabled={count <= 1} onClick={() => setCount((c) => Math.max(1, c - 1))}>
                −
              </button>
              <span className="stepper-val" aria-live="polite">
                {count}
              </span>
              <button type="button" className="stepper-btn" aria-label={t("newSession.more")} disabled={count >= 8} onClick={() => setCount((c) => Math.min(8, c + 1))}>
                +
              </button>
            </div>
          </Field>
          <Field label={t("newSession.group")}>
            <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label={t("newSession.targetGroup")}>
              {groups.map((g) => {
                const [id, gname] = g.split("\u0000");
                return (
                  <option key={id} value={id}>
                    {gname}
                  </option>
                );
              })}
            </Select>
          </Field>
        </div>
      </form>
    </Modal>
  );
}
