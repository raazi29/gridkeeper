// Brain panel (palette "Brain: open", Mission Control's "brain" button): the team's long-term project memory in
// <project>/.gridkeeper/brain/. Search (ranked, local, instant), kind / tag filters, notes and inbox lists, a
// reader / editor (NoteDetail), the inbox's Approve / Edit / Discard, supersede, Forget with Undo, counts, and the
// project's brain settings (capture, auto-approve, briefs, share through git). Terminal / box-drawing look.

import { useEffect, useMemo, useRef, type KeyboardEvent, type ReactNode } from "react";
import { useT, type Translator } from "../../i18n";
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

function rowOf(n: BrainNoteMeta, t: Translator): Row {
  return {
    slug: n.slug,
    inbox: n.inbox,
    title: n.title,
    kind: normalizeKind(n.kind),
    tags: n.tags,
    meta: [n.updated ?? "", n.supersededBy ? t("brain.panel.supersededBy", { slug: n.supersededBy }) : ""].filter(Boolean).join(" · "),
    snippet: n.excerpt,
    superseded: !!n.supersededBy,
  };
}

const mono = (c: ReactNode) => <span className="mono">{c}</span>;
const bold = (c: ReactNode) => <b>{c}</b>;

export function BrainPanel() {
  const t = useT();
  const dir = useBrain((s) => s.dir);
  useEffect(() => (dir ? acquireBrain(dir) : undefined), [dir]);
  return (
    <Modal
      title={
        <span className="br-title">
          <span className="br-glyph" aria-hidden="true">
            ◆
          </span>
          <span className="br-title-text">{t("brain.panel.title")}</span>
          <span className="br-title-sub">
            {t("brain.panel.subtitle")}
            {dir ? ` · ${shortPath(dir)}` : ""}
          </span>
        </span>
      }
      ariaLabel={t("brain.panel.aria")}
      onClose={closeBrain}
      width={1120}
      className="br-modal"
    >
      {dir ? <Body dir={dir} /> : <NoProject />}
    </Modal>
  );
}

function NoProject() {
  const t = useT();
  return (
    <div className="br-empty-panel">
      <p>{t.rich("brain.panel.noProjectWhere", { path: "<folder>/.gridkeeper/brain/", mono })}</p>
      <p>{t("brain.panel.noProjectChoose")}</p>
    </div>
  );
}

function Body({ dir }: { dir: string }) {
  const t = useT();
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
    const timer = setTimeout(() => void runSearch(dir, query), query.trim() ? 90 : 0);
    return () => clearTimeout(timer);
  }, [dir, query]);

  const searching = query.trim().length > 0;
  const rows: Row[] = useMemo(() => {
    if (!index) return [];
    let list: Row[];
    if (searching) {
      const meta = new Map([...index.notes, ...index.inbox].map((n) => [`${n.inbox ? "i" : "n"}|${n.slug}`, n]));
      list = (hits ?? []).map((h) => {
        const n = meta.get(`${h.inbox ? "i" : "n"}|${h.slug}`);
        return { ...(n ? rowOf(n, t) : { meta: "", superseded: h.superseded }), slug: h.slug, inbox: h.inbox, title: h.title, kind: normalizeKind(h.kind), tags: h.tags, snippet: h.snippet } as Row;
      });
    } else list = (tab === "inbox" ? index.inbox : index.notes).map((n) => rowOf(n, t));
    return list.filter((r) => (kind === "all" || r.kind === kind) && (!tag || r.tags.includes(tag)));
  }, [index, hits, searching, tab, kind, tag, t]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const n of index?.notes ?? []) if (!n.supersededBy) c[normalizeKind(n.kind)] = (c[normalizeKind(n.kind)] ?? 0) + 1;
    return c;
  }, [index]);
  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of [...(index?.notes ?? []), ...(index?.inbox ?? [])]) for (const tg of n.tags) m.set(tg, (m.get(tg) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tg]) => tg);
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
            placeholder={t("brain.panel.searchPlaceholder")}
            aria-label={t("brain.panel.searchAria")}
            spellCheck={false}
            data-autofocus
          />
        </label>
        <div className="br-kinds" role="group" aria-label={t("brain.panel.kindFilterAria")}>
          <button type="button" className={`br-chip${kind === "all" ? " is-on" : ""}`} aria-pressed={kind === "all"} onClick={() => patchBrain({ kind: "all" })}>
            {t("brain.panel.kindAll")}
          </button>
          {BRAIN_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className={`br-chip is-${k}${kind === k ? " is-on" : ""}`}
              aria-pressed={kind === k}
              title={t("brain.panel.kindOnlyTitle", { kind: t(KIND_LABEL[k]) })}
              onClick={() => patchBrain({ kind: kind === k ? "all" : k })}
            >
              <span className="br-mark" aria-hidden="true">
                {KIND_MARK[k]}
              </span>
              {t(KIND_LABEL[k])}
              {counts[k] ? <span className="br-chip-n">{counts[k]}</span> : null}
            </button>
          ))}
        </div>
        {tags.length > 0 && (
          <select className="br-tag-select" value={tag ?? ""} onChange={(e) => patchBrain({ tag: e.target.value || null })} aria-label={t("brain.panel.tagFilterAria")}>
            <option value="">{t("brain.panel.anyTag")}</option>
            {tags.map((tg) => (
              <option key={tg} value={tg}>
                #{tg}
              </option>
            ))}
          </select>
        )}
        <span className="br-spacer" />
        <button type="button" className="br-btn is-primary" onClick={() => openCompose({ dir })} title={t("brain.panel.newMemoryTitle")}>
          {t("brain.panel.newMemory")}
        </button>
      </div>

      <div className="br-cols">
        <div className="br-left">
          <div className="br-tabs" role="tablist" aria-label={t("brain.panel.foldersAria")}>
            {searching ? (
              <span className="br-tab is-selected" role="tab" aria-selected>
                {t.rich("brain.panel.results", { count: rows.length, b: bold })}
              </span>
            ) : (
              <>
                <button type="button" role="tab" aria-selected={tab === "notes"} className={`br-tab${tab === "notes" ? " is-selected" : ""}`} onClick={() => patchBrain({ tab: "notes" })}>
                  {t.rich("brain.panel.notesCount", { count: index?.notes.length ?? 0, b: bold })}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "inbox"}
                  className={`br-tab${tab === "inbox" ? " is-selected" : ""}${index?.inbox.length ? " has-items" : ""}`}
                  onClick={() => patchBrain({ tab: "inbox" })}
                  title={t("brain.panel.inboxTitle")}
                >
                  {t.rich("brain.panel.inboxCount", { count: index?.inbox.length ?? 0, b: bold })}
                </button>
              </>
            )}
          </div>
          <div className="br-list" ref={listRef} onKeyDown={onListKey} role="listbox" aria-label={t("brain.panel.listAria")}>
            {entry.error && <div className="br-error">{t("brain.panel.readError", { error: entry.error })}</div>}
            {!index && !entry.error && <div className="br-muted br-pad">{t("brain.reading")}</div>}
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
                  {r.inbox && <span className="br-badge">{t("brain.panel.inboxBadge")}</span>}
                </span>
                <span className="br-row-meta">
                  {t(KIND_LABEL[r.kind])}
                  {r.tags.length > 0 && <> · {r.tags.map((tg) => `#${tg}`).join(" ")}</>}
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
  const t = useT();
  if (searching) return <div className="br-muted br-pad">{t(filtered ? "brain.panel.noMatchesFiltered" : "brain.panel.noMatches")}</div>;
  if (filtered) return <div className="br-muted br-pad">{t("brain.panel.nothingFiltered")}</div>;
  if (tab === "inbox") return <div className="br-muted br-pad">{t("brain.panel.inboxEmpty")}</div>;
  return <div className="br-muted br-pad">{t(index.exists ? "brain.panel.notesEmpty" : "brain.panel.noBrainYet")}</div>;
}

