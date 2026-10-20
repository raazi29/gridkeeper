import { describe, expect, it } from "vitest";
import { hookChipLabel, hookMessage, hookWaiting, isHookState, toolLabel } from "./hookStatus";

describe("hook status text", () => {
  it("labels prompts, tools and stops", () => {
    expect(hookChipLabel({ state: "permission", tool: "Bash", at: 0 })).toBe("needs permission · Bash");
    expect(hookChipLabel({ state: "permission", at: 0 })).toBe("needs permission");
    expect(hookChipLabel({ state: "input", tool: "AskUserQuestion", at: 0 })).toBe("question for you");
    expect(hookChipLabel({ state: "input", tool: "ExitPlanMode", at: 0 })).toBe("plan approval");
    expect(hookChipLabel({ state: "tool", tool: "mcp__github__create_issue", at: 0 })).toBe("running · github create_issue");
    expect(hookChipLabel({ state: "stopped", reason: "rate_limit", at: 0 })).toBe("stopped · rate limit");
    expect(hookChipLabel({ state: "stopped", reason: "interrupt", at: 0 })).toBeNull();
    expect(hookChipLabel({ state: "working", at: 0 })).toBeNull();
    expect(hookChipLabel(undefined)).toBeNull();
    expect(hookMessage({ state: "stopped", at: 0 }, "2m 5s")).toBe("Finished after 2m 5s");
    expect(hookMessage({ state: "input", at: 0 })).toBe("Needs your input");
  });

  it("waiting states and validation", () => {
    expect(hookWaiting({ state: "permission", at: 0 })).toBe(true);
    expect(hookWaiting({ state: "input", at: 0 })).toBe(true);
    expect(hookWaiting({ state: "tool", at: 0 })).toBe(false);
    expect(hookWaiting(null)).toBe(false);
    expect(isHookState("idle-prompt")).toBe(true);
    expect(isHookState("blocked")).toBe(false);
    expect(isHookState(undefined)).toBe(false);
    expect(toolLabel("Bash")).toBe("Bash");
  });
});
