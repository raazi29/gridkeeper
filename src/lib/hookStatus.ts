// Exact Claude status from Claude Code hooks (opt-in; Rust: src-tauri/src/meter/hooks.rs). Pure text helpers
// for the attention store, pane header chip and Mission Control cards.

import { t } from "../i18n";
import type { HookState } from "./types";

export interface HookInfo {
  state: HookState;
  /** Tool name (never its input). */
  tool?: string;
  /** Short token: stop failure type, "interrupt", session start / end reason. */
  reason?: string;
  /** ms epoch of the hook event. */
  at: number;
}

export const HOOK_STATES: readonly HookState[] = ["ready", "working", "tool", "permission", "input", "idle-prompt", "stopped", "ended"];

export function isHookState(s: string | undefined): s is HookState {
  return !!s && (HOOK_STATES as readonly string[]).includes(s);
}

/** Claude waits on a prompt: never type into the pane (Autopilot, hand-off, brief). */
export function hookWaiting(h: HookInfo | undefined | null): boolean {
  return h?.state === "permission" || h?.state === "input";
}

/** Readable tool name: `mcp__github__create_issue` -> `github create_issue`. */
export function toolLabel(tool: string): string {
  const m = /^mcp__([^_].*?)__(.+)$/.exec(tool);
  return m ? `${m[1]} ${m[2]}` : tool;
}

const humanize = (token: string) => token.replace(/[_-]+/g, " ").trim();

/** What a waiting prompt is about (input state). */
function inputText(tool: string | undefined): string {
  if (tool === "AskUserQuestion") return t("hooks.msg.question");
  if (tool === "ExitPlanMode") return t("hooks.msg.planApproval");
  return t("hooks.msg.input");
}

/** Feed / card message for a hook state. */
export function hookMessage(h: HookInfo, durationText?: string): string {
  switch (h.state) {
    case "permission":
      return h.tool ? t("hooks.msg.permissionTool", { tool: toolLabel(h.tool) }) : t("hooks.msg.permission");
    case "input":
      return inputText(h.tool);
    case "tool":
      return h.tool ? t("hooks.msg.runningTool", { tool: toolLabel(h.tool) }) : t("hooks.msg.running");
    case "working":
      return t("hooks.msg.working");
    case "stopped":
      if (h.reason === "interrupt") return t("hooks.msg.interrupted");
      if (h.reason) return t("hooks.msg.stopped", { reason: humanize(h.reason) });
      return durationText ? t("hooks.msg.finishedAfter", { duration: durationText }) : t("hooks.msg.finished");
    case "idle-prompt":
      return t("hooks.msg.idlePrompt");
    case "ready":
      return t("hooks.msg.ready");
    case "ended":
      return t("hooks.msg.ended");
  }
}

/** Pane header chip text, or null when the lamp says enough. */
export function hookChipLabel(h: HookInfo | undefined | null): string | null {
  if (!h) return null;
  switch (h.state) {
    case "permission":
      return h.tool ? t("hooks.chip.permissionTool", { tool: toolLabel(h.tool) }) : t("hooks.chip.permission");
    case "input":
      return t(h.tool === "AskUserQuestion" ? "hooks.chip.question" : h.tool === "ExitPlanMode" ? "hooks.chip.planApproval" : "hooks.chip.input");
    case "tool":
      return h.tool ? t("hooks.chip.runningTool", { tool: toolLabel(h.tool) }) : null;
    case "stopped":
      return h.reason && h.reason !== "interrupt" ? t("hooks.chip.stopped", { reason: humanize(h.reason) }) : null;
    default:
      return null;
  }
}
