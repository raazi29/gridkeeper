// "Add memory" dialog (palette "Brain: add memory…", the "remember…" chip, "+ new" and "supersede…" in the panel).
// Small front matter inputs + a monospace body. Save writes ONE new file: notes/ (confirmed: the user wrote it) or,
// with "suggest only", inbox/. The text is scrubbed of paths / e-mails / secret-looking tokens when it is prefilled;
// Rust masks secrets again on write.

import { useState } from "react";
import { BRAIN_KINDS, KIND_LABEL, parseTags, type BrainKind } from "../../lib/brain";
import { addMemory, closeCompose, openBrain, useBrain, type ComposeRequest } from "../../store/brain";
import { confirmDialog } from "../../store/uiStore";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";

export function ComposeDialog() {
  const req = useBrain((s) => s.compose);
  if (!req) return null;
  return <Compose key={`${req.dir}|${req.supersedes ?? ""}|${req.title}`} req={req} />;
}

function Compose({ req }: { req: ComposeRequest }) {
  const [title, setTitle] = useState(req.title);
  const [kind, setKind] = useState<BrainKind>(req.kind);
  const [tags, setTags] = useState(req.tags.join(", "));
  const [source, setSource] = useState(req.source);
  const [body, setBody] = useState(req.body);
  const [inbox, setInbox] = useState(req.target === "inbox");
  const [busy, setBusy] = useState(false);
  const dirty = title !== req.title || body !== req.body || tags !== req.tags.join(", ") || kind !== req.kind || source !== req.source;
  const empty = !title.trim() && !body.trim();

  const requestClose = async () => {
    if (dirty && !empty && !(await confirmDialog({ title: "Discard this memory?", message: "Nothing has been written yet.", confirmLabel: "Discard", danger: true }))) return;
    closeCompose();
  };
  const save = async () => {
    if (busy || empty) return;
    setBusy(true);
    try {
      const slug = await addMemory({ ...req, title: title.trim(), kind, tags: parseTags(tags), source: source.trim(), body: body.trim(), target: inbox ? "inbox" : "notes" });
      if (slug) {
        closeCompose();
        if (useBrain.getState().open) openBrain({ dir: req.dir, tab: inbox ? "inbox" : "notes", select: { slug, inbox } });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={req.supersedes ? `Supersede “${req.supersedes}”` : "Add memory"}
      ariaLabel="Add memory to the brain"
      onClose={() => void requestClose()}
      width={620}
      className="br-compose"
      footer={
        <>
          <label className="br-check footer-note" title="Write it to inbox/ as a suggestion instead of a confirmed note">
            <input type="checkbox" checked={inbox} onChange={(e) => setInbox(e.target.checked)} /> suggest only (inbox)
          </label>
          <Button onClick={() => void requestClose()}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || empty}>
            {busy ? "Saving…" : inbox ? "Suggest" : "Remember"}
          </Button>
        </>
      }
    >
      <div className="br-form" onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void save();
        }
      }}>
        <label className="br-field br-field-wide">
          <span className="br-label">title</span>
          <input className="br-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="One line the next agent can scan" maxLength={120} data-autofocus spellCheck={false} />
        </label>
        <label className="br-field">
          <span className="br-label">kind</span>
          <select className="br-input" value={kind} onChange={(e) => setKind(e.target.value as BrainKind)}>
            {BRAIN_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="br-field">
          <span className="br-label">tags</span>
          <input className="br-input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="auth, ci" spellCheck={false} />
        </label>
        <label className="br-field br-field-wide">
          <span className="br-label">source</span>
          <input className="br-input" value={source} onChange={(e) => setSource(e.target.value)} placeholder="user, mission goal or task" spellCheck={false} />
        </label>
        <label className="br-field br-field-wide">
          <span className="br-label">memory</span>
          <textarea
            className="br-input br-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={7}
            spellCheck={false}
            placeholder="A few concrete lines: what, why, and when it applies. No secrets, tokens, e-mail addresses or personal data."
          />
        </label>
        <div className="br-hint">Ctrl+Enter saves · stored as a Markdown file in .gridkeeper/brain/{inbox ? "inbox" : "notes"}/ that every agent can read</div>
      </div>
    </Modal>
  );
}
