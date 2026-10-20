// Settings › Notifications › Phone alerts: opt-in ntfy push to the user's phone. Off by default; nothing is sent
// until it is turned on or "Send test" is pressed. The access token is write-only (only `hasToken` comes back).
// Settings live in Rust (phone-alerts.json), not in workspaces.json; lib/phoneAlerts.ts decides which events go.
// Also exports the Diagnostics line (PhoneAlertsDiagnostics).

import { useEffect, useMemo, useState } from "react";
import { intlLocale, useT, type MessageKey, type Translator } from "../../i18n";
import { errorMessage, ipc } from "../../lib/ipc";
import { PHONE_PRIORITY, serverProblem, setPhoneConfig, subscribeLinks, weakTopic } from "../../lib/phoneAlerts";
import { encodeQr, qrPath } from "../../lib/qrcode";
import type { PhoneAlertsView, PhoneConfig, PhoneEventKind, PhoneStatus } from "../../lib/types";
import { Button } from "../ui/Button";
import { Field, Input, Segmented, Select, Toggle } from "../ui/Field";

const EVENTS: { key: PhoneEventKind; label: MessageKey; hint: MessageKey }[] = [
  { key: "needsInput", label: "phone.event.needsInput", hint: "phone.event.needsInputHint" },
  { key: "error", label: "phone.event.error", hint: "phone.event.errorHint" },
  { key: "proposal", label: "phone.event.proposal", hint: "phone.event.proposalHint" },
  { key: "missionDone", label: "phone.event.missionDone", hint: "phone.event.missionDoneHint" },
  { key: "done", label: "phone.event.done", hint: "phone.event.doneHint" },
];

const PRIORITIES: readonly MessageKey[] = ["phone.priority.min", "phone.priority.low", "phone.priority.default", "phone.priority.high", "phone.priority.max"];

const TOKEN_HINT: Record<PhoneAlertsView["tokenStorage"], MessageKey> = {
  credentialManager: "phone.token.hintCredentialManager",
  file: "phone.token.hintFile",
};

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString(intlLocale());

