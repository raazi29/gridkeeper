// Workspace header row (~34px): name, project path, git branch chip, compact actions.

import { useCallback, useEffect, useState } from "react";
import { runCommand } from "../actions/commands";
import { ipc } from "../lib/ipc";
import { fileManagerName } from "../lib/platform";
import type { GitInfo, LayoutPreset } from "../lib/types";
import { selectActiveGroup, selectActiveWorkspace, useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { useShortcut, withShortcut } from "./hooks";
import { IconBranch, IconColumns, IconFocus, IconFolder, IconGrid, IconInspector, IconRows } from "./icons";
import { IconMission } from "./mission/IconMission";
import { QuickLaunchButton } from "./QuickLaunch";
import { ThemeSwitcherButton } from "./ThemeSwitcher";
import { IconButton } from "./ui/Button";
import { pickFolder, revealPath } from "./util/pick";
import { useT } from "../i18n";

export function WorkspaceHeader() {
  const t = useT();
  const wsId = useApp((s) => selectActiveWorkspace(s)?.id);
  const name = useApp((s) => selectActiveWorkspace(s)?.name ?? "");
  const projectDir = useApp((s) => selectActiveWorkspace(s)?.projectDir ?? null);
  const groupId = useApp((s) => selectActiveGroup(s)?.id);
  const preset = useApp((s) => selectActiveGroup(s)?.layout.preset ?? "grid");
  const inspectorOpen = useApp((s) => s.persisted.settings.inspectorOpen);
  const scInspector = useShortcut("view.toggleInspector");
  const scFocus = useShortcut("view.focusMode");
  const focusMode = useUi((s) => s.focusMode);
  const scMission = useShortcut("view.mission");

  const [git, setGit] = useState<GitInfo | null>(null);
  const [gitBusy, setGitBusy] = useState(false);

  const loadGit = useCallback(
    async (dir: string | null, signal?: { cancelled: boolean }) => {
      if (!dir) {
        setGit(null);
        return;
      }
      setGitBusy(true);
      try {
        const info = await ipc.gitInfo(dir);
        if (!signal?.cancelled) setGit(info);
      } catch {
        if (!signal?.cancelled) setGit(null);
      } finally {
        if (!signal?.cancelled) setGitBusy(false);
      }
    },
    [],
  );

  // Refresh on workspace switch / folder change only — no polling.
  useEffect(() => {
    const signal = { cancelled: false };
    setGit(null);
    void loadGit(projectDir, signal);
    return () => {
      signal.cancelled = true;
    };
  }, [wsId, projectDir, loadGit]);

  if (!wsId) {
    return (
      <header className="ws-header">
        <span className="ws-header-name muted">{t("shell.header.noWorkspace")}</span>
      </header>
    );
  }

  const setPreset = (p: LayoutPreset) => groupId && useApp.getState().updateLayout(groupId, { preset: p, maximized: null });
  const chooseFolder = async () => {
    const dir = await pickFolder(t("shell.chooseProjectFolder"), projectDir);
    if (dir) useApp.getState().updateWorkspace(wsId, { projectDir: dir });
  };

  return (
    <header className="ws-header">
      <span className="ws-header-name" title={name}>
        {name}
      </span>
      {projectDir ? (
        <button type="button" className="ws-header-path mono" title={t("shell.header.revealPath", { path: projectDir, app: fileManagerName() })} onClick={() => void revealPath(projectDir)}>
          {projectDir}
        </button>
      ) : (
        <button type="button" className="ws-header-path is-empty" onClick={() => void chooseFolder()}>
          <IconFolder size={13} /> {t("shell.header.setFolder")}
        </button>
      )}
      {git?.isRepo && (
        <button
          type="button"
          className="chip chip-git"
          disabled={gitBusy}
          title={`${git.root ?? ""}${git.dirty ? `\n${t("shell.header.gitUncommitted")}` : ""}${git.worktrees.length > 1 ? `\n${t("shell.header.gitWorktrees", { count: git.worktrees.length })}` : ""}\n${t("shell.header.gitRefresh")}`}
          onClick={() => void loadGit(projectDir)}
        >
          <IconBranch size={12} />
          <span className="mono">{git.branch ?? t("shell.header.gitDetached")}</span>
          {git.dirty && <span className="dot is-warn" aria-label={t("shell.header.gitDirtyAria")} />}
        </button>
      )}

      <div className="ws-header-actions">
        <QuickLaunchButton />
        <span className="divider-v" />
        <div className="preset-switch" role="group" aria-label={t("shell.header.layoutPreset")}>
          <IconButton label={t("shell.header.layoutGrid")} active={preset === "grid"} onClick={() => setPreset("grid")}>
            <IconGrid size={14} />
          </IconButton>
          <IconButton label={t("shell.header.layoutColumns")} active={preset === "columns"} onClick={() => setPreset("columns")}>
            <IconColumns size={14} />
          </IconButton>
          <IconButton label={t("shell.header.layoutRows")} active={preset === "rows"} onClick={() => setPreset("rows")}>
            <IconRows size={14} />
          </IconButton>
        </div>
        <span className="divider-v" />
        <IconButton label={withShortcut(t("shell.header.missionControl"), scMission)} onClick={() => runCommand("view.mission")}>
          <IconMission size={15} />
        </IconButton>
        <ThemeSwitcherButton />
        <IconButton label={withShortcut(inspectorOpen ? t("shell.header.hideInspector") : t("shell.header.showInspector"), scInspector)} active={inspectorOpen} onClick={() => runCommand("view.toggleInspector")}>
          <IconInspector size={15} />
        </IconButton>
        <IconButton label={withShortcut(focusMode ? t("shell.header.focusModeExit") : t("shell.header.focusMode"), scFocus)} active={focusMode} onClick={() => runCommand("view.focusMode")}>
          <IconFocus size={15} />
        </IconButton>
      </div>
    </header>
  );
}
