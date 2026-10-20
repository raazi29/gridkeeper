// "Agent browser" view: every opted-in agent's tab, live (grid of small screencasts, or one large
// with take-over), the shared browser's status, the per-agent action log and the allowlist; plus the
// floating confirmation prompts, which show even when the view is closed (a tool call is waiting).

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AgentBrowserActivity, AgentBrowserSession, SessionId } from "../../lib/types";
import { useT, type Translator } from "../../i18n";
import { isLive, useApp } from "../../store/appStore";
import { ErrorBoundary } from "../ErrorBoundary";
import { IconGrid, IconWarn } from "../icons";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { shortUrl } from "./frames";
import { ScreencastView } from "./ScreencastView";
import {
  answerPrompt,
  closeAgentBrowser,
  focusSession,
  installAgentBrowserWatch,
  needsRestart,
  saveAllowlist,
  saveIdleMinutes,
  sendInput,
  setStopped,
  showGrid,
  stopBrowser,
  takeOver,
  useAgentBrowser,
} from "./store";
import "./agentBrowser.css";

const bold = (c: ReactNode) => <b>{c}</b>;
const mono = (c: ReactNode) => <span className="mono">{c}</span>;

export function AgentBrowserLayer() {
  const t = useT();
  const open = useAgentBrowser((s) => s.open);
  useEffect(() => installAgentBrowserWatch(), []);
  return (
    <>
      <ErrorBoundary key={open ? "open" : "closed"} scope={t("agentBrowser.title")}>
        {open && <AgentBrowserView />}
      </ErrorBoundary>
      <PromptStack />
    </>
  );
}

function useNames(): Record<SessionId, { name: string; live: boolean }> {
  const rows = useApp(useShallow((s) => s.persisted.sessions.map((m) => `${m.id}\u0000${m.name}\u0000${isLive(s.runtime[m.id]) ? 1 : 0}`)));
  return useMemo(() => {
    const out: Record<SessionId, { name: string; live: boolean }> = {};
    for (const r of rows) {
      const [id, name, live] = r.split("\u0000");
      out[id] = { name, live: live === "1" };
    }
    return out;
  }, [rows]);
}

function AgentBrowserView() {
  const t = useT();
  const st = useAgentBrowser((s) => s.state);
  const mode = useAgentBrowser((s) => s.mode);
  const selected = useAgentBrowser((s) => s.selected);
  const names = useNames();
  const sessions = st?.sessions ?? [];
  const sel = sessions.find((s) => s.sessionId === selected) ?? null;

  return (
    <Modal
      title={
        <span className="ab-title">
          {t("agentBrowser.title")}
          <span className="ab-title-sub">{t("agentBrowser.subtitle")}</span>
        </span>
      }
      headerExtra={<BrowserStatus />}
      ariaLabel={t("agentBrowser.title")}
      onClose={closeAgentBrowser}
      width={1220}
      className="ab-modal"
    >
      <div className="ab-note" role="note">
        <IconWarn size={13} />
        <span>{t("agentBrowser.injectionNote")}</span>
      </div>
      {sessions.length === 0 ? (
        <EmptyState />
      ) : mode === "focus" && sel ? (
        <FocusView row={sel} name={names[sel.sessionId]?.name ?? t("command.sessionFallbackName")} live={!!names[sel.sessionId]?.live} />
      ) : (
        <GridView rows={sessions} names={names} />
      )}
      <Settings />
    </Modal>
  );
}

function BrowserStatus() {
  const t = useT();
  const st = useAgentBrowser((s) => s.state);
  if (!st) return null;
  return (
    <span className="ab-status">
      {st.running ? (
        <>
          <span className="ab-dot is-on" aria-hidden />
          <span className="ab-status-text" title={st.executable ?? undefined}>
            {t("agentBrowser.status.running", { browser: st.browser ?? t("agentBrowser.status.browserFallback"), pid: st.pid })}
          </span>
          <Button size="sm" variant="ghost" onClick={() => void stopBrowser()} title={t("agentBrowser.status.closeTitle")}>
            {t("agentBrowser.status.close")}
          </Button>
        </>
      ) : (
        <>
          <span className="ab-dot" aria-hidden />
          <span className="ab-status-text" title={st.executable ?? undefined}>
            {st.executable ? t("agentBrowser.status.notRunning", { minutes: st.idleMinutes }) : t("agentBrowser.status.noBrowser")}
          </span>
        </>
      )}
      {st.error && (
        <span className="ab-status-err" title={st.error}>
          {st.error}
        </span>
      )}
    </span>
  );
}

function EmptyState() {
  const t = useT();
  return (
    <div className="ab-empty">
      <p>{t.rich("agentBrowser.empty.intro", { b: bold })}</p>
      <p>{t("agentBrowser.empty.detail")}</p>
    </div>
  );
}

