// Read-only git Changes drawer (view.changes): for the active workspace's project folder and each
// session's worktree — branch, ahead/behind, changed files, and a unified diff of the selected file.
// Never stages, commits, checks out or resets anything.
// Refreshes on open, on the Refresh button, and when a session inside a shown repository goes idle.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pathKey, useBranchSummaries } from "../actions/handoff";
import { errorMessage, ipc, onSessionAttention } from "../lib/ipc";
import type { ChangedFile, FileDiff, RepoChanges } from "../lib/types";
import { selectActiveWorkspace, useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { IconBranch, IconClose, IconRestart } from "./icons";
import { IconButton } from "./ui/Button";
import { classifyDiffLine, defaultDiffSide, isInside, repoDirsFor, sameRoot, statusLetter, visibleRange } from "./util/changes";
import { basename } from "./util/text";
import { isOnBase } from "./mission/signoffModel";
import "../styles/signoff.css";

type Side = "unstaged" | "staged" | "untracked";
interface Selection {
  root: string;
  file: ChangedFile;
  side: Side;
}

export function ChangesDrawer() {
  const close = () => useUi.getState().setChangesOpen(false);
  const wsId = useApp((s) => selectActiveWorkspace(s)?.id);
  const dirsKey = useApp((s) => repoDirsFor(selectActiveWorkspace(s), s.persisted.sessions).join("\u0000"));
  const dirs = useMemo(() => (dirsKey ? dirsKey.split("\u0000") : []), [dirsKey]);
  const [repos, setRepos] = useState<RepoChanges[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const reposRef = useRef(repos);
  reposRef.current = repos;
  // Focus (Mission Control "review diff"): the repository holding that worktree / folder.
  const focus = useUi((s) => s.changesFocus);
  const focusRoot = useMemo(() => {
    if (!focus) return null;
    let best: string | null = null;
    for (const r of repos) if (r.root && isInside(r.root, focus) && (!best || r.root.length > best.length)) best = r.root;
    return best;
  }, [focus, repos]);
  const appliedFocus = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const results = await Promise.all(dirs.map((d) => ipc.gitChanges(d).catch((e) => ({ error: errorMessage(e) }))));
      const out: RepoChanges[] = [];
      const errors: string[] = [];
      for (const r of results) {
        if ("error" in r) errors.push(r.error);
        else if (r.isRepo && !out.some((x) => sameRoot(x.root, r.root))) out.push(r);
      }
      setRepos(out);
      setError(errors.length ? errors[0] : null);
    } finally {
      setBusy(false);
    }
  }, [dirs]);

  useEffect(() => {
    void refresh();
  }, [refresh, wsId]);

  // A session inside one of these repositories finished a run: refresh (debounced).
  useEffect(() => {
    let timer: number | undefined;
    let off: (() => void) | undefined;
    let disposed = false;
    void onSessionAttention((ev) => {
      if (ev.kind !== "idle") return;
      const meta = useApp.getState().persisted.sessions.find((m) => m.id === ev.id);
      if (!meta || !reposRef.current.some((r) => r.root && isInside(r.root, meta.cwd))) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), 1200);
    }).then((u) => (disposed ? u() : (off = u)));
    return () => {
      disposed = true;
      off?.();
      window.clearTimeout(timer);
    };
  }, [refresh]);

  // Once per focus request: select the focused repository's first changed file (its section scrolls into
  // view and expands itself).
  useEffect(() => {
    if (!focus) {
      appliedFocus.current = null;
      return;
    }
    if (!focusRoot || appliedFocus.current === focus) return;
    appliedFocus.current = focus;
    const r = repos.find((x) => sameRoot(x.root, focusRoot));
    const f = r?.files[0];
    if (r?.root && f) setSel({ root: r.root, file: f, side: defaultDiffSide(f) });
  }, [focus, focusRoot, repos]);

  // Drop the selection when its file is no longer listed.
  useEffect(() => {
    if (!sel) return;
    const r = repos.find((x) => sameRoot(x.root, sel.root));
    if (!r || !r.files.some((f) => f.path === sel.file.path)) setSel(null);
  }, [repos, sel]);

  return (
    <aside className="changes-drawer" aria-label="Changes (read-only)">
      <div className="inspector-head">
        <span className="panel-title">Changes</span>
        <span className="changes-ro" title="This panel never stages, commits, checks out or resets">read-only</span>
        <span className="changes-spacer" />
        <IconButton size="sm" label="Refresh" onClick={() => void refresh()} disabled={busy}>
          <IconRestart size={13} />
        </IconButton>
        <IconButton size="sm" label="Close changes" onClick={close}>
          <IconClose size={13} />
        </IconButton>
      </div>
      <div className="changes-list">
        {dirs.length === 0 && <div className="inspector-empty">Set a project folder for this workspace to see its changes.</div>}
        {error && <div className="callout is-error">{error}</div>}
        {!busy && dirs.length > 0 && repos.length === 0 && !error && <div className="inspector-empty">No git repository in this workspace’s folders.</div>}
        {repos.map((r) => (
          <RepoSection key={r.root} repo={r} sel={sel} onSelect={setSel} focus={sameRoot(r.root, focusRoot) ? focus : null} />
        ))}
      </div>
      {sel && <DiffViewer key={`${sel.root}|${sel.file.path}|${sel.side}`} sel={sel} onSide={(side) => setSel({ ...sel, side })} />}
    </aside>
  );
}

