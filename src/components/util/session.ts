// Session display helpers shared by status bar, inspector, palette and dialogs.

import type { AgentKind, ClaudeProfile, SessionState } from "../../lib/types";
import { shellLabel } from "../../lib/platform";

export const AGENT_LABEL: Record<AgentKind, string> = {
  powershell: shellLabel(), // the platform default terminal: PowerShell on Windows, the login shell elsewhere
  claude: "Claude Code",
  codex: "Codex",
  generic: "Custom",
};

export type Tone = "ok" | "warn" | "err" | "muted" | "accent";

export function stateLabel(st: SessionState | undefined): { label: string; tone: Tone } {
  if (!st) return { label: "Not started", tone: "muted" };
  switch (st.state) {
    case "starting":
      return { label: "Starting", tone: "accent" };
    case "running":
      return { label: "Running", tone: "ok" };
    case "stopping":
      return { label: "Stopping", tone: "warn" };
    case "exited":
      return { label: st.code === null ? "Exited" : `Exited (${st.code})`, tone: st.code === 0 || st.code === null ? "muted" : "err" };
    case "failed":
      return { label: "Failed", tone: "err" };
  }
}


export function profileStatusText(p: ClaudeProfile): { text: string; tone: "ok" | "warn" | "err" | "muted" } {
  const st = p.status;
  if (!st.dirExists && p.configDir) return { text: "Folder missing", tone: "err" };
  if (st.verified && st.loggedIn) return { text: "Signed in (verified)", tone: "ok" };
  if (st.verified && st.loggedIn === false) return { text: "Not signed in", tone: "err" };
  if (st.likelyAuthenticated) return { text: "Likely signed in", tone: "warn" };
  return { text: "Not signed in", tone: "err" };
}
