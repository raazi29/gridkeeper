// One memory in the Brain panel: reader (front matter as fields, body in monospace) and editor (front matter as
// small inputs, body textarea; unknown front matter keys and the file's line endings are kept). Saves with the
// conflict check: an agent's concurrent edit is never overwritten silently. Notes: edit / supersede… / forget;
// inbox suggestions: approve / edit / discard.

import { useEffect, useState } from "react";
import { BRAIN_KINDS, editNote, formatTags, KIND_LABEL, KIND_MARK, noteFields, parseTags, today, type BrainKind } from "../../lib/brain";
import { errorMessage, ipc } from "../../lib/ipc";
import type { BrainIndex, BrainNoteFile } from "../../lib/types";
import { approveSuggestion, discardSuggestion, forgetNote, openCompose, patchBrain, saveNote, type Selection } from "../../store/brain";
import { confirmDialog } from "../../store/uiStore";
import { copyText, revealPath } from "../util/pick";

interface Draft {
  title: string;
  kind: BrainKind;
  tags: string;
  source: string;
  supersedes: string;
  body: string;
}

function draftOf(text: string, inbox: boolean): Draft {
  const f = noteFields(text, inbox);
  return { title: f.title, kind: f.kind, tags: f.tags.join(", "), source: f.source, supersedes: f.supersedes, body: f.body };
}

