// "Agent browser" view: every opted-in agent's tab, live (grid of small screencasts, or one large
// with take-over), the shared browser's status, the per-agent action log and the allowlist; plus the
// floating confirmation prompts, which show even when the view is closed (a tool call is waiting).

import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { AgentBrowserActivity, AgentBrowserPrompt, AgentBrowserSession, SessionId } from "../../lib/types";
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

export function AgentBrowserLayer() {
  const open = useAgentBrowser((s) => s.open);
  useEffect(() => installAgentBrowserWatch(), []);
  return (
    <>
      <ErrorBoundary key={open ? "open" : "closed"} scope="Agent browser">
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

const INJECTION_NOTE =
  "Web pages can contain prompt injections: text on a page may try to give the agent instructions. Watch what it does, keep personal logins out of this browser, and never give an agent credentials it does not need.";

function AgentBrowserView() {
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
          Agent browser
          <span className="ab-title-sub">one shared browser, a tab per agent</span>
        </span>
      }
      headerExtra={<BrowserStatus />}
      ariaLabel="Agent browser"
      onClose={closeAgentBrowser}
      width={1220}
      className="ab-modal"
    >
      <div className="ab-note" role="note">
        <IconWarn size={13} />
        <span>{INJECTION_NOTE}</span>
      </div>
      {sessions.length === 0 ? (
        <EmptyState />
      ) : mode === "focus" && sel ? (
        <FocusView row={sel} name={names[sel.sessionId]?.name ?? "session"} live={!!names[sel.sessionId]?.live} />
      ) : (
        <GridView rows={sessions} names={names} />
      )}
      <Settings />
    </Modal>
  );
}