function statusLine(s: PhoneStatus, t: Translator): string {
  return [
    t("phone.status.sent", { count: s.sent }),
    s.failures > 0 ? t("phone.status.failed", { count: s.failures }) : null,
    s.suppressed > 0 ? t("phone.status.suppressed", { count: s.suppressed }) : null,
    s.pausedUntilMs ? t("phone.status.pausedUntil", { time: timeOf(s.pausedUntilMs) }) : null,
    s.failing && s.lastError ? t("phone.status.lastError", { error: s.lastError }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** QR code of the subscription link, drawn offline (lib/qrcode.ts). Hidden until asked: the topic is the secret. */
function SubscribeQr({ server, topic }: { server: string; topic: string }) {
  const t = useT();
  const [show, setShow] = useState(false);
  const [target, setTarget] = useState<"web" | "app">("web");
  const links = subscribeLinks(server, topic);
  const text = links[target];
  const qr = useMemo(() => (show ? encodeQr(text, "M") : null), [show, text]);
  const dim = qr ? qr.size + 8 : 0;
  return (
    <Field label={t("phone.qr.label")} hint={t("phone.qr.hint")}>
      {!show ? (
        <Button size="sm" onClick={() => setShow(true)}>
          {t("phone.qr.show")}
        </Button>
      ) : (
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
          {qr && (
            <svg width={176} height={176} viewBox={`0 0 ${dim} ${dim}`} role="img" aria-label={t("phone.qr.aria")} shapeRendering="crispEdges" style={{ background: "#fff", borderRadius: 4, flex: "none" }}>
              <path d={qrPath(qr)} fill="#000" />
            </svg>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, flex: 1 }}>
            <Segmented<"web" | "app">
              ariaLabel={t("phone.qr.targetAria")}
              size="sm"
              value={target}
              onChange={setTarget}
              options={[
                { value: "web", label: t("phone.qr.web"), title: t("phone.qr.webTitle") },
                { value: "app", label: t("phone.qr.app"), title: t("phone.qr.appTitle") },
              ]}
            />
            <span className="mono" style={{ wordBreak: "break-all", userSelect: "text" }}>
              {text}
            </span>
            <div style={{ display: "flex", gap: 8 }}>
              <Button size="sm" onClick={() => void navigator.clipboard?.writeText(text).catch(() => {})}>
                {t("phone.qr.copy")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShow(false)}>
                {t("phone.qr.hide")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Field>
  );
}

export function PhoneAlerts() {
  const t = useT();
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

  if (!view) return <p className="hint">{error ?? t("phone.loading")}</p>;
  const c = view.config;
  const save = (patch: Partial<PhoneConfig>) => run(() => ipc.phoneAlertsSet({ ...c, ...patch }));
  const serverHint = serverProblem(server);
  const publicServer = c.server === "https://ntfy.sh";

  return (
    <section className="notif-section">
      <div className="notif-section-head">
        <span className="micro-label">{t("phone.title")}</span>
        <span className="notif-section-hint">{t("phone.sectionHint")}</span>
      </div>
      <Toggle checked={c.enabled} disabled={busy} onChange={(enabled) => save({ enabled })} label={t("phone.enabled")} hint={t("phone.enabledHint")} />
      {error && (
        <p className="field-msg is-error" role="alert">
          {error}
        </p>
      )}
      <Field label={t("phone.server")} htmlFor="phone-server" warn={serverHint ?? undefined} hint={t(publicServer ? "phone.serverPublicHint" : "phone.serverOwnHint")}>
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
      <Field label={t("phone.topic")} htmlFor="phone-topic" warn={c.topic && weakTopic(c.topic) ? t("phone.topicWeak") : undefined} hint={t("phone.topicHint")}>
        <div style={{ display: "flex", gap: 8 }}>
          <Input id="phone-topic" mono readOnly value={c.topic} placeholder={t("phone.topicPlaceholder")} style={{ flex: 1 }} />
          <Button disabled={busy} onClick={() => run(() => ipc.phoneAlertsNewTopic())}>
            {t("phone.newTopic")}
          </Button>
        </div>
      </Field>
      {c.topic && <SubscribeQr server={c.server} topic={c.topic} />}
      <Field label={t("phone.token.label")} htmlFor="phone-token" hint={t(TOKEN_HINT[view.tokenStorage])}>
        {view.hasToken ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span>{t("phone.token.saved")}</span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(() => ipc.phoneAlertsSetToken(null))}>
              {t("common.remove")}
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
              {t("phone.token.save")}
            </Button>
          </div>
        )}
      </Field>

      <span className="micro-label">{t("phone.eventsTitle")}</span>
      {EVENTS.map((e) => (
        <Toggle
          key={e.key}
          checked={c.events[e.key]}
          disabled={busy}
          onChange={(v) => save({ events: { ...c.events, [e.key]: v } })}
          label={t("phone.event.withPriority", { label: t(e.label), priority: PHONE_PRIORITY[e.key] })}
          hint={t(e.hint)}
        />
      ))}
      <Field label={t("phone.minPriority")} htmlFor="phone-priority" hint={t("phone.minPriorityHint")}>
        <Select id="phone-priority" value={c.minPriority} disabled={busy} onChange={(e) => save({ minPriority: Number(e.currentTarget.value) })}>
          {PRIORITIES.map((p, i) => (
            <option key={p} value={i + 1}>
              {t(p)}
            </option>
          ))}
        </Select>
      </Field>
      <div className="quiet-hours">
        <Toggle
          checked={c.quietHours.enabled}
          disabled={busy}
          onChange={(enabled) => save({ quietHours: { ...c.quietHours, enabled } })}
          label={t("phone.quiet")}
          hint={t("phone.quietHint")}
        />
        <div className="quiet-times">
          {(["start", "end"] as const).map((k) => (
            <label key={k}>
              <span>{t(k === "start" ? "phone.quietFrom" : "phone.quietTo")}</span>
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
      <Toggle checked={c.includeNames} disabled={busy} onChange={(includeNames) => save({ includeNames })} label={t("phone.includeNames")} hint={t("phone.includeNamesHint")} />
      <Toggle
        checked={c.includeTaskNames}
        disabled={busy}
        onChange={(includeTaskNames) => save({ includeTaskNames })}
        label={t("phone.includeTaskNames")}
        hint={t("phone.includeTaskNamesHint")}
      />
      <Toggle
        checked={c.onlyWhenAway}
        disabled={busy}
        onChange={(onlyWhenAway) => save({ onlyWhenAway })}
        label={t("phone.onlyWhenAway")}
        hint={t("phone.onlyWhenAwayHint")}
      />

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <Button
          disabled={busy || !c.topic}
          onClick={async () => {
            setTest(t("phone.test.sending"));
            try {
              const r = await ipc.phoneAlertsTest();
              setTest(r.outcome === "sent" ? t("phone.test.sent") : (r.detail ?? r.outcome));
              apply(await ipc.phoneAlertsGet());
            } catch (e) {
              setTest(errorMessage(e));
            }
          }}
        >
          {t("phone.test.send")}
        </Button>
        {test && (
          <span className="hint" role="status">
            {test}
          </span>
        )}
      </div>
      <p className="hint">{statusLine(view.status, t)}</p>
    </section>
  );
}

/** Diagnostics: phone-alert delivery state, shown only when phone alerts are on or something failed. */
export function PhoneAlertsDiagnostics() {
  const t = useT();
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
      {s.failing && s.lastErrorMs
        ? t("phone.diagnosticsAt", { status: statusLine(s, t), time: timeOf(s.lastErrorMs) })
        : t("phone.diagnostics", { status: statusLine(s, t) })}
    </div>
  );
}