export function NoteDetail({ dir, sel, index }: { dir: string; sel: Selection; index: BrainIndex | null }) {
  const meta = (sel.inbox ? index?.inbox : index?.notes)?.find((n) => n.slug === sel.slug) ?? null;
  const [file, setFile] = useState<BrainNoteFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = draft !== null;

  // (Re-)read when the file changes on disk (the index carries its modification time); an open editor is kept.
  const diskMs = meta?.modifiedMs ?? 0;
  useEffect(() => {
    let live = true;
    ipc
      .brainRead(dir, sel.slug, sel.inbox)
      .then((f) => {
        if (!live) return;
        setError(null);
        setFile((cur) => (cur && editing ? cur : f));
      })
      .catch((e) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, sel.slug, sel.inbox, diskMs]);

  const changedOnDisk = editing && !!file && !!meta && meta.modifiedMs !== 0 && file.modifiedMs !== null && Math.abs(meta.modifiedMs - file.modifiedMs) > 1;

  if (error) return <div className="br-detail"><div className="br-error">could not read the note: {error}</div></div>;
  if (!file) return <div className="br-detail"><div className="br-muted br-pad">reading…</div></div>;
  if (!file.exists) return <div className="br-detail"><div className="br-muted br-pad">this note is gone (deleted or approved meanwhile)</div></div>;

  const f = noteFields(file.text, sel.inbox);
  const title = f.title || meta?.title || sel.slug;
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(draftOf(file.text, sel.inbox));

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    try {
      const text = editNote(
        file.text,
        {
          title: draft.title,
          kind: draft.kind,
          tags: formatTags(parseTags(draft.tags)),
          source: draft.source || null,
          supersedes: draft.supersedes.trim().replace(/\.md$/i, "") || null,
          created: f.created || today(),
          updated: today(),
        },
        draft.body,
      );
      const r = await saveNote(dir, sel.slug, sel.inbox, text, file.modifiedMs);
      if (r.ok) {
        setFile(r.file);
        setDraft(null);
      }
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (dirty && !(await confirmDialog({ title: "Discard your edits?", message: "The note stays as it is on disk.", confirmLabel: "Discard", danger: true }))) return;
    setDraft(null);
  };
  const reloadFromDisk = async () => {
    try {
      const fresh = await ipc.brainRead(dir, sel.slug, sel.inbox);
      setFile(fresh);
      if (draft) setDraft(draftOf(fresh.text, sel.inbox));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <div className="br-detail" aria-label={`Memory: ${title}`}>
      <div className="br-box-label">
        <span>{sel.inbox ? "suggestion · inbox" : "memory · notes"}</span>
        <span className="br-box-label-right">{sel.slug}.md</span>
      </div>
      {!editing ? (
        <>
          <h3 className={`br-detail-title is-${f.kind}`}>
            <span className="br-mark" aria-hidden="true">
              {KIND_MARK[f.kind]}
            </span>
            {title}
          </h3>
          <dl className="br-fields">
            <dt>kind</dt>
            <dd>{KIND_LABEL[f.kind]}</dd>
            <dt>tags</dt>
            <dd>{f.tags.length ? f.tags.map((t) => `#${t}`).join(" ") : <span className="br-muted">—</span>}</dd>
            <dt>source</dt>
            <dd>{f.source || <span className="br-muted">—</span>}</dd>
            <dt>dates</dt>
            <dd>
              {f.created ? `created ${f.created}` : <span className="br-muted">no created date</span>}
              {f.updated && f.updated !== f.created ? ` · updated ${f.updated}` : ""}
            </dd>
            <dt>status</dt>
            <dd className={f.confidence === "suggested" ? "is-suggested" : "is-confirmed"}>{f.confidence}</dd>
            {f.supersedes && (
              <>
                <dt>replaces</dt>
                <dd>
                  <button type="button" className="link-btn mono" onClick={() => patchBrain({ selected: { slug: f.supersedes, inbox: false } })}>
                    {f.supersedes}
                  </button>
                </dd>
              </>
            )}
            {meta?.supersededBy && (
              <>
                <dt>replaced by</dt>
                <dd>
                  <button type="button" className="link-btn mono" onClick={() => patchBrain({ selected: { slug: meta.supersededBy!, inbox: false } })}>
                    {meta.supersededBy}
                  </button>{" "}
                  <span className="br-muted">(read that one instead)</span>
                </dd>
              </>
            )}
          </dl>
          <pre className="br-text">{f.body || "(empty)"}</pre>
        </>
      ) : (
        <div
          className="br-form"
          onKeyDown={(e) => {
            if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void save();
            } else if (e.key === "Escape") {
              // Leave the editor (asking when there are edits) instead of closing the whole panel.
              e.preventDefault();
              e.stopPropagation();
              void cancel();
            }
          }}
        >
          {changedOnDisk && (
            <div className="br-warn" role="status">
              The file changed on disk while you were editing (an agent may have updated it).{" "}
              <button type="button" className="link-btn" onClick={() => void reloadFromDisk()}>
                Load the latest version
              </button>{" "}
              (discards your edits).
            </div>
          )}
          <label className="br-field br-field-wide">
            <span className="br-label">title</span>
            <input className="br-input" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={120} spellCheck={false} autoFocus />
          </label>
          <label className="br-field">
            <span className="br-label">kind</span>
            <select className="br-input" value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as BrainKind })}>
              {BRAIN_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="br-field">
            <span className="br-label">tags</span>
            <input className="br-input" value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="auth, ci" spellCheck={false} />
          </label>
          <label className="br-field">
            <span className="br-label">source</span>
            <input className="br-input" value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} spellCheck={false} />
          </label>
          <label className="br-field">
            <span className="br-label">supersedes</span>
            <input className="br-input" value={draft.supersedes} onChange={(e) => setDraft({ ...draft, supersedes: e.target.value })} placeholder="slug of the note it replaces" spellCheck={false} />
          </label>
          <label className="br-field br-field-wide">
            <span className="br-label">memory</span>
            <textarea className="br-input br-body" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} rows={10} spellCheck={false} />
          </label>
          <div className="br-hint">Ctrl+S saves · unknown front matter keys are kept · secret-looking values are masked on save</div>
        </div>
      )}

      <div className="br-actions">
        <button type="button" className="link-btn mono br-path" title="Show the file" onClick={() => void revealPath(file.path)}>
          {file.path}
        </button>
        {editing ? (
          <>
            <button type="button" className="br-btn" onClick={() => void cancel()}>
              cancel
            </button>
            <button type="button" className="br-btn is-primary" disabled={busy || !dirty} onClick={() => void save()}>
              {busy ? "saving…" : "save"}
            </button>
          </>
        ) : sel.inbox ? (
          <>
            <button type="button" className="br-btn" onClick={() => setDraft(draftOf(file.text, true))}>
              edit
            </button>
            <button type="button" className="br-btn is-danger" onClick={() => void discardSuggestion(dir, sel.slug, title)} title="Delete this suggestion (Undo in the toast)">
              discard
            </button>
            <button type="button" className="br-btn is-primary" onClick={() => void approveSuggestion(dir, sel.slug)} title="Move it to notes/ as a confirmed memory">
              approve
            </button>
          </>
        ) : (
          <>
            <button type="button" className="br-btn" onClick={() => void copyText(file.text, "Note copied")} title="Copy the Markdown">
              copy
            </button>
            <button type="button" className="br-btn" onClick={() => setDraft(draftOf(file.text, false))}>
              edit
            </button>
            <button
              type="button"
              className="br-btn"
              title="Write a newer note that replaces this one (this one stays as history)"
              onClick={() => openCompose({ dir, title: f.title || title, kind: f.kind, tags: f.tags, body: f.body, source: "user", supersedes: sel.slug, target: "notes" })}
            >
              supersede…
            </button>
            <button type="button" className="br-btn is-danger" onClick={() => void forgetNote(dir, sel.slug, title)} title="Delete this memory (Undo in the toast)">
              forget
            </button>
          </>
        )}
      </div>
    </div>
  );
}