function BrowserStatus() {
  const st = useAgentBrowser((s) => s.state);
  if (!st) return null;
  return (
    <span className="ab-status">
      {st.running ? (
        <>
          <span className="ab-dot is-on" aria-hidden />
          <span className="ab-status-text" title={st.executable ?? undefined}>
            {st.browser ?? "browser"} · pid {st.pid}
          </span>
          <Button size="sm" variant="ghost" onClick={() => void stopBrowser()} title="Close the shared browser now; tabs reopen at their last page on the next tool call">
            Close browser
          </Button>
        </>
      ) : (
        <>
          <span className="ab-dot" aria-hidden />
          <span className="ab-status-text" title={st.executable ?? undefined}>
            {st.executable ? `not running (starts on the first tool call, stops after ${st.idleMinutes} idle min)` : "no Edge / Chrome / Chromium found"}
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
  return (
    <div className="ab-empty">
      <p>
        No agent has a browser yet. Tick <b>Give this agent a browser</b> in the New session dialog, or use the session menu ›{" "}
        <b>Agent browser</b> on a Claude Code or Codex pane and restart it.
      </p>
      <p>
        The agent then gets browser tools (navigate, snapshot, click, type, console and network errors, screenshots) for its own tab in one shared, headless
        Edge / Chrome with a separate profile. You watch the tab here and can take it over at any time.
      </p>
    </div>
  );
}

function statusBits(row: AgentBrowserSession, live: boolean): { text: string; cls: string }[] {
  const bits: { text: string; cls: string }[] = [];
  if (row.stopped) bits.push({ text: "stopped", cls: "is-err" });
  if (row.takenOver) bits.push({ text: "you control it", cls: "is-accent" });
  if (row.dialog) bits.push({ text: "dialog open", cls: "is-warn" });
  if (row.busy && !row.takenOver) bits.push({ text: "working", cls: "is-ok" });
  if (!live) bits.push({ text: "not running", cls: "" });
  else if (!row.launched) bits.push({ text: row.enabled ? "restart to apply" : "no tools in this run", cls: "is-warn" });
  else if (!row.connected) bits.push({ text: "tools not connected", cls: "" });
  if (needsRestart(row, live) && row.launched) bits.push({ text: "restart to apply", cls: "is-warn" });
  return bits;
}

function Bits({ row, live }: { row: AgentBrowserSession; live: boolean }) {
  return (
    <span className="ab-bits">
      {statusBits(row, live).map((b) => (
        <span key={b.text} className={`ab-bit ${b.cls}`}>
          {b.text}
        </span>
      ))}
    </span>
  );
}

function GridView({ rows, names }: { rows: AgentBrowserSession[]; names: Record<SessionId, { name: string; live: boolean }> }) {
  return (
    <div className="ab-grid">
      {rows.map((r) => {
        const n = names[r.sessionId];
        const name = n?.name ?? "session";
        return (
          <button key={r.sessionId} type="button" className="ab-tile" onClick={() => focusSession(r.sessionId)} title={`Open ${name}'s tab`}>
            <span className="ab-tile-head">
              <span className="ab-tile-name">{name}</span>
              <Bits row={r} live={!!n?.live} />
            </span>
            {r.hasTab ? (
              <ScreencastView sessionId={r.sessionId} maxWidth={480} maxHeight={300} label={name} className="ab-tile-screen" />
            ) : (
              <span className="ab-tile-empty">{r.launchNote ?? (r.launched ? "No tab yet (opens on the agent's first browser tool call)" : "The browser tools apply when the agent starts")}</span>
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
  const log = useAgentBrowser((s) => s.log[row.sessionId]);
  const [text, setText] = useState("");
  return (
    <div className="ab-focus">
      <div className="ab-focus-bar">
        <Button size="sm" variant="ghost" icon={<IconGrid size={13} />} onClick={showGrid}>
          All tabs
        </Button>
        <span className="ab-focus-name">{name}</span>
        <Bits row={row} live={live} />
        <span className="ab-spacer" />
        <Button
          size="sm"
          variant={row.takenOver ? "primary" : "default"}
          disabled={!row.hasTab || row.stopped}
          onClick={() => void takeOver(row.sessionId, !row.takenOver)}
          title={row.takenOver ? "Give the tab back to the agent (its waiting calls continue)" : "Control the tab yourself; the agent's browser calls wait until you hand it back"}
        >
          {row.takenOver ? "Hand back to agent" : "Take over"}
        </Button>
        <Button
          size="sm"
          variant={row.stopped ? "default" : "danger"}
          onClick={() => void setStopped(row.sessionId, !row.stopped)}
          title={row.stopped ? "Let the agent use its browser tools again" : "Close the agent's tab and refuse its browser calls until you allow them again or it restarts"}
        >
          {row.stopped ? "Allow browsing" : "Stop agent browsing"}
        </Button>
      </div>
      <div className="ab-url" title={row.url ?? undefined}>
        {row.title && <span className="ab-url-title">{row.title}</span>}
        <span className="mono">{row.url ?? "no page yet"}</span>
      </div>
      {row.dialog && <div className="ab-dialog">JavaScript dialog: {row.dialog} (the agent answers it with browser_handle_dialog)</div>}
      <div className="ab-focus-cols">
        <div className="ab-focus-main">
          {row.hasTab ? (
            <ScreencastView sessionId={row.sessionId} maxWidth={1280} maxHeight={800} interactive={row.takenOver} label={name} className="ab-focus-screen" />
          ) : (
            <div className="ab-screen ab-focus-screen">
              <div className="ab-screen-empty">{row.stopped ? "Browsing is stopped for this agent." : (row.launchNote ?? "No tab yet: it opens on the agent's first browser tool call.")}</div>
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
              <input className="input mono" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type or paste text into the focused field, then Enter" aria-label="Text to insert into the page" />
              <span className="ab-type-hint">Click the page to focus it; keys and the mouse go to the page while you control it.</span>
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
  return (
    <div className="ab-log" aria-label="Browser actions">
      <div className="ab-log-head">Actions (this run)</div>
      {log.length === 0 ? (
        <div className="ab-log-empty">Nothing yet.</div>
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
  const st = useAgentBrowser((s) => s.state);
  const saved = (st?.allowlist ?? []).join("\n");
  const [draft, setDraft] = useState<string | null>(null);
  const [idle, setIdle] = useState<string | null>(null);
  const value = draft ?? saved;
  const dirty = draft !== null && draft !== saved;
  return (
    <details className="ab-settings">
      <summary>Allowlist and idle timeout</summary>
      <div className="ab-settings-body">
        <label className="ab-settings-field">
          <span>
            Hosts where agents may submit forms and run scripts without asking (one per line: <span className="mono">host</span>,{" "}
            <span className="mono">host:port</span> or <span className="mono">*.domain</span>). Always allowed: localhost, 127.0.0.1, ::1, and this machine's
            private addresses on a port a session's dev server listens on. Uploads and downloads always ask.
          </span>
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
            Save allowlist
          </Button>
          <label className="ab-idle">
            Close the browser after
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
            minutes without a tool call
          </label>
        </div>
      </div>
    </details>
  );
}

// ---- confirmations ---------------------------------------------------------------------------

const KIND_TITLE: Record<AgentBrowserPrompt["kind"], string> = {
  formSubmit: "submit a form",
  script: "run a script",
  upload: "upload files",
  download: "keep a download",
};

function PromptStack() {
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
    <div className="ab-prompts" role="region" aria-label="Agent browser questions">
      {prompts.map((p) => {
        const name = names[p.sessionId]?.name ?? "An agent";
        const left = Math.max(0, Math.round((p.expiresMs - now) / 1000));
        return (
          <div key={p.id} className="ab-prompt" role="alertdialog" aria-label={`${name} wants to ${KIND_TITLE[p.kind]}`}>
            <div className="ab-prompt-head">
              <IconWarn size={13} />
              <b>{name}</b>
              <span>wants to {KIND_TITLE[p.kind]}</span>
              {p.origin && <span className="mono ab-prompt-origin">{p.origin}</span>}
              <span className="ab-spacer" />
              <span className="ab-prompt-left" title="Counts as No when it runs out">
                {left}s
              </span>
            </div>
            <pre className="ab-prompt-detail">{p.detail}</pre>
            <div className="ab-prompt-actions">
              <Button size="sm" variant="primary" onClick={() => void answerPrompt(p.id, true)}>
                Allow once
              </Button>
              {p.rememberHost && (
                <Button size="sm" onClick={() => void answerPrompt(p.id, true, true)} title={`Add ${p.rememberHost} to the allowlist`}>
                  Always allow {p.rememberHost}
                </Button>
              )}
              <Button size="sm" variant="danger" onClick={() => void answerPrompt(p.id, false)}>
                Deny
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
