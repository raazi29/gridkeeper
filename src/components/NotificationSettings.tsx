// Settings › Notifications: what to be told about, how, with which sound, when to stay quiet, which
// agents count, and the mute list. Persisted in settings.notifications; rules run in notifyRules.ts.

import { useEffect, useState, type ReactNode } from "react";
import { SOUND_SETS, playSound } from "../audio/sounds";
import { toggleSessionMute, toggleWorkspaceMute, updateNotif, useNotif } from "../actions/notifyPrefs";
import { inQuietHours } from "../actions/notifyRules";
import { APP_NAME } from "../lib/brand";
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

const EVENTS: { key: keyof Pick<Notif, "onInput" | "onIdle" | "onError" | "onBell">; label: string; hint: string }[] = [
  { key: "onInput", label: "Needs input", hint: "Permission prompts, questions, “waiting for you”" },
  { key: "onIdle", label: "Finished", hint: "Went quiet after working, or reported done" },
  { key: "onError", label: "Error", hint: "Crashed, failed to start, reported an error" },
  { key: "onBell", label: "Bell / notify", hint: "Terminal bell and OSC 9 / 777 / 99 notifications" },
];

const AGENTS: { key: keyof Notif["agents"]; label: string }[] = [
  { key: "claude", label: "Claude Code" },
  { key: "codex", label: "Codex" },
  { key: "powershell", label: "PowerShell" },
  { key: "other", label: "Other tools" },
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
  const n = useNotif();
  const sessions = useApp((s) => s.persisted.sessions);
  const workspaces = useApp((s) => s.persisted.workspaces);
  const now = new Date(useMinuteTick());
  const quietNow = inQuietHours(now.getHours() * 60 + now.getMinutes(), n.quietHours);
  const off = !n.enabled;
  const preview = (set: SoundSet) => playSound(set, "needsInput", n.volume || 50);

  const status = off
    ? "Off — alerts only light the lamps and collect in Comms."
    : n.dnd
      ? "Do not disturb is on — alerts collect silently in Comms."
      : quietNow
        ? `Quiet hours until ${n.quietHours.end} — alerts collect silently in Comms.`
        : n.delivery === "off"
          ? "Comms feed only — no toasts."
          : "On";

  return (
    <div className="notif-settings">
      <div className={`notif-master${off ? "" : " is-on"}`}>
        <Toggle
          checked={n.enabled}
          onChange={(enabled) => updateNotif({ enabled })}
          label="Notifications"
          hint={`${status} ${APP_NAME} never pings you about the pane you are looking at.`}
        />
      </div>

      <Section title="Tell me when a session…" disabled={off}>
        <div className="notif-grid">
          {EVENTS.map((e) => (
            <CheckCard key={e.key} checked={n[e.key]} disabled={off} onChange={(v) => updateNotif({ [e.key]: v } as Partial<Notif>)} label={e.label} hint={e.hint} />
          ))}
        </div>
      </Section>

      <Section title="Delivery" disabled={off}>
        <Segmented<NotifyDelivery>
          ariaLabel="Delivery"
          value={n.delivery}
          onChange={(delivery) => updateNotif({ delivery })}
          options={[
            { value: "toast", label: "Windows + in-app", title: "Windows notification while in the background; in-app toast with Jump while in front", disabled: off },
            { value: "inApp", label: "In-app only", title: "Only in-app toasts, never Windows notifications", disabled: off },
            { value: "off", label: "Comms feed only", title: "No toasts; alerts only collect in Comms", disabled: off },
          ]}
        />
        <Toggle
          checked={n.onlyWhenUnfocused}
          disabled={off}
          onChange={(onlyWhenUnfocused) => updateNotif({ onlyWhenUnfocused })}
          label="Only while the window is in the background"
          hint="No in-app toasts while you are working in the app; the lamps and Comms still show everything."
        />
      </Section>

      <Section title="Sound" hint="Synthesized in-app — no audio files." disabled={off}>
        <Toggle checked={n.sound} disabled={off} onChange={(sound) => updateNotif({ sound })} label="Play a sound with each alert" />
        <div className={`sound-sets${!n.sound || off ? " is-dim" : ""}`} role="radiogroup" aria-label="Sound set">
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
                <button type="button" className="icon-btn icon-btn-sm sound-set-play" aria-label={`Play ${s.name}`} title={`Play ${s.name}`} disabled={off} onClick={() => preview(s.id)}>
                  <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M5 3.5v9l7-4.5z" fill="currentColor" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
        <label className="volume-row">
          <span className="volume-label">Volume</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={n.volume}
            disabled={off || !n.sound}
            aria-label="Volume"
            onChange={(e) => updateNotif({ volume: Number(e.currentTarget.value) })}
            onPointerUp={() => preview(n.soundSet === "none" ? "comm" : n.soundSet)}
            onKeyUp={(e) => (e.key.startsWith("Arrow") ? preview(n.soundSet === "none" ? "comm" : n.soundSet) : undefined)}
          />
          <span className="volume-value mono">{n.volume}%</span>
        </label>
      </Section>

      <Section title="Quiet" disabled={off}>
        <Toggle
          checked={n.dnd}
          disabled={off}
          onChange={(dnd) => updateNotif({ dnd })}
          label="Do not disturb"
          hint="Silences toasts and sounds until you turn it off. Quick toggle: hold or right-click the Comms bell."
        />
        <div className="quiet-hours">
          <Toggle
            checked={n.quietHours.enabled}
            disabled={off}
            onChange={(enabled) => updateNotif({ quietHours: { ...n.quietHours, enabled } })}
            label="Quiet hours"
            hint={quietNow ? "Active now." : "Every day, local time. May cross midnight."}
          />
          <div className="quiet-times">
            <label>
              <span>From</span>
              <input
                type="time"
                className="input"
                value={n.quietHours.start}
                disabled={off || !n.quietHours.enabled}
                onChange={(e) => e.currentTarget.value && updateNotif({ quietHours: { ...n.quietHours, start: e.currentTarget.value } })}
              />
            </label>
            <label>
              <span>to</span>
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

      <Section title="Agents" hint="Which kinds of session may notify you." disabled={off}>
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
              {a.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Muted" hint="Muted alerts still appear in Comms, marked muted.">
        {n.mutedSessions.length === 0 && n.mutedWorkspaces.length === 0 ? (
          <p className="notif-empty">Nothing muted. Mute a pane from its ⋯ menu, or a workspace from its right-click menu in the sidebar.</p>
        ) : (
          <ul className="notif-muted-list">
            {n.mutedWorkspaces.map((id) => (
              <li key={`w-${id}`}>
                <IconBellOff size={12} />
                <span className="notif-muted-name">{workspaces.find((w) => w.id === id)?.name ?? "Workspace"}</span>
                <span className="notif-muted-kind">workspace</span>
                <Button size="sm" variant="ghost" onClick={() => toggleWorkspaceMute(id, false)}>
                  Unmute
                </Button>
              </li>
            ))}
            {n.mutedSessions.map((id) => (
              <li key={`s-${id}`}>
                <IconBellOff size={12} />
                <span className="notif-muted-name">{sessions.find((m) => m.id === id)?.name ?? "Session"}</span>
                <span className="notif-muted-kind">session</span>
                <Button size="sm" variant="ghost" onClick={() => toggleSessionMute(id, false)}>
                  Unmute
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <p className="hint attn-settings-note">
        Agents only ring the bell when asked to: for Claude Code set <span className="mono">preferredNotifChannel</span> to <span className="mono">terminal_bell</span>; for Codex set{" "}
        <span className="mono">tui.notification_condition = "always"</span>. Without that, {APP_NAME} still notices when output goes quiet.
      </p>
    </div>
  );
}
