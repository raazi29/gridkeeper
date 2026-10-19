// Settings › Agents: "Exact status for Claude panes (hooks)" and the per-workspace spend guard.

import { useShallow } from "zustand/react/shallow";
import { DEFAULT_GUARD, normalizeGuard, SPEND_ACTIONS, SPEND_NOTE } from "../../lib/spend";
import type { SpendAction, SpendGuard } from "../../lib/types";
import { useApp } from "../../store/appStore";
import { setGuard } from "../../store/spend";
import { NumberInput, Select, Toggle } from "../ui/Field";
import "./spend.css";

const ACTION_LABEL: Record<SpendAction, string> = {
  warn: "Warn only",
  pause: "Pause Autopilot",
  pauseNotify: "Pause Autopilot + notify",
};

export function ClaudeHooksSetting() {
  const meter = useApp((s) => s.persisted.settings.costMeter ?? false);
  const on = useApp((s) => s.persisted.settings.claudeHooks ?? true);
  return (
    <div className="cost-meter-setting">
      <div className="micro-label">Exact status</div>
      <Toggle
        checked={on}
        disabled={!meter}
        onChange={(v) => useApp.getState().updateSettings({ claudeHooks: v })}
        label="Exact status for Claude panes (hooks)"
        hint={
          <>
            {meter ? "" : "Needs the cost meter (same settings file). "}
            Adds Claude Code hooks to the meter's <code>--settings</code> file, so panes show exactly when Claude needs
            permission (with the tool name), asks a question, runs a tool or has finished, instead of guessing from terminal
            output. Autopilot and hand-offs never type into a permission or question prompt. Claude Code adds these hooks to your
            own (yours keep running unchanged; nothing in your Claude settings is read for this or changed). Gridkeeper keeps only
            the event, tool name, notification type and session id; never prompts, tool input or output, or transcript paths.
            Applies to newly started Claude panes.
          </>
        }
      />
    </div>
  );
}

export function SpendGuardSettings() {
  const meter = useApp((s) => s.persisted.settings.costMeter ?? false);
  const workspaces = useApp(useShallow((s) => s.persisted.workspaces.map((w) => `${w.id}\u0000${w.name}`)));
  const guards = useApp((s) => s.persisted.settings.spendGuards);
  return (
    <div className="cost-meter-setting spend-settings">
      <div className="micro-label">Spend guard</div>
      <div className="hint">
        A daily budget per workspace, counted from local midnight over the cost meter's numbers. {SPEND_NOTE} At the warning share a
        toast appears; at 100% the chosen action runs and a banner offers to raise the budget or resume. Agents are never stopped.
        {meter ? "" : " Needs the cost meter."}
      </div>
      {workspaces.length === 0 && <div className="hint">No workspaces yet.</div>}
      {workspaces.map((row) => {
        const [id, name] = row.split("\u0000");
        return <GuardRow key={id} id={id} name={name} guard={normalizeGuard(guards?.[id])} />;
      })}
    </div>
  );
}

function GuardRow({ id, name, guard }: { id: string; name: string; guard: SpendGuard | null }) {
  const g = guard ?? DEFAULT_GUARD;
  const patch = (p: Partial<SpendGuard>) => setGuard(id, normalizeGuard({ ...g, ...p }));
  return (
    <div className="spend-row" data-guard={guard ? "on" : "off"}>
      <label className="spend-row-name" title={name}>
        <input
          type="checkbox"
          checked={!!guard}
          aria-label={`Daily budget for ${name}`}
          onChange={(e) => setGuard(id, e.currentTarget.checked ? normalizeGuard(g) : null)}
        />
        <span>{name}</span>
      </label>
      {guard && (
        <>
          <span className="spend-row-field" title="Daily budget in US dollars (Claude Code's estimate)">
            $ <NumberInput value={g.budgetUsd} min={0.5} max={100000} step={0.5} width={84} onCommit={(v) => patch({ budgetUsd: v })} />
          </span>
          <span className="spend-row-field" title="Toast when this share of the budget is used">
            warn at <NumberInput value={g.warnPct} min={1} max={99} width={60} onCommit={(v) => patch({ warnPct: v })} /> %
          </span>
          <Select
            value={g.action}
            aria-label={`At 100% of the budget for ${name}`}
            title="At 100% of the budget"
            onChange={(e) => patch({ action: e.currentTarget.value as SpendAction })}
          >
            {SPEND_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABEL[a]}
              </option>
            ))}
          </Select>
        </>
      )}
    </div>
  );
}
