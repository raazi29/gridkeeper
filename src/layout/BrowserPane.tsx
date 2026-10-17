// Browser pane: header + compact address bar + a host box the persistent iframe layer
// (browser/BrowserLayer) is laid over, and cards for the start page / pages that cannot be framed.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { forceFrame, goBack, goForward, navigate, openDevtools, openExternal, popOut, reload, runProbe, ensureNav } from "../actions/browser";
import { canGoBack, canGoForward, ownOrigin, useBrowserNav, viewOf } from "../browser/nav";
import { registerHost } from "../browser/frameHosts";
import { PortsList } from "../browser/PortsList";
import type { SessionId } from "../lib/types";
import { displayUrl, normalizeUrlInput, urlForPort } from "../lib/url";
import { useApp } from "../store/appStore";
import { PaneHeader } from "./PaneHeader";
import type { PaneProps } from "./Pane";
import { usePaneDrop } from "./Pane";
import { IconBack, IconCode, IconExternal, IconForward, IconPopout, IconRestart } from "./icons";

const DEVTOOLS = import.meta.env.DEV;

export const BrowserPane = memo(function BrowserPane({ sessionId, groupId, index, count, maximized }: PaneProps) {
  const focused = useApp((s) => s.focusedSessionId === sessionId);
  const { dropTarget, onDragOver, onDragLeave, onDrop } = usePaneDrop(sessionId, groupId);

  useEffect(() => ensureNav(sessionId), [sessionId]);

  const focus = useCallback(() => {
    if (useApp.getState().focusedSessionId !== sessionId) useApp.getState().setFocused(sessionId);
  }, [sessionId]);

  return (
    <div
      className="pane pane--browser"
      data-focused={focused || undefined}
      data-drop-target={dropTarget || undefined}
      onMouseDownCapture={focus}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <PaneHeader sessionId={sessionId} groupId={groupId} index={index} count={count} maximized={maximized} />
      <AddressBar sessionId={sessionId} />
      <div className="pane-body browser-body">
        <BrowserHost sessionId={sessionId} />
        <BrowserCards sessionId={sessionId} />
      </div>
      {dropTarget && <div className="pane-drop-indicator" />}
    </div>
  );
});

/** The box the iframe is laid over. */
function BrowserHost({ sessionId }: { sessionId: SessionId }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => (ref.current ? registerHost(sessionId, ref.current) : undefined), [sessionId]);
  return <div ref={ref} className="browser-host" />;
}

// ---- address bar ------------------------------------------------------------------------------

const AddressBar = memo(function AddressBar({ sessionId }: { sessionId: SessionId }) {
  const nav = useBrowserNav(
    useShallow((s) => {
      const n = s.panes[sessionId];
      return { url: n?.url ?? null, loading: !!n?.loading, back: canGoBack(n), fwd: canGoForward(n), popout: !!n?.popout };
    }),
  );
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const url = normalizeUrlInput(draft ?? "");
    if (!url) return;
    if (navigate(sessionId, url)) {
      setDraft(null);
      inputRef.current?.blur();
    }
  };
  const stop = (e: MouseEvent) => e.stopPropagation();
  const isHttp = !!nav.url && /^https?:/i.test(nav.url);

  return (
    <div className="browser-bar" onDoubleClick={stop}>
      <button type="button" className="pane-icon-btn" title="Back" aria-label="Back" disabled={!nav.back} onClick={() => goBack(sessionId)}>
        <IconBack />
      </button>
      <button type="button" className="pane-icon-btn" title="Forward" aria-label="Forward" disabled={!nav.fwd} onClick={() => goForward(sessionId)}>
        <IconForward />
      </button>
      <button type="button" className="pane-icon-btn" title="Reload" aria-label="Reload" disabled={!nav.url} onClick={() => reload(sessionId)}>
        <IconRestart />
      </button>
      <input
        ref={inputRef}
        className="browser-address mono"
        value={draft ?? displayUrl(nav.url)}
        placeholder="localhost:5173 or https://…"
        spellCheck={false}
        aria-label="Address"
        onFocus={(e) => {
          setDraft(nav.url ?? "");
          requestAnimationFrame(() => e.target.select());
        }}
        onBlur={() => setDraft(null)}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") submit();
          else if (e.key === "Escape") {
            setDraft(null);
            inputRef.current?.blur();
          }
        }}
      />
      <button type="button" className="pane-icon-btn" title="Open in system browser" aria-label="Open in system browser" disabled={!isHttp} onClick={() => openExternal(nav.url)}>
        <IconExternal />
      </button>
      <button type="button" className="pane-icon-btn" title="Open in a pop-out Gridkeeper window" aria-label="Pop out" disabled={!nav.url} onClick={() => void popOut(sessionId)}>
        <IconPopout />
      </button>
      {DEVTOOLS && (
        <button
          type="button"
          className="pane-icon-btn"
          title={nav.popout ? "DevTools (pop-out window)" : "DevTools: pop the page out first"}
          aria-label="DevTools"
          disabled={!nav.url}
          onClick={() => void openDevtools(sessionId)}
        >
          <IconCode />
        </button>
      )}
      {nav.loading && <span className="browser-loading" aria-label="Loading" />}
    </div>
  );
});