function statusBits(row: AgentBrowserSession, live: boolean, t: Translator): { text: string; cls: string }[] {
  const bits: { text: string; cls: string }[] = [];
  if (row.stopped) bits.push({ text: t("agentBrowser.bit.stopped"), cls: "is-err" });
  if (row.takenOver) bits.push({ text: t("agentBrowser.bit.youControl"), cls: "is-accent" });
  if (row.dialog) bits.push({ text: t("agentBrowser.bit.dialogOpen"), cls: "is-warn" });
  if (row.busy && !row.takenOver) bits.push({ text: t("agentBrowser.bit.working"), cls: "is-ok" });
  if (!live) bits.push({ text: t("agentBrowser.bit.notRunning"), cls: "" });
  else if (!row.launched) bits.push({ text: row.enabled ? t("agentBrowser.bit.restartToApply") : t("agentBrowser.bit.noTools"), cls: "is-warn" });
  else if (!row.connected) bits.push({ text: t("agentBrowser.bit.toolsNotConnected"), cls: "" });
  if (needsRestart(row, live) && row.launched) bits.push({ text: t("agentBrowser.bit.restartToApply"), cls: "is-warn" });
  return bits;
}

function Bits({ row, live }: { row: AgentBrowserSession; live: boolean }) {
  const t = useT();
  return (
    <span className="ab-bits">
      {statusBits(row, live, t).map((b) => (
        <span key={b.text} className={`ab-bit ${b.cls}`}>
          {b.text}
        </span>
      ))}
    </span>
  );
}

