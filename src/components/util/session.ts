// Session display helpers shared by status bar, inspector, palette and dialogs.

import type { AgentKind, ClaudeProfile, SessionState } from "../../lib/types";
import { shellLabel } from "../../lib/platform";
import { t } from "../../i18n";

/** Agent names: product names stay as they are; "Custom" follows the UI language (a getter, read at render time). */
export const AGENT_LABEL: Readonly<Record<AgentKind, string>> = {
  powershell: shellLabel(), // the platform default terminal: PowerShell on Windows, the login shell elsewhere
  claude: "Claude Code",
  codex: "Codex",
  get generic() {
    return t("session.agentCustom");
  },
};

export type Tone = "ok" | "warn" | "err" | "muted" | "accent";

export function stateLabel(st: SessionState | undefined): { label: string; tone: Tone } {
  if (!st) return { label: t("session.state.notStarted"), tone: "muted" };
  switch (st.state) {
    case "starting":
      return { label: t("session.state.starting"), tone: "accent" };
    case "running":
      return { label: t("session.state.running"), tone: "ok" };
    case "stopping":
      return { label: t("session.state.stopping"), tone: "warn" };
    case "exited":
      return { label: st.code === null ? t("session.state.exited") : t("session.state.exitedCode", { code: st.code }), tone: st.code === 0 || st.code === null ? "muted" : "err" };
    case "failed":
      return { label: t("session.state.failed"), tone: "err" };
  }
}


export function profileStatusText(p: ClaudeProfile): { text: string; tone: "ok" | "warn" | "err" | "muted" } {
  const st = p.status;
  if (!st.dirExists && p.configDir) return { text: t("session.profile.folderMissing"), tone: "err" };
  if (st.verified && st.loggedIn) return { text: t("session.profile.signedInVerified"), tone: "ok" };
  if (st.verified && st.loggedIn === false) return { text: t("session.profile.notSignedIn"), tone: "err" };
  if (st.likelyAuthenticated) return { text: t("session.profile.likelySignedIn"), tone: "warn" };
  return { text: t("session.profile.notSignedIn"), tone: "err" };
}
