// Settings › Notifications › Phone alerts: opt-in ntfy push to the user's phone. Off by default; nothing is sent
// until it is turned on or "Send test" is pressed. The access token is write-only (only `hasToken` comes back).
// Settings live in Rust (phone-alerts.json), not in workspaces.json; lib/phoneAlerts.ts decides which events go.
// Also exports the Diagnostics line (PhoneAlertsDiagnostics). Plain English strings on purpose (i18n comes later).

import { useEffect, useMemo, useState } from "react";
import { errorMessage, ipc } from "../../lib/ipc";
import { PHONE_PRIORITY, serverProblem, setPhoneConfig, subscribeLinks, weakTopic } from "../../lib/phoneAlerts";
import { encodeQr, qrPath } from "../../lib/qrcode";
import type { PhoneAlertsView, PhoneConfig, PhoneEventKind, PhoneStatus } from "../../lib/types";
import { Button } from "../ui/Button";
import { Field, Input, Segmented, Select, Toggle } from "../ui/Field";

const EVENTS: { key: PhoneEventKind; label: string; hint: string }[] = [
  { key: "needsInput", label: "Needs input", hint: "Permission prompts, questions, “waiting for you”, terminal bells" },
  { key: "error", label: "Error", hint: "Crashed, failed to start, reported an error" },
  { key: "proposal", label: "Lead proposal", hint: "A lead's instruction waits for your approval" },
  { key: "missionDone", label: "Mission done", hint: "The last task on a mission board is checked off (while the board is open or under lead control)" },
  { key: "done", label: "Finished", hint: "A pane went quiet after working (noisy)" },
];

const PRIORITIES = ["1 · min", "2 · low", "3 · default", "4 · high", "5 · max"];

const TOKEN_NOTE = {
  credentialManager: "Stored in Windows Credential Manager, never shown again.",
  file: "Stored in a file in the app data folder that only your user account can read (not the system keychain).",
} as const;