const RepoSection = memo(function RepoSection({
  repo,
  sel,
  onSelect,
  focus,
}: {
  repo: RepoChanges;
  sel: Selection | null;
  onSelect: (s: Selection) => void;
  /** The focused worktree / folder inside this repository, when this is the focused one. */
  focus: string | null;
}) {
  const [open, setOpen] = useState(true);
  const root = repo.root ?? "";
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [focus]);
  // Committed work is not in `git status`: say so, from the sign-off's cached branch summary.
  const summary = useBranchSummaries((s) => (focus ? (s.byPath[pathKey(focus)]?.summary ?? null) : null));
  const committed = summary?.isRepo && summary.base && summary.ahead > 0 && !isOnBase(summary) ? summary : null;
  return (
    <section ref={ref} className={`changes-repo${focus ? " is-focus" : ""}`}>
      <button type="button" className="changes-repo-head" onClick={() => setOpen(!open)} title={root}>
        <span className="changes-caret">{open ? "▾" : "▸"}</span>
        <span className="changes-repo-name">{basename(root)}</span>
        <span className="changes-branch mono">
          <IconBranch size={11} /> {repo.branch ?? "detached"}
        </span>
        {(repo.ahead > 0 || repo.behind > 0) && (
          <span className="changes-ab mono" title={repo.upstream ? `vs ${repo.upstream}` : undefined}>
            ↑{repo.ahead} ↓{repo.behind}
          </span>
        )}
        <span className="changes-count">{repo.files.length}{repo.truncated ? "+" : ""}</span>
      </button>
      {open && committed && (
        <div className="changes-committed mono" title="This panel lists uncommitted changes only">
          {`Committed work, not listed below: ${committed.ahead} commit${committed.ahead === 1 ? "" : "s"} on ${committed.branch ?? "HEAD"} not on ${committed.base} (${committed.filesChanged} file${committed.filesChanged === 1 ? "" : "s"} +${committed.insertions} −${committed.deletions}). Review with `}
          <code>{`git -C "${root}" diff ${committed.base}...${committed.branch ?? "HEAD"}`}</code>
        </div>
      )}
      {open && (
        <ul className="changes-files">
          {repo.files.length === 0 && <li className="changes-clean">Working tree clean</li>}
          {repo.files.map((f) => {
            const active = !!sel && sameRoot(sel.root, root) && sel.file.path === f.path;
            const letter = statusLetter(f);
            return (
              <li key={f.path}>
                <button
                  type="button"
                  className={`changes-file${active ? " is-active" : ""}`}
                  title={`${f.origPath ? `${f.origPath} → ` : ""}${f.path}\nindex ${f.index} · work tree ${f.worktree}`}
                  onClick={() => onSelect({ root, file: f, side: defaultDiffSide(f) })}
                >
                  <span className={`changes-letter is-${letter === "?" ? "new" : letter.toLowerCase()}`}>{letter}</span>
                  <span className="changes-path mono">{f.path}</span>
                  {f.index !== "." && f.kind !== "untracked" && <span className="changes-staged" title="Has staged changes">S</span>}
                </button>
              </li>
            );
          })}
          {repo.truncated && <li className="changes-clean">List cut at 5000 entries</li>}
        </ul>
      )}
    </section>
  );
});

const ROW_H = 17;

function DiffViewer({ sel, onSide }: { sel: Selection; onSide: (s: Side) => void }) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 300 });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    ipc
      .gitDiff(sel.root, sel.file.path, sel.side === "staged", sel.side === "untracked")
      .then((d) => !cancelled && setDiff(d))
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [sel]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScroll((s) => ({ ...s, height: el.clientHeight })));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lines = useMemo(() => (diff ? diff.text.replace(/\n$/, "").split("\n") : []), [diff]);
  const [first, last] = visibleRange(scroll.top, scroll.height, ROW_H, lines.length);
  const f = sel.file;
  const hasStaged = f.kind !== "untracked" && f.index !== ".";
  const hasUnstaged = f.kind !== "untracked" && f.worktree !== ".";

  return (
    <div className="changes-diff">
      <div className="changes-diff-head">
        <span className="changes-path mono" title={f.path}>
          {f.path}
        </span>
        {f.kind !== "untracked" && (
          <span className="changes-sides">
            <button type="button" className={sel.side === "unstaged" ? "is-active" : ""} disabled={!hasUnstaged} onClick={() => onSide("unstaged")}>
              Unstaged
            </button>
            <button type="button" className={sel.side === "staged" ? "is-active" : ""} disabled={!hasStaged} onClick={() => onSide("staged")}>
              Staged
            </button>
          </span>
        )}
      </div>
      <div ref={ref} className="changes-diff-body mono" onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
        {error && <div className="callout is-error">{error}</div>}
        {!diff && !error && <div className="inspector-empty">Loading diff…</div>}
        {diff?.binary && <div className="inspector-empty">Binary file — no text diff.</div>}
        {diff && !diff.binary && lines.length === 0 && <div className="inspector-empty">No differences on this side.</div>}
        {diff && !diff.binary && lines.length > 0 && (
          <div style={{ height: lines.length * ROW_H, position: "relative" }}>
            <div style={{ position: "absolute", top: first * ROW_H, left: 0, right: 0 }}>
              {lines.slice(first, last).map((l, i) => (
                <div key={first + i} className={`diff-line is-${classifyDiffLine(l)}`} style={{ height: ROW_H }}>
                  {l || " "}
                </div>
              ))}
            </div>
          </div>
        )}
        {diff?.truncated && <div className="callout">Diff cut at 2 MB.</div>}
      </div>
    </div>
  );
}
