// Confirmed message to the agent that owns a branch: "ask the agent to fix" (failed tests) and "hand to
// the agent" (merge conflicts). Same rules as a hand-off: an editable one-line message, nothing typed
// until Send, refused while the agent is asking something.

import { useState } from "react";
import { isMac } from "../../lib/platform";
import { isLive, useApp } from "../../store/appStore";
import { useAttention } from "../../store/attention";
import { closeAskAgent, sendToAgent, type AskAgentRequest } from "../../store/testrun";
import { notify } from "../../actions/notify";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import "../../styles/signoff.css";

export function AskAgentDialog({ req }: { req: AskAgentRequest }) {
  const [text, setText] = useState(req.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useApp((s) => s.persisted.sessions.find((m) => m.id === req.sessionId)?.name ?? "the session");
  const live = useApp((s) => isLive(s.runtime[req.sessionId]));
  const waiting = useAttention((s) => s.sessions[req.sessionId]?.state === "waiting");
  const blocked = !live ? `${name} is not running.` : waiting ? `${name} is waiting for an answer. Sending would press Enter on its prompt; answer it in its pane first.` : null;

  const send = async () => {
    if (busy || blocked || !text.trim()) return;
    setBusy(true);
    setError(null);
    const r = await sendToAgent(req, text);
    setBusy(false);
    if (r.ok) {
      notify("info", `Sent to ${name}`);
      closeAskAgent();
    } else setError(r.reason);
  };

  return (
    <Modal
      title={req.title}
      onClose={closeAskAgent}
      width={640}
      className="so-handoff"
      footer={
        <>
          <span className="so-handoff-note">Typed into {name} and submitted with Enter.</span>
          <Button onClick={closeAskAgent}>Cancel</Button>
          <Button variant="primary" disabled={busy || !!blocked || !text.trim()} onClick={() => void send()}>
            {busy ? "Sending…" : "Send"}
          </Button>
        </>
      }
    >
      <div className="form">
        <textarea
          className="so-handoff-text"
          data-autofocus
          rows={5}
          spellCheck={false}
          value={text}
          aria-label="Message"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (isMac ? e.metaKey : e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="so-handoff-hint">One line: line breaks are sent as spaces. Nothing is sent until you press Send (or {isMac ? "⌘↩" : "Ctrl+Enter"}).</div>
        {blocked && <div className="callout so-callout-warn">{blocked}</div>}
        {error && <div className="callout is-error">{error}</div>}
      </div>
    </Modal>
  );
}
