// Confirmed message to the agent that owns a branch: "ask the agent to fix" (failed tests) and "hand to
// the agent" (merge conflicts). Same rules as a hand-off: an editable one-line message, nothing typed
// until Send, refused while the agent is asking something.

import { useState } from "react";
import { useT } from "../../i18n";
import { isMac } from "../../lib/platform";
import { isLive, useApp } from "../../store/appStore";
import { useAttention } from "../../store/attention";
import { closeAskAgent, sendToAgent, type AskAgentRequest } from "../../store/testrun";
import { notify } from "../../actions/notify";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import "../../styles/signoff.css";

export function AskAgentDialog({ req }: { req: AskAgentRequest }) {
  const t = useT();
  const [text, setText] = useState(req.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = useApp((s) => s.persisted.sessions.find((m) => m.id === req.sessionId)?.name) ?? t("testrun.ask.sessionFallback");
  const live = useApp((s) => isLive(s.runtime[req.sessionId]));
  const waiting = useAttention((s) => s.sessions[req.sessionId]?.state === "waiting");
  const blocked = !live ? t("testrun.ask.notRunning", { name }) : waiting ? t("testrun.ask.waiting", { name }) : null;

  const send = async () => {
    if (busy || blocked || !text.trim()) return;
    setBusy(true);
    setError(null);
    const r = await sendToAgent(req, text);
    setBusy(false);
    if (r.ok) {
      notify("info", t("testrun.ask.sent", { name }));
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
          <span className="so-handoff-note">{t("testrun.ask.note", { name })}</span>
          <Button onClick={closeAskAgent}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy || !!blocked || !text.trim()} onClick={() => void send()}>
            {busy ? t("testrun.ask.sending") : t("testrun.ask.send")}
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
          aria-label={t("testrun.ask.messageAria")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (isMac ? e.metaKey : e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="so-handoff-hint">{t("testrun.ask.hint", { keys: isMac ? "⌘↩" : "Ctrl+Enter" })}</div>
        {blocked && <div className="callout so-callout-warn">{blocked}</div>}
        {error && <div className="callout is-error">{error}</div>}
      </div>
    </Modal>
  );
}