function statusLine(s: PhoneStatus): string {
  return [
    `${s.sent} sent`,
    s.failures > 0 ? `${s.failures} failed` : null,
    s.suppressed > 0 ? `${s.suppressed} held back by the rate limit` : null,
    s.pausedUntilMs ? `paused until ${new Date(s.pausedUntilMs).toLocaleTimeString()}` : null,
    s.failing && s.lastError ? `last error: ${s.lastError}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** QR code of the subscription link, drawn offline (lib/qrcode.ts). Hidden until asked: the topic is the secret. */
function SubscribeQr({ server, topic }: { server: string; topic: string }) {
  const [show, setShow] = useState(false);
  const [target, setTarget] = useState<"web" | "app">("web");
  const links = subscribeLinks(server, topic);
  const text = links[target];
  const qr = useMemo(() => (show ? encodeQr(text, "M") : null), [show, text]);
  const dim = qr ? qr.size + 8 : 0;
  return (
    <Field
      label="Subscribe on your phone"
      hint="Install the ntfy app (Android or iOS), then scan the code or add the topic by hand. Anyone who sees this code or link can read your alerts."
    >
      {!show ? (
        <Button size="sm" onClick={() => setShow(true)}>
          Show QR code and link
        </Button>
      ) : (
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          {qr && (
            <svg width={176} height={176} viewBox={`0 0 ${dim} ${dim}`} role="img" aria-label="QR code of the subscription link" shapeRendering="crispEdges" style={{ background: "#fff", borderRadius: 4, flex: "none" }}>
              <path d={qrPath(qr)} fill="#000" />
            </svg>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, flex: 1 }}>
            <Segmented<"web" | "app">
              ariaLabel="What the code opens"
              size="sm"
              value={target}
              onChange={setTarget}
              options={[
                { value: "web", label: "Web page", title: "Opens the topic in the phone's browser (works everywhere; the ntfy web app can subscribe)" },
                { value: "app", label: "ntfy app link", title: "ntfy:// link: subscribes in the ntfy Android app directly" },
              ]}
            />
            <span className="mono" style={{ wordBreak: "break-all", userSelect: "text" }}>
              {text}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <Button size="sm" onClick={() => void navigator.clipboard?.writeText(text).catch(() => {})}>
                Copy link
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShow(false)}>
                Hide
              </Button>
            </div>
          </div>
        </div>
      )}
    </Field>
  );
}

export function PhoneAlerts() {
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
  const serverHint = serverProblem(server);
  const publicServer = c.server === "https://ntfy.sh";

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
        hint="Off by default. When on, one HTTPS request per alert goes to the server below and nowhere else: at most one per pane every 2 minutes and 10 per hour, never retried."
      />
      {error && (
        <p className="field-msg is-error" role="alert">
          {error}
        </p>
      )}
      <Field
        label="Server"
        htmlFor="phone-server"
        warn={serverHint ?? undefined}
        hint={publicServer ? "ntfy.sh is a free public server: messages pass through it (and Google / Apple push services) unencrypted and are kept for up to 12 hours. For privacy, use your own server or an access token." : "Your own ntfy server."}
      >
        <Input
          id="phone-server"
          mono
          value={server}
          invalid={!!serverHint}
          onChange={(e) => setServer(e.currentTarget.value)}
          onBlur={() => server.trim() !== c.server && !serverHint && save({ server })}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </Field>
      <Field
        label="Topic"
        htmlFor="phone-topic"
        warn={c.topic && weakTopic(c.topic) ? "This topic is short or a plain word: anyone could guess it. Generate a new one." : undefined}
        hint="The topic acts like a password: anyone who knows it can read your alerts. Gridkeeper generates a long random one. A new topic means subscribing again on your phone."
      >
        <div style={{ display: "flex", gap: 8 }}>
          <Input id="phone-topic" mono readOnly value={c.topic} placeholder="Turn alerts on or press “New random topic”" style={{ flex: 1 }} />
          <Button disabled={busy} onClick={() => run(() => ipc.phoneAlertsNewTopic())}>
            New random topic
          </Button>
        </div>
      </Field>
      {c.topic && <SubscribeQr server={c.server} topic={c.topic} />}
      <Field label="Access token (optional)" htmlFor="phone-token" hint={`For servers that require a login (create one with “ntfy token add”). ${TOKEN_NOTE[view.tokenStorage]}`}>
        {view.hasToken ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span>Token saved</span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => ipc.phoneAlertsSetToken(null))}>
              Remove
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
        <Toggle
          key={e.key}
          checked={c.events[e.key]}
          disabled={busy}
          onChange={(v) => save({ events: { ...c.events, [e.key]: v } })}
          label={`${e.label} (priority ${PHONE_PRIORITY[e.key]})`}
          hint={e.hint}
        />
      ))}
      <Field label="Minimum priority" htmlFor="phone-priority" hint="Alerts below this priority stay off your phone.">
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
          hint="Separate from the desktop quiet hours above. Do not disturb and muted panes or workspaces also keep alerts off your phone."
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
        hint="Adds the mission goal: “Mission done: Add OAuth login (8/8)”. Off by default: it can describe your work."
      />
      <Toggle
        checked={c.onlyWhenAway}
        disabled={busy}
        onChange={(onlyWhenAway) => save({ onlyWhenAway })}
        label="Only while the Gridkeeper window is in the background"
        hint="Never for the pane you are looking at, either way."
      />

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
        {test && (
          <span className="hint" role="status">
            {test}
          </span>
        )}
      </div>
      <p className="hint">{statusLine(view.status)}</p>
    </section>
  );
}

/** Diagnostics: phone-alert delivery state, shown only when phone alerts are on or something failed. */
export function PhoneAlertsDiagnostics() {
  const [view, setView] = useState<PhoneAlertsView | null>(null);
  useEffect(() => {
    let live = true;
    ipc
      .phoneAlertsGet()
      .then((v) => live && setView(v))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!view || (!view.config.enabled && view.status.failures === 0)) return null;
  const s = view.status;
  return (
    <div className={`callout${s.failing ? " is-warn" : ""}`} role="status">
      Phone alerts: {statusLine(s)}
      {s.failing && s.lastErrorMs ? ` (at ${new Date(s.lastErrorMs).toLocaleTimeString()})` : ""}
    </div>
  );
}