function GridView({ rows, names }: { rows: AgentBrowserSession[]; names: Record<SessionId, { name: string; live: boolean }> }) {
  const t = useT();
  return (
    <div className="ab-grid">
      {rows.map((r) => {
        const n = names[r.sessionId];
        const name = n?.name ?? t("command.sessionFallbackName");
        return (
          <button key={r.sessionId} type="button" className="ab-tile" onClick={() => focusSession(r.sessionId)} title={t("agentBrowser.tile.openTitle", { name })}>
            <span className="ab-tile-head">
              <span className="ab-tile-name">{name}</span>
              <Bits row={r} live={!!n?.live} />
            </span>
            {r.hasTab ? (
              <ScreencastView sessionId={r.sessionId} maxWidth={480} maxHeight={300} label={name} className="ab-tile-screen" />
            ) : (
              <span className="ab-tile-empty">{r.launchNote ?? (r.launched ? t("agentBrowser.tile.noTabYet") : t("agentBrowser.tile.appliesAtStart"))}</span>
            )}
            <span className="ab-tile-url" title={r.url ?? undefined}>
              {r.title ? `${r.title} · ` : ""}
              {shortUrl(r.url) || "—"}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FocusView({ row, name, live }: { row: AgentBrowserSession; name: string; live: boolean }) {
  const t = useT();
  const log = useAgentBrowser((s) => s.log[row.sessionId]);
  const [text, setText] = useState("");
  return (
    <div className="ab-focus">
      <div className="ab-focus-bar">
        <Button size="sm" variant="ghost" icon={<IconGrid size={13} />} onClick={showGrid}>
          {t("agentBrowser.focus.allTabs")}
        </Button>
        <span className="ab-focus-name">{name}</span>
        <Bits row={row} live={live} />
        <span className="ab-spacer" />
        <Button
          size="sm"
          variant={row.takenOver ? "primary" : "default"}
          disabled={!row.hasTab || row.stopped}
          onClick={() => void takeOver(row.sessionId, !row.takenOver)}
          title={row.takenOver ? t("agentBrowser.focus.handBackTitle") : t("agentBrowser.focus.takeOverTitle")}
        >
          {row.takenOver ? t("agentBrowser.focus.handBack") : t("agentBrowser.focus.takeOver")}
        </Button>
        <Button
          size="sm"
          variant={row.stopped ? "default" : "danger"}
          onClick={() => void setStopped(row.sessionId, !row.stopped)}
          title={row.stopped ? t("agentBrowser.focus.allowTitle") : t("agentBrowser.focus.stopTitle")}
        >
          {row.stopped ? t("agentBrowser.focus.allow") : t("agentBrowser.focus.stop")}
        </Button>
      </div>
      <div className="ab-url" title={row.url ?? undefined}>
        {row.title && <span className="ab-url-title">{row.title}</span>}
        <span className="mono">{row.url ?? t("agentBrowser.focus.noPage")}</span>
      </div>
      {row.dialog && <div className="ab-dialog">{t("agentBrowser.focus.dialog", { message: row.dialog })}</div>}
      <div className="ab-focus-cols">
        <div className="ab-focus-main">
          {row.hasTab ? (
            <ScreencastView sessionId={row.sessionId} maxWidth={1280} maxHeight={800} interactive={row.takenOver} label={name} className="ab-focus-screen" />
          ) : (
            <div className="ab-screen ab-focus-screen">
              <div className="ab-screen-empty">{row.stopped ? t("agentBrowser.focus.stopped") : (row.launchNote ?? t("agentBrowser.focus.noTabYet"))}</div>
            </div>
          )}
          {row.takenOver && (
            <form
              className="ab-type"
              onSubmit={(e) => {
                e.preventDefault();
                if (!text) return;
                void sendInput(row.sessionId, { type: "text", text });
                setText("");
              }}
            >
              <input className="input mono" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("agentBrowser.focus.typePlaceholder")} aria-label={t("agentBrowser.focus.typeLabel")} />
              <span className="ab-type-hint">{t("agentBrowser.focus.typeHint")}</span>
            </form>
          )}
        </div>
        <ActionLog log={log ?? []} />
      </div>
    </div>
  );
}

function timeOf(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function ActionLog({ log }: { log: AgentBrowserActivity[] }) {
  const t = useT();
  return (
    <div className="ab-log" aria-label={t("agentBrowser.log.label")}>
      <div className="ab-log-head">{t("agentBrowser.log.title")}</div>
      {log.length === 0 ? (
        <div className="ab-log-empty">{t("agentBrowser.log.empty")}</div>
      ) : (
        <ol className="ab-log-list">
          {[...log].reverse().map((e, i) => (
            <li key={`${e.atMs}-${i}`} className={`ab-log-row is-${e.outcome}`} title={e.url ?? undefined}>
              <span className="ab-log-time">{timeOf(e.atMs)}</span>
              <span className="ab-log-text">{e.summary}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Settings() {
  const t = useT();
  const st = useAgentBrowser((s) => s.state);
  const saved = (st?.allowlist ?? []).join("\n");
  const [draft, setDraft] = useState<string | null>(null);
  const [idle, setIdle] = useState<string | null>(null);
  const value = draft ?? saved;
  const dirty = draft !== null && draft !== saved;
  return (
    <details className="ab-settings">
      <summary>{t("agentBrowser.settings.title")}</summary>
      <div className="ab-settings-body">
        <label className="ab-settings-field">
          <span>{t.rich("agentBrowser.settings.allowlistHelp", { mono })}</span>
          <textarea className="input mono ab-allow" rows={4} value={value} onChange={(e) => setDraft(e.target.value)} placeholder="staging.example.com" spellCheck={false} />
        </label>
        <div className="ab-settings-row">
          <Button
            size="sm"
            variant="primary"
            disabled={!dirty}
            onClick={() => {
              void saveAllowlist(value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
              setDraft(null);
            }}
          >
            {t("agentBrowser.settings.save")}
          </Button>
          <label className="ab-idle">
            {t.rich("agentBrowser.settings.idle", {
              input: (
                <input
                  className="input mono"
                  type="number"
                  min={1}
                  max={240}
                  value={idle ?? String(st?.idleMinutes ?? 10)}
                  onChange={(e) => setIdle(e.target.value)}
                  onBlur={() => {
                    const n = Math.round(Number(idle));
                    if (idle !== null && n >= 1 && n <= 240 && n !== st?.idleMinutes) void saveIdleMinutes(n);
                    setIdle(null);
                  }}
                />
              ),
            })}
          </label>
        </div>
      </div>
    </details>
  );
}

// ---- confirmations ---------------------------------------------------------------------------

function PromptStack() {
  const t = useT();
  const prompts = useAgentBrowser((s) => s.state?.prompts);
  const names = useNames();
  const [now, setNow] = useState(() => Date.now());
  const count = prompts?.length ?? 0;
  useEffect(() => {
    if (!count) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [count]);
  if (!prompts || prompts.length === 0) return null;
  return (
    <div className="ab-prompts" role="region" aria-label={t("agentBrowser.prompt.region")}>
      {prompts.map((p) => {
        const name = names[p.sessionId]?.name ?? t("agentBrowser.prompt.anAgent");
        const left = Math.max(0, Math.round((p.expiresMs - now) / 1000));
        return (
          <div key={p.id} className="ab-prompt" role="alertdialog" aria-label={t("agentBrowser.prompt.aria", { name, kind: p.kind })}>
            <div className="ab-prompt-head">
              <IconWarn size={13} />
              <b>{name}</b>
              <span>{t("agentBrowser.prompt.wantsTo", { kind: p.kind })}</span>
              {p.origin && <span className="mono ab-prompt-origin">{p.origin}</span>}
              <span className="ab-spacer" />
              <span className="ab-prompt-left" title={t("agentBrowser.prompt.leftTitle")}>
                {t("agentBrowser.prompt.secondsLeft", { seconds: left })}
              </span>
            </div>
            <pre className="ab-prompt-detail">{p.detail}</pre>
            <div className="ab-prompt-actions">
              <Button size="sm" variant="primary" onClick={() => void answerPrompt(p.id, true)}>
                {t("agentBrowser.prompt.allowOnce")}
              </Button>
              {p.rememberHost && (
                <Button size="sm" onClick={() => void answerPrompt(p.id, true, true)} title={t("agentBrowser.prompt.alwaysAllowTitle", { host: p.rememberHost })}>
                  {t("agentBrowser.prompt.alwaysAllow", { host: p.rememberHost })}
                </Button>
              )}
              <Button size="sm" variant="danger" onClick={() => void answerPrompt(p.id, false)}>
                {t("agentBrowser.prompt.deny")}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
