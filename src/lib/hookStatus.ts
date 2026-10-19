// Exact Claude status from Claude Code hooks (opt-in; Rust: src-tauri/src/meter/hooks.rs). Pure text helpers
// for the attention store, pane header chip and Mission Control cards.

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
  if (tool === "AskUserQuestion") return "Asks you a question";
  if (tool === "ExitPlanMode") return "Waiting for plan approval";
  return "Needs your input";
}

/** Feed / card message for a hook state. */
export function hookMessage(h: HookInfo, durationText?: string): string {
  switch (h.state) {
    case "permission":
      return h.tool ? `Needs permission · ${toolLabel(h.tool)}` : "Needs permission";
    case "input":
      return inputText(h.tool);
    case "tool":
      return h.tool ? `Running ${toolLabel(h.tool)}` : "Running a tool";
    case "working":
      return "Working";
    case "stopped":
      if (h.reason === "interrupt") return "Interrupted";
      if (h.reason) return `Stopped: ${humanize(h.reason)}`;
      return durationText ? `Finished after ${durationText}` : "Finished";
    case "idle-prompt":
      return "Waiting for your next prompt";
    case "ready":
      return "Ready";
    case "ended":
      return "Session ended";
  }
}

/** Pane header chip text, or null when the lamp says enough. */
export function hookChipLabel(h: HookInfo | undefined | null): string | null {
  if (!h) return null;
  switch (h.state) {
    case "permission":
      return h.tool ? `needs permission · ${toolLabel(h.tool)}` : "needs permission";
    case "input":
      return h.tool === "AskUserQuestion" ? "question for you" : h.tool === "ExitPlanMode" ? "plan approval" : "needs input";
    case "tool":
      return h.tool ? `running · ${toolLabel(h.tool)}` : null;
    case "stopped":
      return h.reason && h.reason !== "interrupt" ? `stopped · ${humanize(h.reason)}` : null;
    default:
      return null;
  }
}