function Intro({ dir, index }: { dir: string; index: BrainIndex | null }) {
  const t = useT();
  const shown = index?.dir ?? `${dir}/.gridkeeper/brain`;
  return (
    <div className="br-intro">
      <div className="br-box-label"><span>{t("brain.intro.label")}</span></div>
      <p>{t("brain.intro.text")}</p>
      <ul className="br-steps">
        <li>{t.rich("brain.intro.read", { b: bold, mono })}</li>
        <li>{t.rich("brain.intro.suggest", { b: bold, mono })}</li>
        <li>{t.rich("brain.intro.approve", { b: bold, mono })}</li>
        <li>{t.rich("brain.intro.correct", { b: bold })}</li>
      </ul>
      <p className="br-muted">
        {t.rich("brain.intro.plainFiles", {
          path: shown,
          link: (c) => (
            <button type="button" className="link-btn mono" onClick={() => void revealPath(shown)}>
              {c}
            </button>
          ),
        })}
      </p>
      {index && index.ignored.length > 0 && (
        <p className="br-warn">{t.rich("brain.intro.ignored", { count: index.ignored.length, files: index.ignored.join(", "), mono })}</p>
      )}
    </div>
  );
}

function StatusLine({ dir, index }: { dir: string; index: BrainIndex | null }) {
  const t = useT();
  useBrain((s) => s.prefsVersion); // re-render when preferences change
  const prefs = brainPrefs(dir);
  const superseded = index?.notes.filter((n) => n.supersededBy).length ?? 0;
  return (
    <footer className="br-status" aria-label={t("brain.status.aria")}>
      <span>{t.rich("brain.panel.notesCount", { count: index?.notes.length ?? 0, b: bold })}</span>
      <span className={index?.inbox.length ? "is-attn" : ""}>{t.rich("brain.panel.inboxCount", { count: index?.inbox.length ?? 0, b: bold })}</span>
      {superseded > 0 && <span>{t.rich("brain.status.superseded", { count: superseded, b: bold })}</span>}
      <span className="br-spacer" />
      <label className="br-check" title={t("brain.status.captureTitle")}>
        <input type="checkbox" checked={prefs.capture} onChange={(e) => setBrainPrefs(dir, { capture: e.target.checked })} /> {t("brain.status.capture")}
      </label>
      <label className="br-check" title={t("brain.status.autoApproveTitle")}>
        <input type="checkbox" checked={prefs.autoApprove} onChange={(e) => setBrainPrefs(dir, { autoApprove: e.target.checked })} /> {t("brain.status.autoApprove")}
      </label>
      <label className="br-check" title={t("brain.status.briefsTitle")}>
        <input type="checkbox" checked={prefs.briefs} onChange={(e) => setBrainPrefs(dir, { briefs: e.target.checked })} /> {t("brain.status.briefs")}
      </label>
      <label className="br-check" title={t("brain.status.shareTitle")}>
        <input type="checkbox" checked={!!index?.shared} disabled={!index} onChange={(e) => void setBrainShared(dir, e.target.checked)} /> {t("brain.status.share")}
      </label>
    </footer>
  );
}
