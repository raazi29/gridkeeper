// "Broadcast": type one line and send it to several live sessions. Default targets = the live sessions
// of the active group. Sending to more than 3 sessions or into another workspace asks for confirmation.
// Never sends on its own: only the Send button / Enter in the input does.

import { useMemo, useState } from "react";
import {
  AGENT_FILTERS_ORDER,
  broadcastCandidates,
  confirmationReason,
  defaultBroadcastTargets,
  filterByAgent,
  resolveTargets,
  sendBroadcast,
  type AgentFilter,
} from "../actions/broadcast";
import { notify } from "../actions/notify";
import { AgentGlyph } from "../layout/icons";
import type { SessionId } from "../lib/types";
import { selectActiveGroup, useApp } from "../store/appStore";
import { useAttentionUi } from "../store/attention";
import { confirmDialog } from "../store/uiStore";
import { IconBroadcast } from "./AttentionBits";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { AGENT_LABEL } from "./util/session";
import "../styles/attention.css";

export function BroadcastDialog() {
  const close = () => useAttentionUi.getState().close();
  // Snapshot of live sessions when the composer opens (refreshes on state events).
  const runtime = useApp((s) => s.runtime);
  const persisted = useApp((s) => s.persisted);
  const candidates = useMemo(() => broadcastCandidates({ persisted, runtime }), [persisted, runtime]);
  const [selected, setSelected] = useState<Set<SessionId>>(
    () =>
      new Set(
        useAttentionUi.getState().broadcastPreselect ??
          defaultBroadcastTargets(broadcastCandidates(useApp.getState()), selectActiveGroup(useApp.getState())?.id),
      ),
  );
  const [agent, setAgent] = useState<AgentFilter>("all");
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);

  const shown = filterByAgent(candidates, agent);
  const targets = resolveTargets(candidates, selected);
  const agentsPresent = AGENT_FILTERS_ORDER.filter((a) => a === "all" || candidates.some((c) => c.agent === a));

  const toggle = (id: SessionId) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const setMany = (ids: SessionId[], on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const send = async () => {
    if (busy || !line.trim() || targets.length === 0) return;
    const reason = confirmationReason(targets, useApp.getState().persisted.activeWorkspaceId);
    if (reason) {
      const ok = await confirmDialog({
        title: `Send to ${targets.length} session${targets.length === 1 ? "" : "s"}?`,
        message: `This line will be typed into each session and submitted with Enter (${reason}).`,
        detail: `${line}\n\n→ ${targets.map((t) => `${t.name} (${t.workspaceName})`).join(", ")}`,
        confirmLabel: "Send",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    const { sent, failed } = await sendBroadcast(line, targets);
    setBusy(false);
    if (failed.length) notify("error", `Broadcast failed for ${failed.join(", ")}`);
    if (sent) {
      notify("info", `Sent to ${sent} session${sent === 1 ? "" : "s"}`);
      close();
    }
  };

  // Group the visible candidates by workspace.
  const byWs: { ws: string; items: typeof shown }[] = [];
  for (const c of shown) {
    const last = byWs[byWs.length - 1];
    if (last && last.ws === c.workspaceId) last.items.push(c);
    else byWs.push({ ws: c.workspaceId, items: [c] });
  }

  return (
    <Modal
      title={
        <span className="attn-title-with-icon">
          <IconBroadcast size={15} /> Broadcast
        </span>
      }
      ariaLabel="Broadcast"
      onClose={close}
      width={560}
      className="attn-broadcast"
      footer={
        <>
          <span className="attn-broadcast-summary">
            {targets.length} of {candidates.length} live session{candidates.length === 1 ? "" : "s"} selected
          </span>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={busy || !line.trim() || targets.length === 0} onClick={() => void send()}>
            {busy ? "Sending…" : `Send to ${targets.length}`}
          </Button>
        </>
      }
    >
      <div className="form">
        <input
          className="input mono"
          data-autofocus
          placeholder="Line to send (Enter is added)"
          value={line}
          spellCheck={false}
          onChange={(e) => setLine(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="attn-broadcast-tools">
          <div className="segmented segmented-sm" role="radiogroup" aria-label="Agent filter">
            {agentsPresent.map((a) => (
              <button key={a} type="button" role="radio" aria-checked={agent === a} className={`segment${agent === a ? " is-selected" : ""}`} onClick={() => setAgent(a)}>
                {a === "all" ? "All" : AGENT_LABEL[a]}
              </button>
            ))}
          </div>
          <span className="attn-spacer" />
          <button type="button" className="chip" onClick={() => setMany(shown.map((c) => c.id), true)}>
            Select shown
          </button>
          <button type="button" className="chip" onClick={() => setMany(shown.map((c) => c.id), false)}>
            Clear shown
          </button>
        </div>
        <div className="attn-broadcast-list">
          {candidates.length === 0 && <div className="attn-empty">No live sessions.</div>}
          {byWs.map((g) => (
            <div key={g.ws} className="attn-broadcast-ws">
              <div className="attn-broadcast-wsname">{g.items[0].workspaceName}</div>
              {g.items.map((c) => (
                <label key={c.id} className="check attn-broadcast-item">
                  <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                  <AgentGlyph agent={c.agent} size={12} />
                  <span className="attn-broadcast-name">{c.name}</span>
                  <span className="attn-broadcast-group">{c.groupName}</span>
                </label>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
