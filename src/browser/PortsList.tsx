// Listening ports of running sessions, as one-click "open in a browser pane" rows.
// Holds the ports poll while mounted (start page, Open URL dialog, Inspector) — nowhere else.

import { useShallow } from "zustand/react/shallow";
import { openPort } from "../actions/browser";
import type { SessionId } from "../lib/types";
import { useApp } from "../store/appStore";
import { refreshPorts, usePorts, usePortsPoll } from "../store/ports";
import { IconRestart } from "../components/icons";
import { useT } from "../i18n";

export interface PortsListProps {
  /** Only this session's ports (Inspector). */
  sessionId?: SessionId;
  /** Instead of opening a pane next to the session (e.g. navigate the start page). */
  onPick?: (port: number) => void;
  /** Shown when no port is listening (default: a generic line). */
  emptyText?: string;
  compact?: boolean;
  /** Hold the 3 s ports poll (default true). False while the list is mounted but off screen. */
  poll?: boolean;
}

export function PortsList({ sessionId, onPick, emptyText, compact, poll = true }: PortsListProps) {
  const t = useT();
  usePortsPoll(poll);
  const bySession = usePorts((s) => s.bySession);
  const error = usePorts((s) => s.error);
  const names = useApp(useShallow((s) => Object.fromEntries(s.persisted.sessions.map((m) => [m.id, m.name]))));
  const rows = Object.entries(bySession)
    .filter(([id]) => (sessionId ? id === sessionId : id in names))
    .flatMap(([id, ports]) => ports.map((p) => ({ id, ...p })));

  return (
    <div className={`ports-list${compact ? " is-compact" : ""}`}>
      {rows.length === 0 ? (
        <div className="ports-empty">
          <span>{error ? t("browser.ports.unavailable", { error }) : (emptyText ?? t("browser.ports.empty"))}</span>
          <button type="button" className="link-btn" onClick={() => void refreshPorts()} title={t("browser.ports.checkAgain")}>
            <IconRestart size={11} /> {t("common.refresh")}
          </button>
        </div>
      ) : (
        rows.map((r) => (
          <button
            key={`${r.id}:${r.port}`}
            type="button"
            className="ports-row"
            title={t("browser.ports.rowTitle", { pid: r.pid, addresses: r.addresses.join(", "), port: r.port })}
            onClick={() => (onPick ? onPick(r.port) : openPort(r.id, r.port))}
          >
            <span className="ports-port mono">:{r.port}</span>
            {!sessionId && <span className="ports-name">{names[r.id] ?? r.id}</span>}
            <span className="ports-open">{t("common.open")}</span>
          </button>
        ))
      )}
    </div>
  );
}