// ---- cards ------------------------------------------------------------------------------------

function hostName(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

const BrowserCards = memo(function BrowserCards({ sessionId }: { sessionId: SessionId }) {
  const n = useBrowserNav((s) => s.panes[sessionId]);
  const view = viewOf(n, ownOrigin());
  const url = n?.url ?? null;

  switch (view) {
    case "frame":
      return null;
    case "start":
      return <StartPage sessionId={sessionId} />;
    case "refused":
      return (
        <div className="pane-overlay browser-card">
          <div className="browser-card-title">{hostName(url)} does not allow being shown inside other apps</div>
          {n?.probe?.reason && <div className="browser-card-detail mono">{n.probe.reason}</div>}
          <div className="pane-overlay-actions">
            <button type="button" className="lay-btn lay-btn--primary" onClick={() => void popOut(sessionId)}>
              Open in Gridkeeper window
            </button>
            <button type="button" className="lay-btn lay-btn--ghost" onClick={() => openExternal(url)}>
              Open in browser
            </button>
            <button type="button" className="lay-btn lay-btn--ghost" onClick={() => forceFrame(sessionId)} title="Show the frame anyway (it will most likely stay blank)">
              Try anyway
            </button>
          </div>
        </div>
      );
    case "unreachable":
      return (
        <div className="pane-overlay browser-card">
          <div className="browser-card-title">Can’t reach {hostName(url)}</div>
          <div className="browser-card-detail">{n?.probe?.error ?? "No response"}</div>
          {n?.probing && <div className="browser-card-detail">Checking…</div>}
          <div className="pane-overlay-actions">
            <button type="button" className="lay-btn lay-btn--primary" onClick={() => url && void runProbe(sessionId, url)}>
              Retry
            </button>
            <button type="button" className="lay-btn lay-btn--ghost" onClick={() => forceFrame(sessionId)}>
              Show anyway
            </button>
          </div>
          <div className="browser-card-hint">Local dev servers are re-checked every few seconds for two minutes.</div>
        </div>
      );
    case "file":
      return (
        <div className="pane-overlay browser-card">
          <div className="browser-card-title">Local files open in a Gridkeeper window</div>
          <div className="browser-card-detail mono">{url}</div>
          <div className="pane-overlay-actions">
            <button type="button" className="lay-btn lay-btn--primary" onClick={() => void popOut(sessionId)}>
              Open window
            </button>
          </div>
          <div className="browser-card-hint">WebView2 does not show file: pages inside the app frame.</div>
        </div>
      );
    case "blocked":
      return (
        <div className="pane-overlay browser-card">
          <div className="browser-card-title">This address is Gridkeeper itself</div>
          <div className="browser-card-detail">It cannot be opened in a browser pane.</div>
        </div>
      );
    case "invalid":
      return (
        <div className="pane-overlay browser-card">
          <div className="browser-card-title">Unsupported address</div>
          <div className="browser-card-detail">Browser panes open http, https and file addresses.</div>
        </div>
      );
  }
});

function StartPage({ sessionId }: { sessionId: SessionId }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  const go = (raw: string | null) => {
    if (!raw) {
      setError(true);
      return;
    }
    navigate(sessionId, raw);
  };
  return (
    <div className="pane-overlay browser-start">
      <div className="browser-start-inner">
        <div className="browser-card-title">Open a page</div>
        <form
          className="browser-start-form"
          onSubmit={(e) => {
            e.preventDefault();
            go(normalizeUrlInput(value));
          }}
        >
          <input
            className={`browser-address browser-address--big mono${error ? " is-invalid" : ""}`}
            value={value}
            placeholder="localhost:5173, :3000, https://…"
            spellCheck={false}
            aria-label="Address"
            onChange={(e) => {
              setValue(e.target.value);
              setError(false);
            }}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <button type="submit" className="lay-btn lay-btn--primary">
            Open
          </button>
        </form>
        <div className="section-label">Dev servers started by your sessions</div>
        <PortsList onPick={(port) => go(urlForPort(port))} />
        <div className="browser-card-hint">
          Pages run sandboxed: no access to Gridkeeper or your sessions. Sites that refuse embedding open in a pop-out window.
        </div>
      </div>
    </div>
  );
}
