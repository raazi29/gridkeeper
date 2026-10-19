// Left column of the Skills panel for Trending / Top / Search / Paste a repo. Fetches only on user action:
// opening the tab, paging, submitting a search (Rust caches answers for 10 minutes).

import { memo, useEffect, useState } from "react";
import { t as translate, useT } from "../../i18n";
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
  const t = useT();
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
        {!active && <div className="skills-empty">{t("skills.searchEmpty")}</div>}
        {entry?.status === "loading" && <div className="skills-empty">{t("skills.loadingGithub")}</div>}
        {entry?.status === "error" && (
          <div className="skills-note is-error" role="alert">
            <IconWarn size={13} />
            <span>{entry.error}</span>
            <button type="button" className="chip" onClick={() => void loadPage(sort, query, page, true)}>
              {t("common.retry")}
            </button>
          </div>
        )}
        {entry?.status === "ok" && entry.data.rateLimited && (
          <div className="skills-note is-warn" role="alert">
            <IconWarn size={13} />
            <span>
              {entry.data.message ?? t("skills.rateLimited")}{" "}
              {(() => {
                const m = minutesUntil(entry.data.resetAt, Date.now());
                return m ? t("skills.tryAgainIn", { minutes: m }) : t("skills.tryAgainSoon");
              })()}
            </span>
            <button type="button" className="chip" onClick={() => void loadPage(sort, query, page, true)}>
              {t("common.retry")}
            </button>
          </div>
        )}
        {entry?.status === "ok" && !entry.data.rateLimited && entry.data.items.length === 0 && <div className="skills-empty">{t("skills.noRepos")}</div>}
        {entry?.status === "ok" && tab === "trending" && page === 1 && entry.data.items.length > 0 && <div className="skills-subhead">{t("skills.trendingHead")}</div>}
        {entry?.status === "ok" && entry.data.items.map((r) => <RepoRow key={r.fullName} repo={r} />)}
      </div>
      {entry?.status === "ok" && !entry.data.rateLimited && (
        <div className="skills-list-foot">
          <span className="skills-source" title={t("skills.queryTitle", { query: entry.data.query })}>
            {entry.data.cached ? t("skills.fetchedCached", { ago: ago(entry.data.fetchedAtMs) }) : t("skills.fetched", { ago: ago(entry.data.fetchedAtMs) })}
          </span>
          <span className="skills-spacer" />
          <span className="skills-count">{t("skills.repoCount", { count: entry.data.total })}</span>
          <button type="button" className="chip" disabled={page <= 1} onClick={() => setDiscoverPage(tab, page - 1)} aria-label={t("skills.prevPage")}>
            ‹
          </button>
          <span className="skills-count">{t("skills.pageN", { page })}</span>
          <button
            type="button"
            className="chip"
            disabled={entry.data.items.length < 30 || page * 30 >= Math.min(entry.data.total, 990)}
            onClick={() => setDiscoverPage(tab, page + 1)}
            aria-label={t("skills.nextPage")}
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
  return mins < 1 ? translate("skills.justNow") : translate("skills.minAgo", { minutes: mins });
}

function SearchForm({ initial, sort }: { initial: string; sort: "best" | "stars" }) {
  const t = useT();
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
          placeholder={t("skills.searchPlaceholder")}
          value={text}
          maxLength={200}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" size="sm" icon={<IconSearch size={13} />} disabled={!text.trim()}>
          {t("skills.searchButton")}
        </Button>
      </div>
      <div className="segmented segmented-sm" role="radiogroup" aria-label={t("skills.sortAria")}>
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
            {s === "best" ? t("skills.sortBest") : t("skills.sortStars")}
          </button>
        ))}
      </div>
    </form>
  );
}

function FeaturedRows() {
  const t = useT();
  const selectedKey = useSkills((s) => (s.selection ? repoKey(s.selection.repo, s.selection.ref) : null));
  return (
    <>
      <div className="skills-subhead">{t("skills.featuredHead")}</div>
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
              <span className="chip chip-accent skills-chip">{t("skills.featuredChip")}</span>
            </span>
            <span className="skills-row-desc">{f.description}</span>
          </button>
        );
      })}
    </>
  );
}

const RepoRow = memo(function RepoRow({ repo }: { repo: SkillRepo }) {
  const t = useT();
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
        {featured && <span className="chip chip-accent skills-chip">{t("skills.featuredChip")}</span>}
        <span className="skills-spacer" />
        <span className="skills-stars" title={t("skills.starsTitle", { count: repo.stars })}>
          ★ {formatStars(repo.stars)}
        </span>
      </span>
      {repo.description && <span className="skills-row-desc">{repo.description}</span>}
      <span className="skills-row-meta">
        {repo.license && <span>{repo.license}</span>}
        {pushed && <span>{t("skills.pushed", { when: pushed })}</span>}
        {repo.archived && <span className="skills-warn-text">{t("skills.archived")}</span>}
      </span>
    </button>
  );
});

export function PasteRepo() {
  const t = useT();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const open = () => {
    const parsed = parseRepoInput(text);
    if (!parsed) {
      setError(t("skills.pasteInvalid"));
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
            {t("common.open")}
          </Button>
        </div>
        {error && <div className="field-msg is-error">{error}</div>}
      </form>
      <div className="skills-empty">{t("skills.pasteExplain")}</div>
    </div>
  );
}
