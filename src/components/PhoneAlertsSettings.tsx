// Settings › Notifications › Phone alerts: opt-in ntfy push to the user's phone. Off by default; nothing is sent
// until it is turned on or "Send test" is pressed. The access token is write-only (only `hasToken` comes back).
// Settings live in Rust (phone-alerts.json), not in workspaces.json; lib/phoneAlerts.ts decides which events go.

import { useEffect, useState } from "react";
import { errorMessage, ipc } from "../lib/ipc";
import { setPhoneConfig } from "../lib/phoneAlerts";
import type { PhoneAlertsView, PhoneConfig, PhoneEventKind } from "../lib/types";
import { Button } from "./ui/Button";
import { Field, Input, Select, Toggle } from "./ui/Field";

const EVENTS: { key: PhoneEventKind; label: string; hint: string }[] = [
  { key: "needsInput", label: "Needs input", hint: "Permission prompts, questions, “waiting for you”, terminal bells" },
  { key: "error", label: "Error", hint: "Crashed, failed to start, reported an error" },
  { key: "proposal", label: "Lead proposal", hint: "A lead's instruction waits for your approval" },
  { key: "missionDone", label: "Mission complete", hint: "Every task on the board is checked off" },
  { key: "done", label: "Finished", hint: "A pane went quiet after working (noisy)" },
];

const PRIORITIES = ["1 · min", "2 · low", "3 · default", "4 · high", "5 · max"];

const TOKEN_NOTE = {
  credentialManager: "Stored in Windows Credential Manager.",
  file: "Stored in a file in the app data folder that only you can read (no keychain integration yet).",
} as const;

export function PhoneAlertsSettings() {
  const [view, setView] = useState<PhoneAlertsView | null>(null);
  const [server, setServer] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = (v: PhoneAlertsView) => {
    setView(v);
    setServer(v.config.server);
    setPhoneConfig(v.config);
    setError(null);
  };
  /** Run one backend call; show its error instead of throwing. */
  const run = async (call: () => Promise<PhoneAlertsView>) => {
    setBusy(true);
    try {
      apply(await call());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void run(() => ipc.phoneAlertsGet());
  }, []);

  if (!view) return <p className="hint">{error ?? "Loading phone alerts…"}</p>;
  const c = view.config;
  const save = (patch: Partial<PhoneConfig>) => run(() => ipc.phoneAlertsSet({ ...c, ...patch }));
  const s = view.status;
  const status = [
    `${s.sent} sent`,
    s.failures > 0 ? `${s.failures} failed` : null,
    s.suppressed > 0 ? `${s.suppressed} held back by the rate limit` : null,
    s.pausedUntilMs ? `paused until ${new Date(s.pausedUntilMs).toLocaleTimeString()}` : null,
    s.failing && s.lastError ? `last error: ${s.lastError}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="notif-section">
      <div className="notif-section-head">
        <span className="micro-label">Phone alerts</span>
        <span className="notif-section-hint">A short, generic push to your phone through ntfy. Never terminal output.</span>
      </div>
      <Toggle
        checked={c.enabled}
        disabled={busy}
        onChange={(enabled) => save({ enabled })}
        label="Send alerts to my phone"
        hint="Off by default. When on, one HTTPS request per alert goes to the server below and nowhere else. Install the ntfy app and subscribe to your topic."
      />
      {error && (
        <p className="field-msg is-error" role="alert">
          {error}
        </p>
      )}
      <Field label="Server" htmlFor="phone-server">
        <Input
          id="phone-server"
          mono
          value={server}
          onChange={(e) => setServer(e.currentTarget.value)}
          onBlur={() => server.trim() !== c.server && save({ server })}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </Field>
      <Field
        label="Topic"
        htmlFor="phone-topic"
        hint="On a public server the topic acts like a password: anyone who knows it can read your alerts. A new topic means subscribing again on your phone."
      >
        <div style={{ display: "flex", gap: 8 }}>
          <Input id="phone-topic" mono readOnly value={c.topic} placeholder="Press “New random topic”" style={{ flex: 1 }} />
          <Button disabled={busy} onClick={() => run(() => ipc.phoneAlertsNewTopic())}>
            New random topic
          </Button>
        </div>
      </Field>
      <Field label="Access token" htmlFor="phone-token" hint={`Only for servers that need a login. ${TOKEN_NOTE[view.tokenStorage]}`}>
        {view.hasToken ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span>Token saved</span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => ipc.phoneAlertsSetToken(null))}>
              Clear
            </Button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 8 }}>
            <Input id="phone-token" mono type="password" value={token} placeholder="tk_…" style={{ flex: 1 }} onChange={(e) => setToken(e.currentTarget.value)} />
            <Button
              disabled={busy || !token.trim()}
              onClick={async () => {
                await run(() => ipc.phoneAlertsSetToken(token));
                setToken("");
              }}
            >
              Save token
            </Button>
          </div>
        )}
      </Field>

      <span className="micro-label">Tell my phone when…</span>
      {EVENTS.map((e) => (
        <Toggle key={e.key} checked={c.events[e.key]} disabled={busy} onChange={(v) => save({ events: { ...c.events, [e.key]: v } })} label={e.label} hint={e.hint} />
      ))}
      <Field label="Minimum priority" htmlFor="phone-priority" hint="Needs input and errors are high (4); everything else is default (3).">
        <Select id="phone-priority" value={c.minPriority} disabled={busy} onChange={(e) => save({ minPriority: Number(e.currentTarget.value) })}>
          {PRIORITIES.map((p, i) => (
            <option key={p} value={i + 1}>
              {p}
            </option>
          ))}
        </Select>
      </Field>
      <div className="quiet-hours">
        <Toggle
          checked={c.quietHours.enabled}
          disabled={busy}
          onChange={(enabled) => save({ quietHours: { ...c.quietHours, enabled } })}
          label="Phone quiet hours"
          hint="Separate from the quiet hours above. Do not disturb and muted panes also keep alerts off your phone."
        />
        <div className="quiet-times">
          {(["start", "end"] as const).map((k) => (
            <label key={k}>
              <span>{k === "start" ? "From" : "to"}</span>
              <input
                type="time"
                className="input"
                value={c.quietHours[k]}
                disabled={busy || !c.quietHours.enabled}
                onChange={(e) => e.currentTarget.value && save({ quietHours: { ...c.quietHours, [k]: e.currentTarget.value } })}
              />
            </label>
          ))}
        </div>
      </div>
      <Toggle checked={c.includeNames} disabled={busy} onChange={(includeNames) => save({ includeNames })} label="Include pane and workspace names" hint="“builder-1 needs you · OAuth demo”. Off: “An agent needs you”." />
      <Toggle
        checked={c.includeTaskNames}
        disabled={busy}
        onChange={(includeTaskNames) => save({ includeTaskNames })}
        label="Include task names"
        hint="Adds the mission goal to “mission complete”. Off by default: it can describe your work."
      />
      <Toggle checked={c.onlyWhenAway} disabled={busy} onChange={(onlyWhenAway) => save({ onlyWhenAway })} label="Only while the window is in the background" />

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Button
          disabled={busy || !c.topic}
          onClick={async () => {
            setTest("Sending…");
            try {
              const r = await ipc.phoneAlertsTest();
              setTest(r.outcome === "sent" ? "Test sent. Check your phone." : (r.detail ?? r.outcome));
              apply(await ipc.phoneAlertsGet());
            } catch (e) {
              setTest(errorMessage(e));
            }
          }}
        >
          Send test
        </Button>
        {test && <span className="hint" role="status">{test}</span>}
      </div>
      <p className="hint">{status}</p>
    </section>
  );
}
