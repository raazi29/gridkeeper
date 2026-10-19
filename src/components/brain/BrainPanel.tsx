// Brain panel (palette "Brain: open", Mission Control's "brain" button): the team's long-term project memory in
// <project>/.gridkeeper/brain/. Search (ranked, local, instant), kind / tag filters, notes and inbox lists, a
// reader / editor (NoteDetail), the inbox's Approve / Edit / Discard, supersede, Forget with Undo, counts, and the
// project's brain settings (capture, auto-approve, briefs, share through git). Terminal / box-drawing look.

import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { BRAIN_KINDS, KIND_LABEL, KIND_MARK, normalizeKind, type BrainKind } from "../../lib/brain";
import type { BrainIndex, BrainNoteMeta } from "../../lib/types";
import {
  acquireBrain,
  brainPrefs,
  closeBrain,
  EMPTY_BRAIN,
  openCompose,
  patchBrain,
  runSearch,
  setBrainPrefs,
  setBrainShared,
  useBrain,
  type Selection,
} from "../../store/brain";
import { Modal } from "../ui/Modal";
import { revealPath } from "../util/pick";
import { shortPath } from "../util/text";
import { NoteDetail } from "./NoteDetail";

/** One list row: a note / suggestion from the index or a search hit. */
interface Row {
  slug: string;
  inbox: boolean;
  title: string;
  kind: BrainKind;
  tags: string[];
  meta: string;
  snippet: string;
  superseded: boolean;
}

const sameSel = (a: Selection | null, r: Pick<Row, "slug" | "inbox">) => !!a && a.slug === r.slug && a.inbox === r.inbox;

function rowOf(n: BrainNoteMeta): Row {
  return {
    slug: n.slug,
    inbox: n.inbox,
    title: n.title,
    kind: normalizeKind(n.kind),
    tags: n.tags,
    meta: [n.updated ?? "", n.supersededBy ? `superseded by ${n.supersededBy}` : ""].filter(Boolean).join(" · "),
    snippet: n.excerpt,
    superseded: !!n.supersededBy,
  };
}

export function BrainPanel() {
  const dir = useBrain((s) => s.dir);
  useEffect(() => (dir ? acquireBrain(dir) : undefined), [dir]);
  return (
    <Modal
      title={
        <span className="br-title">
          <span className="br-glyph" aria-hidden="true">
            ◆
          </span>
          <span className="br-title-text">brain</span>
          <span className="br-title-sub">long-term project memory{dir ? ` · ${shortPath(dir)}` : ""}</span>
        </span>
      }
      ariaLabel="Brain: long-term project memory"
      onClose={closeBrain}
      width={1120}
      className="br-modal"
    >
      {dir ? <Body dir={dir} /> : <NoProject />}
    </Modal>
  );
}

function NoProject() {
  return (
    <div className="br-empty-panel">
      <p>The brain lives in the project folder (<span className="mono">&lt;folder&gt;/.gridkeeper/brain/</span>), next to the mission board.</p>
      <p>Choose a project folder for this workspace (workspace settings or Mission Control), then open the brain again.</p>
    </div>
  );
}

