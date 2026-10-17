// Listening ports of running sessions, as one-click "open in a browser pane" rows.
// Holds the ports poll while mounted (start page, Open URL dialog, Inspector) — nowhere else.

import { useShallow } from "zustand/react/shallow";
import { openPort } from "../actions/browser";
import type { SessionId } from "../lib/types";
import { useApp } from "../store/appStore";
import { refreshPorts, usePorts, usePortsPoll } from "../store/ports";
import { IconRestart } from "../components/icons";

export interface PortsListProps {
  /** Only this session's ports (Inspector). */
  sessionId?: SessionId;
  /** Instead of opening a pane next to the session (e.g. navigate the start page). */
  onPick?: (port: number) => void;
  emptyText?: string;
  compact?: boolean;
}

export function PortsList({ sessionId, onPick, emptyText = "No session is listening on a TCP port yet.", compact }: PortsListProps) {
  usePortsPoll(true);
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
          <span>{error ? `Ports unavailable: ${error}` : emptyText}</span>
          <button type="button" className="link-btn" onClick={() => void refreshPorts()} title="Check again">
            <IconRestart size={11} /> Refresh
          </button>
        </div>
      ) : (
        rows.map((r) => (
          <button
            key={`${r.id}:${r.port}`}
            type="button"
            className="ports-row"
            title={`pid ${r.pid} · ${r.addresses.join(", ")}\nOpen http://localhost:${r.port} in a browser pane`}
            onClick={() => (onPick ? onPick(r.port) : openPort(r.id, r.port))}
          >
            <span className="ports-port mono">:{r.port}</span>
            {!sessionId && <span className="ports-name">{names[r.id] ?? r.id}</span>}
            <span className="ports-open">Open</span>
          </button>
        ))
      )}
    </div>
  );
}
