// Pane header chip with the exact Claude state from Claude Code hooks: "needs permission · Bash", "running · Edit",
// "question for you", "stopped · rate limit". Shows nothing without hooks (the lamp covers the heuristic states).
// Subscribes to one session's hook entry; nothing is polled.

import { memo } from "react";
import { useT } from "../i18n";
import { hookChipLabel, hookWaiting } from "../lib/hookStatus";
import type { SessionId } from "../lib/types";
import { useAttention } from "../store/attention";
import "../styles/meter.css";

export const HookChip = memo(function HookChip({ sessionId }: { sessionId: SessionId }) {
  const t = useT();
  const hook = useAttention((s) => s.sessions[sessionId]?.hook);
  const label = hookChipLabel(hook);
  if (!hook || !label) return null;
  const tone = hookWaiting(hook) ? " is-needs" : hook.state === "stopped" ? " is-error" : "";
  const title = hookWaiting(hook) ? `${t("hooks.chip.title")}\n${t("hooks.chip.waitingNote")}` : t("hooks.chip.title");
  return (
    <span className={`pane-chip hook-chip${tone}`} title={title} aria-label={t("hooks.chip.aria", { label })} data-hook={hook.state}>
      {label}
    </span>
  );
});