function Body({ dir }: { dir: string }) {
  const entry = useBrain((s) => s.byDir[dir]) ?? EMPTY_BRAIN;
  const query = useBrain((s) => s.query);
  const hits = useBrain((s) => s.hits);
  const kind = useBrain((s) => s.kind);
  const tag = useBrain((s) => s.tag);
  const tab = useBrain((s) => s.tab);
  const selected = useBrain((s) => s.selected);
  const index = entry.index;
  const searchRef = useRef<HTMLInputElement>(null);

  // Instant search: Rust ranks on every keystroke (debounced a little to coalesce fast typing).
  useEffect(() => {
    const t = setTimeout(() => void runSearch(dir, query), query.trim() ? 90 : 0);
    return () => clearTimeout(t);
  }, [dir, query]);

  const searching = query.trim().length > 0;
  const rows: Row[] = useMemo(() => {
    if (!index) return [];
    let list: Row[];
    if (searching) {
      const meta = new Map([...index.notes, ...index.inbox].map((n) => [`${n.inbox ? "i" : "n"}|${n.slug}`, n]));
      list = (hits ?? []).map((h) => {
        const n = meta.get(`${h.inbox ? "i" : "n"}|${h.slug}`);
        return { ...(n ? rowOf(n) : { meta: "", superseded: h.superseded }), slug: h.slug, inbox: h.inbox, title: h.title, kind: normalizeKind(h.kind), tags: h.tags, snippet: h.snippet } as Row;
      });
    } else list = (tab === "inbox" ? index.inbox : index.notes).map(rowOf);
    return list.filter((r) => (kind === "all" || r.kind === kind) && (!tag || r.tags.includes(tag)));
  }, [index, hits, searching, tab, kind, tag]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of index?.notes ?? []) if (!n.supersededBy) c[normalizeKind(n.kind)] = (c[normalizeKind(n.kind)] ?? 0) + 1;
    return c;
  }, [index]);
  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of [...(index?.notes ?? []), ...(index?.inbox ?? [])]) for (const t of n.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  }, [index]);

  const listRef = useRef<HTMLDivElement>(null);
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button.br-row") ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = items[e.key === "ArrowDown" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1)];
    next?.focus();
    next?.click();
  };

  return (
    <div className="br-body">
      <div className="br-toolbar">
        <label className="br-search">
          <span className="br-search-glyph" aria-hidden="true">
            ⌕
          </span>
          <input
            ref={searchRef}
            className="br-search-input"
            value={query}
            onChange={(e) => patchBrain({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.preventDefault();
                e.stopPropagation();
                patchBrain({ query: "" });
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                const first = listRef.current?.querySelector<HTMLButtonElement>("button.br-row");
                first?.focus();
                first?.click();
              }
            }}
            placeholder="search memories (title, tags, text)…"
            aria-label="Search the brain"
            spellCheck={false}
            data-autofocus
          />
        </label>
        <div className="br-kinds" role="group" aria-label="Filter by kind">
          <button type="button" className={`br-chip${kind === "all" ? " is-on" : ""}`} aria-pressed={kind === "all"} onClick={() => patchBrain({ kind: "all" })}>
            all
          </button>
          {BRAIN_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={`br-chip is-${k}${kind === k ? " is-on" : ""}`}
              aria-pressed={kind === k}
              title={`Only ${KIND_LABEL[k]} memories`}
              onClick={() => patchBrain({ kind: kind === k ? "all" : k })}
            >
              <span className="br-mark" aria-hidden="true">
                {KIND_MARK[k]}
              </span>
              {KIND_LABEL[k]}
              {counts[k] ? <span className="br-chip-n">{counts[k]}</span> : null}
            </button>
          ))}
        </div>
        {tags.length > 0 && (
          <select className="br-tag-select" value={tag ?? ""} onChange={(e) => patchBrain({ tag: e.target.value || null })} aria-label="Filter by tag">
            <option value="">#any tag</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                #{t}
              </option>
            ))}
          </select>
        )}
        <span className="br-spacer" />
        <button type="button" className="br-btn is-primary" onClick={() => openCompose({ dir })} title="Write a memory yourself (saved as confirmed)">
          + new memory
        </button>
      </div>

      <div className="br-cols">
        <div className="br-left">
          <div className="br-tabs" role="tablist" aria-label="Brain folders">
            {searching ? (
              <span className="br-tab is-selected" role="tab" aria-selected>
                results [ <b>{rows.length}</b> ]
              </span>
            ) : (
              <>
                <button type="button" role="tab" aria-selected={tab === "notes"} className={`br-tab${tab === "notes" ? " is-selected" : ""}`} onClick={() => patchBrain({ tab: "notes" })}>
                  notes [ <b>{index?.notes.length ?? 0}</b> ]
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "inbox"}
                  className={`br-tab${tab === "inbox" ? " is-selected" : ""}${index?.inbox.length ? " has-items" : ""}`}
                  onClick={() => patchBrain({ tab: "inbox" })}
                  title="Suggested memories (from agents and Gridkeeper) waiting for your approval"
                >
                  inbox [ <b>{index?.inbox.length ?? 0}</b> ]
                </button>
              </>
            )}
          </div>
          <div className="br-list" ref={listRef} onKeyDown={onListKey} role="listbox" aria-label="Memories">
            {entry.error && <div className="br-error">could not read the brain: {entry.error}</div>}
            {!index && !entry.error && <div className="br-muted br-pad">reading…</div>}
            {index && rows.length === 0 && <EmptyList index={index} searching={searching} tab={tab} filtered={kind !== "all" || !!tag} />}
            {rows.map((r) => (
              <button
                key={`${r.inbox ? "i" : "n"}|${r.slug}`}
                type="button"
                role="option"
                aria-selected={sameSel(selected, r)}
                className={`br-row is-${r.kind}${sameSel(selected, r) ? " is-selected" : ""}${r.superseded ? " is-superseded" : ""}`}
                onClick={() => patchBrain({ selected: { slug: r.slug, inbox: r.inbox } })}
                title={r.snippet}
              >
                <span className="br-row-head">
                  <span className="br-mark" aria-hidden="true">
                    {KIND_MARK[r.kind]}
                  </span>
                  <span className="br-row-title">{r.title}</span>
                  {r.inbox && <span className="br-badge">inbox</span>}
                </span>
                <span className="br-row-meta">
                  {KIND_LABEL[r.kind]}
                  {r.tags.length > 0 && <> · {r.tags.map((t) => `#${t}`).join(" ")}</>}
                  {r.meta && <> · {r.meta}</>}
                </span>
                {searching && r.snippet && <span className="br-row-snippet">{r.snippet}</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="br-right">
          {selected ? <NoteDetail key={`${selected.inbox ? "i" : "n"}|${selected.slug}`} dir={dir} sel={selected} index={index} /> : <Intro dir={dir} index={index} />}
        </div>
      </div>
      <StatusLine dir={dir} index={index} />
    </div>
  );
}

function EmptyList({ index, searching, tab, filtered }: { index: BrainIndex; searching: boolean; tab: "notes" | "inbox"; filtered: boolean }) {
  if (searching) return <div className="br-muted br-pad">no memory matches{filtered ? " (with these filters)" : ""}</div>;
  if (filtered) return <div className="br-muted br-pad">nothing with these filters</div>;
  if (tab === "inbox") return <div className="br-muted br-pad">no suggestions waiting — agents and Gridkeeper put them here for you to approve</div>;
  return <div className="br-muted br-pad">{index.exists ? "no memories yet" : "no brain yet — the first memory creates it"}</div>;
}

function Intro({ dir, index }: { dir: string; index: BrainIndex | null }) {
  const shown = index?.dir ?? `${dir}/.gridkeeper/brain`;
  return (
    <div className="br-intro">
      <div className="br-box-label"><span>how it works</span></div>
      <p>
        Agents forget everything between sessions. The brain is the team's memory for this project: decisions, conventions, gotchas, how-tos, facts and
        context, one small Markdown file per memory that every agent can read.
      </p>
      <ul className="br-steps">
        <li>
          <b>read</b> — briefs tell agents to read <span className="mono">INDEX.md</span> first and open the notes relevant to their task.
        </li>
        <li>
          <b>suggest</b> — agents write new memories to <span className="mono">inbox/</span>; Gridkeeper also suggests some from finished tasks with notes,
          resolved blockers, review outcomes and the lead's decisions.
        </li>
        <li>
          <b>approve</b> — you approve, edit or discard suggestions here; approved ones move to <span className="mono">notes/</span>.
        </li>
        <li>
          <b>correct</b> — supersede a note with a newer one instead of rewriting history; forget what is wrong.
        </li>
      </ul>
      <p className="br-muted">
        Plain files, local only, no cloud: <button type="button" className="link-btn mono" onClick={() => void revealPath(shown)}>{shown}</button>
      </p>
      {index && index.ignored.length > 0 && (
        <p className="br-warn">
          {index.ignored.length === 1 ? "1 file is" : `${index.ignored.length} files are`} not read (names must look like <span className="mono">token-storage.md</span>):{" "}
          <span className="mono">{index.ignored.join(", ")}</span>
        </p>
      )}
    </div>
  );
}

function StatusLine({ dir, index }: { dir: string; index: BrainIndex | null }) {
  useBrain((s) => s.prefsVersion); // re-render when preferences change
  const prefs = brainPrefs(dir);
  const superseded = index?.notes.filter((n) => n.supersededBy).length ?? 0;
  return (
    <footer className="br-status" aria-label="Brain status and settings">
      <span>
        notes [ <b>{index?.notes.length ?? 0}</b> ]
      </span>
      <span className={index?.inbox.length ? "is-attn" : ""}>
        inbox [ <b>{index?.inbox.length ?? 0}</b> ]
      </span>
      {superseded > 0 && (
        <span>
          superseded [ <b>{superseded}</b> ]
        </span>
      )}
      <span className="br-spacer" />
      <label className="br-check" title="Suggest memories from finished tasks with notes, resolved blockers, review outcomes and lead decisions (into the inbox)">
        <input type="checkbox" checked={prefs.capture} onChange={(e) => setBrainPrefs(dir, { capture: e.target.checked })} /> capture suggestions
      </label>
      <label className="br-check" title="Gridkeeper's own captured suggestions skip the inbox and become notes right away. Files agents write to inbox/ always wait for you.">
        <input type="checkbox" checked={prefs.autoApprove} onChange={(e) => setBrainPrefs(dir, { autoApprove: e.target.checked })} /> auto-approve captured
      </label>
      <label className="br-check" title="“Brief team…” and formation starter prompts tell agents to read INDEX.md and write suggestions to inbox/">
        <input type="checkbox" checked={prefs.briefs} onChange={(e) => setBrainPrefs(dir, { briefs: e.target.checked })} /> mention in briefs
      </label>
      <label
        className="br-check"
        title="Local (default): the brain stays in this folder and out of git. Shared: notes/*.md and INDEX.md can be committed so teammates and fresh clones get them; the inbox stays local."
      >
        <input type="checkbox" checked={!!index?.shared} disabled={!index} onChange={(e) => void setBrainShared(dir, e.target.checked)} /> share via git
      </label>
    </footer>
  );
}
