// New session dialog (also used by split commands). Launches 1–8 identical sessions.

import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { notify } from "../actions/notify";
import { newSession } from "../actions/sessions";
import { errorMessage, ipc } from "../lib/ipc";
import type { AgentKind, GitInfo, LayoutPreset, WorktreeRef } from "../lib/types";
import { isLive, selectActiveWorkspace, useApp } from "../store/appStore";
import { confirmDialog, useUi } from "../store/uiStore";
import { IconBranch, IconFolder, IconWarn } from "./icons";
import { Button } from "./ui/Button";
import { Field, Input, Segmented, Select } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { pickExecutable, pickFolder } from "./util/pick";
import { AGENT_LABEL, profileStatusText } from "./util/session";
import { defaultWorktreePath, isValidBranchName, splitArgs } from "./util/text";

type WtMode = "none" | "existing" | "new";
type PathState = { status: "idle" | "checking" | "ok" | "missing" | "unknown"; normalized?: string };

const AGENTS: AgentKind[] = ["powershell", "claude", "codex", "generic"];

export function NewSessionDialog({ groupId, preset, onClose }: { groupId?: string; preset?: LayoutPreset; onClose: () => void }) {
  const last = useUi((s) => s.lastSession);
  const agents = useApp((s) => s.agents);
  const agentPaths = useApp((s) => s.persisted.settings.agentPaths);
  const profiles = useApp((s) => s.profiles);
  const ws = useApp((s) => (groupId ? s.persisted.workspaces.find((w) => w.groups.some((g) => g.id === groupId)) : undefined) ?? selectActiveWorkspace(s));
  const groups = useApp(useShallow((s) => {
    const w = (groupId ? s.persisted.workspaces.find((x) => x.groups.some((g) => g.id === groupId)) : undefined) ?? selectActiveWorkspace(s);
    return w?.groups.map((g) => `${g.id}\u0000${g.name}`) ?? [];
  }));

  const [agent, setAgent] = useState<AgentKind>(last.agent);
  const [profileId, setProfileId] = useState<string | null>(() =>
    last.profileId && profiles.some((p) => p.id === last.profileId) ? last.profileId : (profiles[0]?.id ?? null),
  );
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
        map[k] = { ok: true, unknown: false, text: "Run any executable" };
        continue;
      }
      const configured = agentPaths[k as keyof typeof agentPaths];
      const a = agents.find((x) => x.kind === k);
      if (a?.path) map[k] = { ok: true, unknown: false, text: `${a.path}${a.version ? ` — ${a.version}` : ""}` };
      else if (configured) map[k] = { ok: true, unknown: false, text: `${configured} (from Settings)` };
      else if (!a) map[k] = { ok: true, unknown: true, text: "Not detected yet — run Detect in Settings if start fails" };
      else map[k] = { ok: false, unknown: false, text: `Not found — set a path in Settings${a.error ? ` (${a.error})` : ""}` };
    }
    return map;
  }, [agents, agentPaths]);

  const profile = profiles.find((p) => p.id === profileId) ?? null;
  const sameProfileLive = useApp((s) => {
    if (agent !== "claude") return 0;
    let n = 0;
    for (const id in s.runtime) {
      const r = s.runtime[id];
      if (r.agent === "claude" && isLive(r) && (r.profileId ?? null) === (profileId ?? null)) n++;
    }
    return n;
  });

  const args = useMemo(() => splitArgs(argsText), [argsText]);
  const avail = availability[agent];
  const branchOk = wtMode !== "new" || isValidBranchName(branch);
  const cwdError =
    pathState.status === "missing" ? "Folder does not exist" : submitted && !cwd.trim() ? "Choose a working directory" : null;
  const commandError = agent === "generic" && !tool && submitted && !command.trim() ? "Enter the executable to run" : null;
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
      const status = await ipc.profileCheck(profile.id);
      const s = useApp.getState();
      s.setProfiles(s.profiles.map((p) => (p.id === profile.id ? { ...p, status } : p)));
    } catch (e) {
      notify("error", `Profile check failed: ${errorMessage(e)}`);
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
        const cmd = newBranch ? `git worktree add -b ${b} "${p}"` : `git worktree add "${p}" ${b}`;
        const ok = await confirmDialog({
          title: "Create a Git worktree?",
          message: newBranch
            ? `Creates a new folder at the path below and checks out a NEW branch “${b}” there, starting from the current HEAD of ${git.branch ?? "the repository"}. Your current working tree, staged changes and branch are left untouched.`
            : `Creates a new folder at the path below and checks out the EXISTING branch “${b}” there. Git refuses if that branch is already checked out in another worktree. Your current working tree is left untouched.`,
          detail: `cd "${git.root}"\n${cmd}`,
          confirmLabel: "Create worktree",
        });
        if (!ok) {
          setBusy(false);
          return;
        }
        try {
          const info = await ipc.gitWorktreeAdd(git.root, p, b, newBranch);
          worktree = { path: info.path, branch: info.branch ?? b };
          notify("info", `Worktree created at ${info.path}`);
        } catch (err) {
          notify("error", `git worktree add failed: ${errorMessage(err)}`);
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
          profileId: agent === "claude" ? profileId : null,
          command: agent === "generic" && !tool ? command.trim() : null,
          preset: agent === "generic" && tool ? tool : null,
          args,
          worktree,
        });
      }
      useUi.getState().setLastSession({ agent, profileId: agent === "claude" ? profileId : last.profileId });
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

  const title = preset ? `New session — split ${preset === "columns" ? "into columns" : preset === "rows" ? "into rows" : ""}` : "New session";

  return (
    <Modal
      title={title}
      onClose={onClose}
      width={580}
      footer={
        <>
          <span className="footer-note">
            <kbd className="kbd">Enter</kbd> start · <kbd className="kbd">Esc</kbd> cancel
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? "Starting…" : count > 1 ? `Start ${count} sessions` : "Start session"}
          </Button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => void submit(e)}
        onKeyDown={(e) => {
          // Enter in any text field submits (Ctrl+Enter from anywhere).
          if (e.key !== "Enter" || e.shiftKey || e.altKey) return;
          const t = e.target as HTMLElement;
          if (e.ctrlKey || (t.tagName === "INPUT" && (t as HTMLInputElement).type !== "checkbox")) {
            e.preventDefault();
            void submit();
          }
        }}
      >
        <Field label="Agent">
          <Segmented
            ariaLabel="Agent"
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

        {agent === "claude" && (
          <Field
            label="Account"
            warn={
              sameProfileLive > 0 || count > 1 ? (
                <span className="warn-inline">
                  <IconWarn size={12} />
                  {sameProfileLive > 0
                    ? `${sameProfileLive} live session${sameProfileLive === 1 ? " already uses" : "s already use"} this profile.`
                    : `${count} sessions will share this profile.`}{" "}
                  Concurrent token refreshes in one profile can force a re-login (Claude Code #91708). Separate profiles avoid it.
                </span>
              ) : undefined
            }
          >
            <div className="input-group">
              <Select value={profileId ?? ""} onChange={(e) => setProfileId(e.target.value || null)} aria-label="Claude account profile">
                {profiles.length === 0 && <option value="">Default (~/.claude)</option>}
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {profileStatusText(p).text}
                  </option>
                ))}
              </Select>
              <Button onClick={() => void checkProfile()} disabled={!profile || checking}>
                {checking ? "Checking…" : "Check"}
              </Button>
            </div>
            {profile && (
              <div className="profile-line">
                <span className="dot" style={{ background: profile.color }} />
                <span className={`chip tone-${profileStatusText(profile).tone}`}>{profileStatusText(profile).text}</span>
                {profile.status.authMethod && <span className="muted">{profile.status.authMethod}</span>}
                {profile.status.account && <span className="muted">{profile.status.account}</span>}
                {!(profile.status.loggedIn || profile.status.likelyAuthenticated) && <span className="muted">Start a session with this profile and run /login</span>}
                <button type="button" className="link-btn push-right" onClick={() => useUi.getState().openDialog({ kind: "profiles" })}>
                  Manage profiles…
                </button>
              </div>
            )}
            {!profile && (
              <button type="button" className="link-btn" onClick={() => useUi.getState().openDialog({ kind: "profiles" })}>
                Add account profiles…
              </button>
            )}
          </Field>
        )}

        {agent === "generic" && tools.length > 0 && (
          <Field label="Tool" htmlFor="ns-tool" hint="Agent CLIs detected on this PC, or any command">
            <Select id="ns-tool" value={tool} onChange={(e) => setTool(e.target.value)}>
              {tools.map((t) => (
                <option key={t.preset!} value={t.preset!}>
                  {t.label}
                  {t.version ? ` — ${t.version}` : ""}
                </option>
              ))}
              <option value="">Custom command…</option>
            </Select>
          </Field>
        )}

        {agent === "generic" && !tool && (
          <Field label="Command" htmlFor="ns-cmd" error={commandError} hint="Executable path or a command on PATH">
            <div className="input-group">
              <Input id="ns-cmd" mono value={command} onChange={(e) => setCommand(e.target.value)} placeholder={"C:\\tools\\bin\\tool.exe"} invalid={!!commandError} />
              <Button
                icon={<IconFolder size={13} />}
                onClick={async () => {
                  const p = await pickExecutable("Choose executable");
                  if (p) setCommand(p);
                }}
              >
                Browse…
              </Button>
            </div>
          </Field>
        )}

        <Field label="Directory" htmlFor="ns-cwd" error={cwdError} hint={pathState.status === "unknown" ? "Could not verify the folder" : undefined}>
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
              placeholder={"D:\\code\\project"}
            />
            <Button
              icon={<IconFolder size={13} />}
              onClick={async () => {
                const d = await pickFolder("Working directory", cwd || ws?.projectDir);
                if (d) {
                  setCwd(d);
                  void validateCwd(d);
                }
              }}
            >
              Browse…
            </Button>
          </div>
        </Field>

        {git?.isRepo && (
          <Field label="Git worktree">
            <Segmented
              size="sm"
              ariaLabel="Worktree"
              value={wtMode}
              onChange={setWtMode}
              options={[
                { value: "none", label: "Use folder as is" },
                { value: "existing", label: "Existing worktree", disabled: git.worktrees.length === 0 },
                { value: "new", label: "Create new worktree" },
              ]}
            />
            {wtMode === "none" && (
              <div className="field-msg">
                <IconBranch size={11} /> <span className="mono">{git.branch ?? "detached"}</span>
                {git.dirty ? " · uncommitted changes" : ""} — sessions share this working tree.
              </div>
            )}
            {wtMode === "existing" && (
              <Select value={wtExisting} onChange={(e) => setWtExisting(e.target.value)} aria-label="Existing worktree" className="mt-6">
                <option value="">Choose a worktree…</option>
                {git.worktrees.map((w) => (
                  <option key={w.path} value={w.path}>
                    {(w.branch ?? "detached") + (w.isMain ? " (main)" : "")} — {w.path}
                  </option>
                ))}
              </Select>
            )}
            {wtMode === "new" && (
              <div className="wt-new">
                <div className="input-row">
                  <Input mono value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="branch name, e.g. feature/login" aria-label="Branch name" invalid={submitted && !branchOk} />
                  <label className="check">
                    <input type="checkbox" checked={newBranch} onChange={(e) => setNewBranch(e.target.checked)} />
                    New branch
                  </label>
                </div>
                <Input
                  mono
                  value={wtPath}
                  onChange={(e) => {
                    setWtPath(e.target.value);
                    setWtPathEdited(true);
                  }}
                  placeholder="worktree folder"
                  aria-label="Worktree path"
                />
                <div className="field-msg">
                  {branch && !branchOk ? <span className="is-error-text">Invalid branch name</span> : "You will confirm the exact git command before anything is created."}
                </div>
              </div>
            )}
          </Field>
        )}

        <Field label="Name" htmlFor="ns-name">
          <Input id="ns-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`${AGENT_LABEL[agent]} (auto)`} />
        </Field>

        <Field label="Arguments" htmlFor="ns-args" hint={args.length ? <span className="mono">{args.map((a) => (/\s/.test(a) || a === "" ? JSON.stringify(a) : a)).join("  ")}</span> : "Optional, quotes respected"}>
          <Input id="ns-args" mono value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder={agent === "claude" ? "--model opus" : agent === "codex" ? "--model gpt-5" : ""} />
        </Field>

        <div className="field-pair">
          <Field label="Count">
            <div className="stepper" role="group" aria-label="Number of sessions">
              <button type="button" className="stepper-btn" aria-label="Fewer" disabled={count <= 1} onClick={() => setCount((c) => Math.max(1, c - 1))}>
                −
              </button>
              <span className="stepper-val" aria-live="polite">
                {count}
              </span>
              <button type="button" className="stepper-btn" aria-label="More" disabled={count >= 8} onClick={() => setCount((c) => Math.min(8, c + 1))}>
                +
              </button>
            </div>
          </Field>
          <Field label="Group">
            <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Target group">
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
