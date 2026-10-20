// "Add memory" dialog (palette "Brain: add memory…", the "remember…" chip, "+ new" and "supersede…" in the panel).
// Small front matter inputs + a monospace body. Save writes ONE new file: notes/ (confirmed: the user wrote it) or,
// with "suggest only", inbox/. The text is scrubbed of paths / e-mails / secret-looking tokens when it is prefilled;
// Rust masks secrets again on write.

import { useState } from "react";
import { useT } from "../../i18n";
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
  const t = useT();
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
    if (dirty && !empty && !(await confirmDialog({ title: t("brain.compose.discardTitle"), message: t("brain.compose.discardMessage"), confirmLabel: t("brain.confirmDiscard"), danger: true }))) return;
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
      title={req.supersedes ? t("brain.compose.supersedeTitle", { slug: req.supersedes }) : t("brain.compose.title")}
      ariaLabel={t("brain.compose.aria")}
      onClose={() => void requestClose()}
      width={620}
      className="br-compose"
      footer={
        <>
          <label className="br-check br-push" title={t("brain.compose.suggestOnlyTitle")}>
            <input type="checkbox" checked={inbox} onChange={(e) => setInbox(e.target.checked)} /> {t("brain.compose.suggestOnly")}
          </label>
          <Button onClick={() => void requestClose()}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy || empty}>
            {t(busy ? "brain.compose.saving" : inbox ? "brain.compose.suggest" : "brain.compose.remember")}
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
          <span className="br-label">{t("brain.field.title")}</span>
          <input className="br-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("brain.compose.titlePlaceholder")} maxLength={120} data-autofocus spellCheck={false} />
        </label>
        <label className="br-field">
          <span className="br-label">{t("brain.field.kind")}</span>
          <select className="br-input" value={kind} onChange={(e) => setKind(e.target.value as BrainKind)}>
            {BRAIN_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(KIND_LABEL[k])}
              </option>
            ))}
          </select>
        </label>
        <label className="br-field">
          <span className="br-label">{t("brain.field.tags")}</span>
          <input className="br-input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="auth, ci" spellCheck={false} />
        </label>
        <label className="br-field br-field-wide">
          <span className="br-label">{t("brain.field.source")}</span>
          <input className="br-input" value={source} onChange={(e) => setSource(e.target.value)} placeholder={t("brain.compose.sourcePlaceholder")} spellCheck={false} />
        </label>
        <label className="br-field br-field-wide">
          <span className="br-label">{t("brain.field.memory")}</span>
          <textarea
            className="br-input br-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={7}
            spellCheck={false}
            placeholder={t("brain.compose.bodyPlaceholder")}
          />
        </label>
        <div className="br-hint">{t("brain.compose.hint", { folder: `.gridkeeper/brain/${inbox ? "inbox" : "notes"}/` })}</div>
      </div>
    </Modal>
  );
}
