// Settings › Agents: "Exact status for Claude panes (hooks)" and the per-workspace spend guard.

import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { useT, type MessageKey } from "../../i18n";
import { DEFAULT_GUARD, normalizeGuard, SPEND_ACTIONS, spendNote } from "../../lib/spend";
import type { SpendAction, SpendGuard } from "../../lib/types";
import { useApp } from "../../store/appStore";
import { setGuard } from "../../store/spend";
import { NumberInput, Select, Toggle } from "../ui/Field";
import "./spend.css";

const ACTION_LABEL: Record<SpendAction, MessageKey> = {
  warn: "spend.action.warn",
  pause: "spend.action.pause",
  pauseNotify: "spend.action.pauseNotify",
};

const code = (c: ReactNode) => <code>{c}</code>;

export function ClaudeHooksSetting() {
  const t = useT();
  const meter = useApp((s) => s.persisted.settings.costMeter ?? false);
  const on = useApp((s) => s.persisted.settings.claudeHooks ?? true);
  return (
    <div className="cost-meter-setting">
      <div className="micro-label">{t("hooks.setting.title")}</div>
      <Toggle
        checked={on}
        disabled={!meter}
        onChange={(v) => useApp.getState().updateSettings({ claudeHooks: v })}
        label={t("hooks.setting.label")}
        hint={
          <>
            {meter ? "" : `${t("hooks.setting.needsMeter")} `}
            {t.rich("hooks.setting.hint", { code })}
          </>
        }
      />
    </div>
  );
}

export function SpendGuardSettings() {
  const t = useT();
  const meter = useApp((s) => s.persisted.settings.costMeter ?? false);
  const workspaces = useApp(useShallow((s) => s.persisted.workspaces.map((w) => `${w.id}\u0000${w.name}`)));
  const guards = useApp((s) => s.persisted.settings.spendGuards);
  return (
    <div className="cost-meter-setting spend-settings">
      <div className="micro-label">{t("spend.settings.title")}</div>
      <div className="hint">
        {t("spend.settings.hint", { note: spendNote() })}
        {meter ? "" : ` ${t("spend.settings.needsMeter")}`}
      </div>
      {workspaces.length === 0 && <div className="hint">{t("spend.settings.noWorkspaces")}</div>}
      {workspaces.map((row) => {
        const [id, name] = row.split("\u0000");
        return <GuardRow key={id} id={id} name={name} guard={normalizeGuard(guards?.[id])} />;
      })}
    </div>
  );
}

function GuardRow({ id, name, guard }: { id: string; name: string; guard: SpendGuard | null }) {
  const t = useT();
  const g = guard ?? DEFAULT_GUARD;
  const patch = (p: Partial<SpendGuard>) => setGuard(id, normalizeGuard({ ...g, ...p }));
  return (
    <div className="spend-row" data-guard={guard ? "on" : "off"}>
      <label className="spend-row-name" title={name}>
        <input
          type="checkbox"
          checked={!!guard}
          aria-label={t("spend.settings.budgetAria", { name })}
          onChange={(e) => setGuard(id, e.currentTarget.checked ? normalizeGuard(g) : null)}
        />
        <span>{name}</span>
      </label>
      {guard && (
        <>
          <span className="spend-row-field" title={t("spend.settings.budgetTitle")}>
            $ <NumberInput value={g.budgetUsd} min={0.5} max={100000} step={0.5} width={84} onCommit={(v) => patch({ budgetUsd: v })} />
          </span>
          <span className="spend-row-field" title={t("spend.settings.warnTitle")}>
            {t.rich("spend.settings.warnAt", { input: <NumberInput value={g.warnPct} min={1} max={99} width={60} onCommit={(v) => patch({ warnPct: v })} /> })}
          </span>
          <Select
            value={g.action}
            aria-label={t("spend.settings.actionAria", { name })}
            title={t("spend.settings.actionTitle")}
            onChange={(e) => patch({ action: e.currentTarget.value as SpendAction })}
          >
            {SPEND_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t(ACTION_LABEL[a])}
              </option>
            ))}
          </Select>
        </>
      )}
    </div>
  );
}
