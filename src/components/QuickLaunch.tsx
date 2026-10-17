// One-click session launch: "+ New" dropdown in the workspace header and the agent buttons shown in an
// empty group. Starts immediately in the active group using the workspace's project folder; anything
// more specific (worktree, args, count) goes through the full New Session dialog.

import { runCommand } from "../actions/commands";
import { newSession } from "../actions/sessions";
import type { AgentKind } from "../lib/types";
import { selectActiveGroup, selectActiveWorkspace, useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { useShortcut, withShortcut } from "./hooks";
import { IconPlus } from "./icons";
import { useContextMenu, type MenuItem } from "./ui/Menu";

interface LaunchOption {
  key: string;
  label: string;
  hint?: string;
  color?: string;
  agent: AgentKind;
  profileId?: string;
  preset?: string;
  disabled?: boolean;
}

function useLaunchOptions(): LaunchOption[] {
  // Select the stable store arrays themselves (deriving new objects inside a selector re-renders forever).
  const profiles = useApp((s) => s.profiles);
  const agents = useApp((s) => s.agents);
  const missing = (k: AgentKind) => agents.some((a) => a.kind === k && !a.path);
  const out: LaunchOption[] = [{ key: "ps", label: "PowerShell", agent: "powershell", disabled: missing("powershell") }];
  if (profiles.length === 0) out.push({ key: "claude", label: "Claude Code", agent: "claude", disabled: missing("claude") });
  for (const p of profiles)
    out.push({ key: `claude:${p.id}`, label: `Claude Code`, hint: p.name, color: p.color, agent: "claude", profileId: p.id, disabled: missing("claude") });
  out.push({ key: "codex", label: "Codex", agent: "codex", disabled: missing("codex") });
  // Other agent CLIs found on this PC (broken installs are reported by detection and skipped here).
  for (const a of agents)
    if (a.preset && !a.error) out.push({ key: `tool:${a.preset}`, label: a.label ?? a.preset, agent: "generic", preset: a.preset });
  return out;
}

/** Workspace + group a launch goes to: the given group (any workspace), else the active one. */
function target(groupId?: string) {
  const s = useApp.getState();
  if (groupId)
    for (const w of s.persisted.workspaces) {
      const g = w.groups.find((x) => x.id === groupId);
      if (g) return { ws: w, group: g };
    }
  return { ws: selectActiveWorkspace(s), group: selectActiveGroup(s) };
}

/** Launch now, or fall back to the dialog when the workspace has no project folder yet. */
export function quickLaunch(o: LaunchOption, groupId?: string) {
  const { ws, group } = target(groupId);
  if (!ws || !group) return;
  if (!ws.projectDir) {
    useUi.getState().openDialog({ kind: "newSession", groupId: group.id });
    return;
  }
  newSession({ groupId: group.id, agent: o.agent, cwd: ws.projectDir, profileId: o.profileId ?? null, preset: o.preset ?? null });
}

function openFullDialog(groupId?: string) {
  useUi.getState().openDialog({ kind: "newSession", groupId: target(groupId).group?.id });
}

export interface QuickLaunchButtonProps {
  /** Target group; default = the active group. */
  groupId?: string;
  /** "primary" (header), "ghost" (tab row) or "icon" (pane header). */
  variant?: "primary" | "ghost" | "icon";
  label?: string;
}

export function QuickLaunchButton({ groupId, variant = "primary", label = "New session" }: QuickLaunchButtonProps) {
  const options = useLaunchOptions();
  const menu = useContextMenu();
  const scNew = useShortcut("session.new");
  const items: MenuItem[] = [
    ...options.map(
      (o): MenuItem => ({
        label: o.hint ? `${o.label} · ${o.hint}` : o.label,
        disabled: o.disabled,
        icon: o.color ? <span className="dot" style={{ background: o.color }} /> : undefined,
        onSelect: () => quickLaunch(o, groupId),
      }),
    ),
    "separator",
    { label: "More options…", hint: scNew ?? undefined, onSelect: () => openFullDialog(groupId) },
    { label: "Launch formation…", onSelect: () => runCommand("formation.launch") },
  ];
  const open = (e: { currentTarget: HTMLElement; stopPropagation: () => void }) => {
    e.stopPropagation();
    menu.openAt(e.currentTarget, items);
  };
  return (
    <>
      {variant === "icon" ? (
        <button type="button" className="pane-icon-btn" title="Add a session to this group" aria-label="Add session" onClick={open}>
          <IconPlus size={12} />
        </button>
      ) : (
        <button
          type="button"
          className={variant === "primary" ? "btn btn-sm btn-primary quick-launch" : "btn btn-sm btn-ghost quick-launch quick-launch--ghost"}
          title={withShortcut("New session", scNew)}
          onClick={open}
        >
          <IconPlus size={13} />
          {label}
        </button>
      )}
      {menu.element}
    </>
  );
}

/** Large agent buttons for an empty group. */
export function QuickLaunchPanel() {
  const options = useLaunchOptions();
  const hasFolder = useApp((s) => !!selectActiveWorkspace(s)?.projectDir);
  return (
    <div className="quick-panel">
      <div className="quick-panel-grid">
        {options.map((o) => (
          <button key={o.key} type="button" className="quick-card" disabled={o.disabled} onClick={() => quickLaunch(o)}>
            <span className="quick-card-title">{o.label}</span>
            {o.hint && (
              <span className="quick-card-hint">
                <span className="dot" style={{ background: o.color }} />
                {o.hint}
              </span>
            )}
          </button>
        ))}
      </div>
      <button type="button" className="link-btn quick-panel-more" onClick={() => openFullDialog()}>
        {hasFolder ? "More options (worktree, arguments, several at once)…" : "Choose a folder and options…"}
      </button>
    </div>
  );
}
