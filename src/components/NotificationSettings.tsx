// Settings › Notifications: what to be told about, how, with which sound, when to stay quiet, which
// agents count, and the mute list. Persisted in settings.notifications; rules run in notifyRules.ts.

import { useEffect, useState, type ReactNode } from "react";
import { SOUND_SETS, playSound } from "../audio/sounds";
import { toggleSessionMute, toggleWorkspaceMute, updateNotif, useNotif } from "../actions/notifyPrefs";
import { inQuietHours } from "../actions/notifyRules";
import { useT, type MessageKey, type Translator } from "../i18n";
import { APP_NAME } from "../lib/brand";
import { osNotificationName, shellLabel } from "../lib/platform";
import type { NotificationSettings as Notif, NotifyDelivery, SoundSet } from "../lib/types";
import { useApp } from "../store/appStore";
import { IconBellOff } from "./MutedGlyph";
import { Button } from "./ui/Button";
import { Segmented, Toggle } from "./ui/Field";
import "../styles/attention.css";
import "../styles/experience.css";

function Section({ title, hint, children, disabled }: { title: string; hint?: ReactNode; children: ReactNode; disabled?: boolean }) {
  return (
    <section className={`notif-section${disabled ? " is-disabled" : ""}`} aria-disabled={disabled || undefined}>
      <div className="notif-section-head">
        <span className="micro-label">{title}</span>
        {hint && <span className="notif-section-hint">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function CheckCard({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string; disabled?: boolean }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} disabled={disabled} className={`notif-check${checked ? " is-on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="notif-check-box" aria-hidden="true" />
      <span className="notif-check-text">
        <span className="notif-check-label">{label}</span>
        <span className="notif-check-hint">{hint}</span>
      </span>
    </button>
  );
}

const EVENTS: { key: keyof Pick<Notif, "onInput" | "onIdle" | "onError" | "onBell">; label: MessageKey; hint: MessageKey }[] = [
  { key: "onInput", label: "notifications.event.inputLabel", hint: "notifications.event.inputHint" },
  { key: "onIdle", label: "notifications.event.idleLabel", hint: "notifications.event.idleHint" },
  { key: "onError", label: "notifications.event.errorLabel", hint: "notifications.event.errorHint" },
  { key: "onBell", label: "notifications.event.bellLabel", hint: "notifications.event.bellHint" },
];

// Product names stay as they are; "Other tools" follows the UI language (translated at render time).
const AGENTS: { key: keyof Notif["agents"]; label: (t: Translator) => string }[] = [
  { key: "claude", label: () => "Claude Code" },
  { key: "codex", label: () => "Codex" },
  { key: "powershell", label: () => shellLabel() },
  { key: "other", label: (t) => t("notifications.agentsOther") },
];

/** Re-render once a minute while mounted so "quiet hours active now" stays true. */
function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

export function NotificationSettings() {
  const t = useT();
  const n = useNotif();
  const sessions = useApp((s) => s.persisted.sessions);
  const workspaces = useApp((s) => s.persisted.workspaces);
  const now = new Date(useMinuteTick());
  const quietNow = inQuietHours(now.getHours() * 60 + now.getMinutes(), n.quietHours);
  const off = !n.enabled;
  const preview = (set: SoundSet) => playSound(set, "needsInput", n.volume || 50);

  const status = off
    ? t("notifications.statusOff")
    : n.dnd
      ? t("notifications.statusDnd")
      : quietNow
        ? t("notifications.statusQuiet", { end: n.quietHours.end })
        : n.delivery === "off"
          ? t("notifications.statusFeedOnly")
          : t("notifications.statusOn");
  const system = osNotificationName();

  return (
    <div className="notif-settings">
      <div className={`notif-master${off ? "" : " is-on"}`}>
        <Toggle
          checked={n.enabled}
          onChange={(enabled) => updateNotif({ enabled })}
          label={t("notifications.master")}
          hint={t("notifications.masterHint", { status, app: APP_NAME })}
        />
      </div>

      <Section title={t("notifications.tellMeWhen")} disabled={off}>
        <div className="notif-grid">
          {EVENTS.map((e) => (
            <CheckCard key={e.key} checked={n[e.key]} disabled={off} onChange={(v) => updateNotif({ [e.key]: v } as Partial<Notif>)} label={t(e.label)} hint={t(e.hint)} />
          ))}
        </div>
      </Section>

      <Section title={t("notifications.delivery")} disabled={off}>
        <Segmented<NotifyDelivery>
          ariaLabel={t("notifications.delivery")}
          value={n.delivery}
          onChange={(delivery) => updateNotif({ delivery })}
          options={[
            { value: "toast", label: t("notifications.deliveryToast", { system }), title: t("notifications.deliveryToastTitle", { system }), disabled: off },
            { value: "inApp", label: t("notifications.deliveryInApp"), title: t("notifications.deliveryInAppTitle", { system }), disabled: off },
            { value: "off", label: t("notifications.deliveryOff"), title: t("notifications.deliveryOffTitle"), disabled: off },
          ]}
        />
        <Toggle
          checked={n.onlyWhenUnfocused}
          disabled={off}
          onChange={(onlyWhenUnfocused) => updateNotif({ onlyWhenUnfocused })}
          label={t("notifications.onlyUnfocused")}
          hint={t("notifications.onlyUnfocusedHint")}
        />
      </Section>

      <Section title={t("notifications.sound")} hint={t("notifications.soundHint")} disabled={off}>
        <Toggle checked={n.sound} disabled={off} onChange={(sound) => updateNotif({ sound })} label={t("notifications.soundToggle")} />
        <div className={`sound-sets${!n.sound || off ? " is-dim" : ""}`} role="radiogroup" aria-label={t("notifications.soundSetAria")}>
          {SOUND_SETS.map((s) => (
            <div key={s.id} className={`sound-set${n.soundSet === s.id ? " is-selected" : ""}`}>
              <button
                type="button"
                role="radio"
                aria-checked={n.soundSet === s.id}
                className="sound-set-pick"
                disabled={off}
                onClick={() => {
                  updateNotif({ soundSet: s.id, sound: s.id === "none" ? n.sound : true });
                  preview(s.id);
                }}
                title={s.hint}
              >
                <span className="sound-set-name">{s.name}</span>
                <span className="sound-set-hint">{s.hint}</span>
              </button>
              {s.id !== "none" && (
                <button type="button" className="icon-btn icon-btn-sm sound-set-play" aria-label={t("notifications.playSet", { name: s.name })} title={t("notifications.playSet", { name: s.name })} disabled={off} onClick={() => preview(s.id)}>
                  <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M5 3.5v9l7-4.5z" fill="currentColor" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
        <label className="volume-row">
          <span className="volume-label">{t("notifications.volume")}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={n.volume}
            disabled={off || !n.sound}
            aria-label={t("notifications.volume")}
            onChange={(e) => updateNotif({ volume: Number(e.currentTarget.value) })}
            onPointerUp={() => preview(n.soundSet === "none" ? "comm" : n.soundSet)}
            onKeyUp={(e) => (e.key.startsWith("Arrow") ? preview(n.soundSet === "none" ? "comm" : n.soundSet) : undefined)}
          />
          <span className="volume-value mono">{n.volume}%</span>
        </label>
      </Section>

      <Section title={t("notifications.quiet")} disabled={off}>
        <Toggle
          checked={n.dnd}
          disabled={off}
          onChange={(dnd) => updateNotif({ dnd })}
          label={t("notifications.dnd")}
          hint={t("notifications.dndHint")}
        />
        <div className="quiet-hours">
          <Toggle
            checked={n.quietHours.enabled}
            disabled={off}
            onChange={(enabled) => updateNotif({ quietHours: { ...n.quietHours, enabled } })}
            label={t("notifications.quietHours")}
            hint={quietNow ? t("notifications.quietHoursActive") : t("notifications.quietHoursHint")}
          />
          <div className="quiet-times">
            <label>
              <span>{t("notifications.quietFrom")}</span>
              <input
                type="time"
                className="input"
                value={n.quietHours.start}
                disabled={off || !n.quietHours.enabled}
                onChange={(e) => e.currentTarget.value && updateNotif({ quietHours: { ...n.quietHours, start: e.currentTarget.value } })}
              />
            </label>
            <label>
              <span>{t("notifications.quietTo")}</span>
              <input
                type="time"
                className="input"
                value={n.quietHours.end}
                disabled={off || !n.quietHours.enabled}
                onChange={(e) => e.currentTarget.value && updateNotif({ quietHours: { ...n.quietHours, end: e.currentTarget.value } })}
              />
            </label>
          </div>
        </div>
      </Section>

      <Section title={t("notifications.agents")} hint={t("notifications.agentsHint")} disabled={off}>
        <div className="notif-agents">
          {AGENTS.map((a) => (
            <button
              key={a.key}
              type="button"
              role="checkbox"
              aria-checked={n.agents[a.key]}
              disabled={off}
              className={`notif-agent${n.agents[a.key] ? " is-on" : ""}`}
              onClick={() => updateNotif({ agents: { ...n.agents, [a.key]: !n.agents[a.key] } })}
            >
              <span className="notif-check-box" aria-hidden="true" />
              {a.label(t)}
            </button>
          ))}
        </div>
      </Section>

      <Section title={t("notifications.muted")} hint={t("notifications.mutedHint")}>
        {n.mutedSessions.length === 0 && n.mutedWorkspaces.length === 0 ? (
          <p className="notif-empty">{t("notifications.mutedEmpty")}</p>
        ) : (
          <ul className="notif-muted-list">
            {n.mutedWorkspaces.map((id) => (
              <li key={`w-${id}`}>
                <IconBellOff size={12} />
                <span className="notif-muted-name">{workspaces.find((w) => w.id === id)?.name ?? t("notifications.mutedWorkspaceFallback")}</span>
                <span className="notif-muted-kind">{t("notifications.mutedKindWorkspace")}</span>
                <Button size="sm" variant="ghost" onClick={() => toggleWorkspaceMute(id, false)}>
                  {t("notifications.unmute")}
                </Button>
              </li>
            ))}
            {n.mutedSessions.map((id) => (
              <li key={`s-${id}`}>
                <IconBellOff size={12} />
                <span className="notif-muted-name">{sessions.find((m) => m.id === id)?.name ?? t("notifications.mutedSessionFallback")}</span>
                <span className="notif-muted-kind">{t("notifications.mutedKindSession")}</span>
                <Button size="sm" variant="ghost" onClick={() => toggleSessionMute(id, false)}>
                  {t("notifications.unmute")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <p className="hint attn-settings-note">{t.rich("notifications.bellNote", { app: APP_NAME, mono: (c) => <span className="mono">{c}</span> })}</p>
    </div>
  );
}
