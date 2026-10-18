// Left column of the Skills panel for Trending / Top / Search / Paste a repo. Fetches only on user action:
// opening the tab, paging, submitting a search (Rust caches answers for 10 minutes).

import { memo, useEffect, useState } from "react";
import { FEATURED_SKILL_REPOS, featuredEntry } from "../../lib/featuredSkills";
import { formatStars, minutesUntil, pageKey, parseRepoInput, relativeTime, repoKey } from "../../lib/skills";
import type { SkillRepo, SkillSort } from "../../lib/types";
import { loadPage, selectRepo, setDiscoverPage, submitSearch, useSkills, type DiscoverTab } from "../../store/skills";
import { IconSearch, IconWarn } from "../icons";
import { Button } from "../ui/Button";

function sortOf(tab: DiscoverTab, searchSort: "best" | "stars"): SkillSort {
  return tab === "search" ? searchSort : tab;
}

export function DiscoverList({ tab }: { tab: DiscoverTab }) {
  const page = useSkills((s) => s.pageByTab[tab]);
  const searchQuery = useSkills((s) => s.searchQuery);
  const searchSort = useSkills((s) => s.searchSort);
  const sort = sortOf(tab, searchSort);
  const query = tab === "search" ? searchQuery : "";
  const active = tab !== "search" || query.length > 0;
  const entry = useSkills((s) => (active ? s.pages[pageKey(sort, query, page)] : undefined));

  // Opening a tab / changing page or search is the user's request for this page.
  useEffect(() => {
    if (active) void loadPage(sort, query, page);
  }, [active, sort, query, page]);

  return (
    <div className="skills-list-wrap">
      {tab === "search" && <SearchForm initial={searchQuery} sort={searchSort} />}
      <div className="skills-list" role="list">
        {tab === "trending" && page === 1 && <FeaturedRows />}
        {!active && <div className="skills-empty">Search GitHub for skill repositories by keyword, or add your own qualifiers (topic:, user:, in:).</div>}
        {entry?.status === "loading" && <div className="skills-empty">Loading from api.github.com…</div>}
        {entry?.status === "error" && (
          <div className="skills-note is-error" role="alert">
            <IconWarn size={13} />
            <span>{entry.error}</span>
            <button type="button" className="chip" onClick={() => void loadPage(sort, query, page, true)}>
              Retry
            </button>
          </div>
        )}
        {entry?.status === "ok" && entry.data.rateLimited && (
          <div className="skills-note is-warn" role="alert">
            <IconWarn size={13} />
            <span>
              {entry.data.message ?? "GitHub's rate limit is used up."}{" "}
              {(() => {
                const m = minutesUntil(entry.data.resetAt, Date.now());
                return m ? `Try again in about ${m} minute${m === 1 ? "" : "s"}.` : "Try again in a minute.";
              })()}
            </span>
            <button type="button" className="chip" onClick={() => void loadPage(sort, query, page, true)}>
              Retry
            </button>
          </div>
        )}
        {entry?.status === "ok" && !entry.data.rateLimited && entry.data.items.length === 0 && <div className="skills-empty">No repositories found.</div>}
        {entry?.status === "ok" && tab === "trending" && page === 1 && entry.data.items.length > 0 && <div className="skills-subhead">Trending: pushed in the last 30 days</div>}
        {entry?.status === "ok" && entry.data.items.map((r) => <RepoRow key={r.fullName} repo={r} />)}
      </div>
      {entry?.status === "ok" && !entry.data.rateLimited && (
        <div className="skills-list-foot">
          <span className="skills-source" title={`Query: ${entry.data.query}`}>
            fetched from api.github.com · {ago(entry.data.fetchedAtMs)}
            {entry.data.cached ? " (cached)" : ""}
          </span>
          <span className="skills-spacer" />
          <span className="skills-count">{entry.data.total.toLocaleString()} repos</span>
          <button type="button" className="chip" disabled={page <= 1} onClick={() => setDiscoverPage(tab, page - 1)} aria-label="Previous page">
            ‹
          </button>
          <span className="skills-count">p. {page}</span>
          <button
            type="button"
            className="chip"
            disabled={entry.data.items.length < 30 || page * 30 >= Math.min(entry.data.total, 990)}
            onClick={() => setDiscoverPage(tab, page + 1)}
            aria-label="Next page"
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
}

function ago(ms: number): string {
  const mins = Math.floor(Math.max(0, Date.now() - ms) / 60_000);
  return mins < 1 ? "just now" : `${mins} min ago`;
}

function SearchForm({ initial, sort }: { initial: string; sort: "best" | "stars" }) {
  const [text, setText] = useState(initial);
  const submit = (nextSort = sort) => {
    if (text.trim()) submitSearch(text, nextSort);
  };
  return (
    <form
      className="skills-search"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="skills-search-row">
        <input
          className="input"
          data-autofocus
          placeholder="Search skills (e.g. pdf, diagram, topic:mcp)"
          value={text}
          maxLength={200}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" size="sm" icon={<IconSearch size={13} />} disabled={!text.trim()}>
          Search
        </Button>
      </div>
      <div className="segmented segmented-sm" role="radiogroup" aria-label="Sort">
        {(["best", "stars"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={sort === s}
            className={`segment${sort === s ? " is-selected" : ""}`}
            onClick={() => {
              if (text.trim()) submit(s);
              else useSkills.setState({ searchSort: s });
            }}
          >
            {s === "best" ? "Best match" : "Most stars"}
          </button>
        ))}
      </div>
    </form>
  );
}

function FeaturedRows() {
  const selectedKey = useSkills((s) => (s.selection ? repoKey(s.selection.repo, s.selection.ref) : null));
  return (
    <>
      <div className="skills-subhead">Featured (curated starting points, not verified)</div>
      {FEATURED_SKILL_REPOS.map((f) => {
        const selected = selectedKey === repoKey(f.fullName, null);
        return (
          <button
            key={f.fullName}
            type="button"
            role="listitem"
            className={`skills-row${selected ? " is-selected" : ""}`}
            aria-current={selected || undefined}
            onClick={() => selectRepo(f.fullName, null, f.skillPath ?? null)}
          >
            <span className="skills-row-head">
              <span className="skills-row-name">{f.fullName}</span>
              <span className="chip chip-accent skills-chip">featured</span>
            </span>
            <span className="skills-row-desc">{f.description}</span>
          </button>
        );
      })}
    </>
  );
}

const RepoRow = memo(function RepoRow({ repo }: { repo: SkillRepo }) {
  const selected = useSkills((s) => s.selection !== null && repoKey(s.selection.repo, s.selection.ref) === repoKey(repo.fullName, null));
  const featured = featuredEntry(repo.fullName);
  const pushed = relativeTime(repo.pushedAt, Date.now());
  return (
    <button
      type="button"
      role="listitem"
      className={`skills-row${selected ? " is-selected" : ""}`}
      aria-current={selected || undefined}
      onClick={() => selectRepo(repo.fullName, null, featured?.skillPath ?? null)}
    >
      <span className="skills-row-head">
        <span className="skills-row-name">{repo.fullName}</span>
        {featured && <span className="chip chip-accent skills-chip">featured</span>}
        <span className="skills-spacer" />
        <span className="skills-stars" title={`${repo.stars.toLocaleString()} stars`}>
          ★ {formatStars(repo.stars)}
        </span>
      </span>
      {repo.description && <span className="skills-row-desc">{repo.description}</span>}
      <span className="skills-row-meta">
        {repo.license && <span>{repo.license}</span>}
        {pushed && <span>pushed {pushed}</span>}
        {repo.archived && <span className="skills-warn-text">archived</span>}
      </span>
    </button>
  );
});

export function PasteRepo() {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const open = () => {
    const parsed = parseRepoInput(text);
    if (!parsed) {
      setError("Enter owner/repo or a github.com URL (optionally #branch, #tag or #commit).");
      return;
    }
    setError(null);
    selectRepo(parsed.repo, parsed.ref, parsed.path);
  };
  return (
    <div className="skills-list-wrap">
      <form
        className="skills-search"
        onSubmit={(e) => {
          e.preventDefault();
          open();
        }}
      >
        <div className="skills-search-row">
          <input
            className={`input mono${error ? " is-invalid" : ""}`}
            data-autofocus
            placeholder="owner/repo, github.com/owner/repo/tree/main/skills/x, owner/repo#v1.2"
            value={text}
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
            }}
          />
          <Button type="submit" size="sm" disabled={!text.trim()}>
            Open
          </Button>
        </div>
        {error && <div className="field-msg is-error">{error}</div>}
      </form>
      <div className="skills-empty">
        Any public GitHub repository with a SKILL.md works. The repository is read from api.github.com and pinned to one commit;
        nothing is installed until you review a skill and press Install.
      </div>
    </div>
  );
}
