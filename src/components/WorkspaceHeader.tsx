// Workspace header row (~34px): name, project path, git branch chip, compact actions.

import { useCallback, useEffect, useState } from "react";
import { runCommand } from "../actions/commands";
import { ipc } from "../lib/ipc";
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

export function WorkspaceHeader() {
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
        <span className="ws-header-name muted">No workspace</span>
      </header>
    );
  }

  const setPreset = (p: LayoutPreset) => groupId && useApp.getState().updateLayout(groupId, { preset: p, maximized: null });
  const chooseFolder = async () => {
    const dir = await pickFolder("Choose project folder", projectDir);
    if (dir) useApp.getState().updateWorkspace(wsId, { projectDir: dir });
  };

  return (
    <header className="ws-header">
      <span className="ws-header-name" title={name}>
        {name}
      </span>
      {projectDir ? (
        <button type="button" className="ws-header-path mono" title={`${projectDir}\nClick to reveal in Explorer`} onClick={() => void revealPath(projectDir)}>
          {projectDir}
        </button>
      ) : (
        <button type="button" className="ws-header-path is-empty" onClick={() => void chooseFolder()}>
          <IconFolder size={13} /> Set project folder…
        </button>
      )}
      {git?.isRepo && (
        <button
          type="button"
          className="chip chip-git"
          disabled={gitBusy}
          title={`${git.root ?? ""}${git.dirty ? "\nUncommitted changes" : ""}${git.worktrees.length > 1 ? `\n${git.worktrees.length} worktrees` : ""}\nClick to refresh`}
          onClick={() => void loadGit(projectDir)}
        >
          <IconBranch size={12} />
          <span className="mono">{git.branch ?? "detached"}</span>
          {git.dirty && <span className="dot is-warn" aria-label="uncommitted changes" />}
        </button>
      )}

      <div className="ws-header-actions">
        <QuickLaunchButton />
        <span className="divider-v" />
        <div className="preset-switch" role="group" aria-label="Layout preset">
          <IconButton label="Grid layout" active={preset === "grid"} onClick={() => setPreset("grid")}>
            <IconGrid size={14} />
          </IconButton>
          <IconButton label="Columns layout" active={preset === "columns"} onClick={() => setPreset("columns")}>
            <IconColumns size={14} />
          </IconButton>
          <IconButton label="Rows layout" active={preset === "rows"} onClick={() => setPreset("rows")}>
            <IconRows size={14} />
          </IconButton>
        </div>
        <span className="divider-v" />
        <IconButton label={withShortcut("Mission Control", scMission)} onClick={() => runCommand("view.mission")}>
          <IconMission size={15} />
        </IconButton>
        <ThemeSwitcherButton />
        <IconButton label={withShortcut(inspectorOpen ? "Hide inspector" : "Show inspector", scInspector)} active={inspectorOpen} onClick={() => runCommand("view.toggleInspector")}>
          <IconInspector size={15} />
        </IconButton>
        <IconButton label={withShortcut(focusMode ? "Exit focus mode (Esc)" : "Focus mode", scFocus)} active={focusMode} onClick={() => runCommand("view.focusMode")}>
          <IconFocus size={15} />
        </IconButton>
      </div>
    </header>
  );
}
