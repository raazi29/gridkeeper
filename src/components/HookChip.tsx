// Pane header chip with the exact Claude state from Claude Code hooks: "needs permission · Bash", "running · Edit",
// "question for you", "stopped · rate limit". Shows nothing without hooks (the lamp covers the heuristic states).
// Subscribes to one session's hook entry; nothing is polled.

import { memo } from "react";
import { hookChipLabel, hookWaiting } from "../lib/hookStatus";
import type { SessionId } from "../lib/types";
import { useAttention } from "../store/attention";
import "../styles/meter.css";

const HOOK_TITLE = "Exact status reported by Claude Code's hooks (Settings › Agents › Exact status for Claude panes).";

export const HookChip = memo(function HookChip({ sessionId }: { sessionId: SessionId }) {
  const hook = useAttention((s) => s.sessions[sessionId]?.hook);
  const label = hookChipLabel(hook);
  if (!hook || !label) return null;
  const tone = hookWaiting(hook) ? " is-needs" : hook.state === "stopped" ? " is-error" : "";
  const extra = hookWaiting(hook) ? "\nAutopilot and hand-offs never type into this prompt; answer it in the pane." : "";
  return (
    <span className={`pane-chip hook-chip${tone}`} title={`${HOOK_TITLE}${extra}`} aria-label={`Claude status: ${label}`} data-hook={hook.state}>
      {label}
    </span>
  );
});
