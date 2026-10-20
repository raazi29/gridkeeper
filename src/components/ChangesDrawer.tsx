// Read-only git Changes drawer (view.changes): for the active workspace's project folder and each
// session's worktree — branch, ahead/behind, uncommitted files, the files committed on the branch since it
// left its base (the main worktree's branch), and a unified diff of the selected file.
// Never stages, commits, checks out or resets anything.
// Refreshes on open (and on a new focus request), on the Refresh button, and when a session inside a shown
// repository goes idle. No polling.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { errorMessage, ipc, onSessionAttention } from "../lib/ipc";
import type { BranchFile, BranchFiles, ChangedFile, FileDiff, RepoChanges } from "../lib/types";
import { selectActiveWorkspace, useApp } from "../store/appStore";
import { useUi } from "../store/uiStore";
import { IconBranch, IconClose, IconRestart } from "./icons";
import { IconButton } from "./ui/Button";
import {
  branchDiffCommand,
  branchFileLetter,
  branchTotals,
  classifyDiffLine,
  committedHeading,
  defaultDiffSide,
  focusPick,
  hasCommittedWork,
  isInside,
  letterClass,
  repoDirsFor,
  rootKey,
  sameRoot,
  statusLetter,
  visibleRange,
} from "./util/changes";
import { basename } from "./util/text";
import "../styles/signoff.css";

type Side = "unstaged" | "staged" | "untracked";
/** An uncommitted file (git status) or a file committed on the branch since `base` (base...HEAD). */
type Selection =
  | { kind: "status"; root: string; file: ChangedFile; side: Side }
  | { kind: "branch"; root: string; file: BranchFile; base: string; branch: string | null };

/** Committed-file lists by `rootKey(root)`; `null` = the fetch failed. A missing key = not loaded yet. */
type BranchMap = Record<string, BranchFiles | null>;

function selKey(s: Selection): string {
  return s.kind === "status" ? `s|${s.root}|${s.file.path}|${s.side}` : `b|${s.root}|${s.base}|${s.file.path}`;
}

export function ChangesDrawer() {
  const t = useT();
  const close = () => useUi.getState().setChangesOpen(false);
  const wsId = useApp((s) => selectActiveWorkspace(s)?.id);
  const dirsKey = useApp((s) => repoDirsFor(selectActiveWorkspace(s), s.persisted.sessions).join("\u0000"));
  const dirs = useMemo(() => (dirsKey ? dirsKey.split("\u0000") : []), [dirsKey]);
  const [repos, setRepos] = useState<RepoChanges[]>([]);
  const [branches, setBranches] = useState<BranchMap>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Selection | null>(null);
  const reposRef = useRef(repos);
  reposRef.current = repos;
  const generation = useRef(0);
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
    const gen = ++generation.current;
    setBusy(true);
    setError(null);
    try {
      const results = await Promise.all(dirs.map((d) => ipc.gitChanges(d).catch((e) => ({ error: errorMessage(e) }))));
      if (gen !== generation.current) return;
      const out: RepoChanges[] = [];
      const errors: string[] = [];
      for (const r of results) {
        if ("error" in r) errors.push(r.error);
        else if (r.isRepo && !out.some((x) => sameRoot(x.root, r.root))) out.push(r);
      }
      setRepos(out);
      setError(errors.length ? errors[0] : null);
      // Committed work per repository (second stage, so uncommitted files show first).
      const lists = await Promise.all(
        out.map((r) =>
          r.root
            ? ipc.gitBranchFiles(r.root, null).catch((e) => {
                errors.push(errorMessage(e));
                return null;
              })
            : Promise.resolve(null),
        ),
      );
      if (gen !== generation.current) return;
      const next: BranchMap = {};
      out.forEach((r, i) => {
        if (r.root) next[rootKey(r.root)] = lists[i];
      });
      setBranches(next);
      setError(errors.length ? errors[0] : null);
    } finally {
      if (gen === generation.current) setBusy(false);
    }
  }, [dirs]);

  // On open, workspace switch and each new focus request (sign-off "review diff" while already open).
  useEffect(() => {
    void refresh();
  }, [refresh, wsId, focus]);

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

  // Once per focus request: select the focused repository's first uncommitted file, else its first committed
  // file (waits for the committed list); its section scrolls into view and expands itself.
  useEffect(() => {
    if (!focus) {
      appliedFocus.current = null;
      return;
    }
    if (!focusRoot || appliedFocus.current === focus) return;
    const r = repos.find((x) => sameRoot(x.root, focusRoot));
    if (!r?.root) return;
    const pick = focusPick(r.files, branches[rootKey(r.root)]);
    if (pick === undefined) return;
    appliedFocus.current = focus;
    if (pick?.kind === "status") setSel({ kind: "status", root: r.root, file: pick.file, side: defaultDiffSide(pick.file) });
    else if (pick?.kind === "branch") setSel({ kind: "branch", root: r.root, file: pick.file, base: pick.base, branch: pick.branch });
  }, [focus, focusRoot, repos, branches]);

  // Drop the selection when its file is no longer listed.
  useEffect(() => {
    if (!sel) return;
    const r = repos.find((x) => sameRoot(x.root, sel.root));
    if (!r) {
      setSel(null);
      return;
    }
    if (sel.kind === "status") {
      if (!r.files.some((f) => f.path === sel.file.path)) setSel(null);
      return;
    }
    const b = branches[rootKey(sel.root)];
    if (b === undefined) return; // not loaded yet
    if (!hasCommittedWork(b) || b.base !== sel.base || !b.files.some((f) => f.path === sel.file.path)) setSel(null);
  }, [repos, branches, sel]);

  return (
    <aside className="changes-drawer" aria-label={t("changes.aria")}>
      <div className="inspector-head">
        <span className="panel-title">{t("changes.title")}</span>
        <span className="changes-ro" title={t("changes.readOnlyTitle")}>
          {t("changes.readOnly")}
        </span>
        <span className="changes-spacer" />
        <IconButton size="sm" label={t("common.refresh")} onClick={() => void refresh()} disabled={busy}>
          <IconRestart size={13} />
        </IconButton>
        <IconButton size="sm" label={t("changes.close")} onClick={close}>
          <IconClose size={13} />
        </IconButton>
      </div>
      <div className="changes-list">
        {dirs.length === 0 && <div className="inspector-empty">{t("changes.noFolder")}</div>}
        {error && <div className="callout is-error">{error}</div>}
        {!busy && dirs.length > 0 && repos.length === 0 && !error && <div className="inspector-empty">{t("changes.noRepo")}</div>}
        {repos.map((r) => (
          <RepoSection
            key={r.root}
            repo={r}
            branch={r.root ? branches[rootKey(r.root)] : undefined}
            sel={sel}
            onSelect={setSel}
            focus={sameRoot(r.root, focusRoot) ? focus : null}
          />
        ))}
      </div>
      {sel && <DiffViewer key={selKey(sel)} sel={sel} onSide={(side) => sel.kind === "status" && setSel({ ...sel, side })} />}
    </aside>
  );
}

const RepoSection = memo(function RepoSection({
  repo,
  branch,
  sel,
  onSelect,
  focus,
}: {
  repo: RepoChanges;
  /** Committed work vs the base (undefined while loading, null when the fetch failed). */
  branch: BranchFiles | null | undefined;
  sel: Selection | null;
  onSelect: (s: Selection) => void;
  /** The focused worktree / folder inside this repository, when this is the focused one. */
  focus: string | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const root = repo.root ?? "";
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focus) return;
    setOpen(true);
    ref.current?.scrollIntoView({ block: "nearest" });
  }, [focus]);
  const committed = hasCommittedWork(branch) ? branch : null;
  return (
    <section ref={ref} className={`changes-repo${focus ? " is-focus" : ""}`}>
      <button type="button" className="changes-repo-head" onClick={() => setOpen(!open)} title={root}>
        <span className="changes-caret">{open ? "▾" : "▸"}</span>
        <span className="changes-repo-name">{basename(root)}</span>
        <span className="changes-branch mono">
          <IconBranch size={11} /> {repo.branch ?? t("changes.detached")}
        </span>
        {(repo.ahead > 0 || repo.behind > 0) && (
          <span className="changes-ab mono" title={repo.upstream ? t("changes.vsUpstream", { upstream: repo.upstream }) : undefined}>
            ↑{repo.ahead} ↓{repo.behind}
          </span>
        )}
        <span className="changes-count" title={t("changes.uncommittedTitle")}>
          {repo.files.length}
          {repo.truncated ? "+" : ""}
        </span>
      </button>
      {open && committed && (
        <div className="changes-sub-head is-static">{t("changes.uncommittedHeading", { count: `${repo.files.length}${repo.truncated ? "+" : ""}` })}</div>
      )}
      {open && (
        <ul className="changes-files">
          {repo.files.length === 0 && <li className="changes-clean">{t("changes.clean")}</li>}
          {repo.files.map((f) => {
            const active = sel?.kind === "status" && sameRoot(sel.root, root) && sel.file.path === f.path;
            const letter = statusLetter(f);
            return (
              <li key={f.path}>
                <button
                  type="button"
                  className={`changes-file${active ? " is-active" : ""}`}
                  title={t("changes.fileTitle", { path: `${f.origPath ? `${f.origPath} → ` : ""}${f.path}`, index: f.index, worktree: f.worktree })}
                  onClick={() => onSelect({ kind: "status", root, file: f, side: defaultDiffSide(f) })}
                >
                  <span className={`changes-letter is-${letterClass(letter)}`}>{letter}</span>
                  <span className="changes-path mono">{f.path}</span>
                  {f.index !== "." && f.kind !== "untracked" && (
                    <span className="changes-staged" title={t("changes.stagedTitle")}>
                      S
                    </span>
                  )}
                </button>
              </li>
            );
          })}
          {repo.truncated && <li className="changes-clean">{t("changes.truncatedStatus")}</li>}
        </ul>
      )}
      {open && committed && <CommittedFiles root={root} list={committed} sel={sel} onSelect={onSelect} />}
    </section>
  );
});

/** "committed on <branch> vs <base> (N files)": what the branch's commits changed (base...HEAD). */
function CommittedFiles({
  root,
  list,
  sel,
  onSelect,
}: {
  root: string;
  list: BranchFiles & { base: string };
  sel: Selection | null;
  onSelect: (s: Selection) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const totals = useMemo(() => branchTotals(list.files), [list.files]);
  const commits = t("changes.commits", { count: list.ahead });
  return (
    <div className="changes-committed-files">
      <button
        type="button"
        className="changes-sub-head"
        onClick={() => setOpen(!open)}
        title={t("changes.committedTitle", { count: list.ahead, branch: list.branch ?? "HEAD", base: list.base })}
      >
        <span className="changes-caret">{open ? "▾" : "▸"}</span>
        <span className="changes-sub-title">{committedHeading(list)}</span>
        <span className="changes-sub-meta mono">
          {commits} · <span className="is-add">+{totals.insertions}</span> <span className="is-del">−{totals.deletions}</span>
        </span>
      </button>
      {open && (
        <ul className="changes-files">
          {list.files.length === 0 && <li className="changes-clean">{t("changes.noFileDiffs")}</li>}
          {list.files.map((f) => {
            const active = sel?.kind === "branch" && sameRoot(sel.root, root) && sel.file.path === f.path;
            const letter = branchFileLetter(f);
            return (
              <li key={f.path}>
                <button
                  type="button"
                  className={`changes-file${active ? " is-active" : ""}`}
                  title={t("changes.committedFileTitle", { path: `${f.origPath ? `${f.origPath} → ` : ""}${f.path}`, branch: list.branch ?? "HEAD", base: list.base })}
                  onClick={() => onSelect({ kind: "branch", root, file: f, base: list.base, branch: list.branch })}
                >
                  <span className={`changes-letter is-${letterClass(letter)}`}>{letter}</span>
                  <span className="changes-path mono">{f.path}</span>
                  <span className="changes-nums mono">
                    {f.binary ? (
                      <span className="is-bin">{t("changes.binaryShort")}</span>
                    ) : (
                      <>
                        <span className="is-add">+{f.insertions}</span> <span className="is-del">−{f.deletions}</span>
                      </>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
          {list.truncated && <li className="changes-clean">{t("changes.truncatedBranch")}</li>}
          <li className="changes-hint">
            {t.rich("changes.terminalHint", { command: branchDiffCommand(root, list.base, list.branch), code: (c) => <code className="mono">{c}</code> })}
          </li>
        </ul>
      )}
    </div>
  );
}

const ROW_H = 17;

function DiffViewer({ sel, onSide }: { sel: Selection; onSide: (s: Side) => void }) {
  const t = useT();
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 300 });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    const req =
      sel.kind === "branch"
        ? ipc.gitBranchFileDiff(sel.root, sel.base, sel.file.path, sel.file.origPath)
        : ipc.gitDiff(sel.root, sel.file.path, sel.side === "staged", sel.side === "untracked");
    req.then((d) => !cancelled && setDiff(d)).catch((e) => !cancelled && setError(errorMessage(e)));
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
  const path = sel.file.path;
  const orig = sel.file.origPath;

  return (
    <div className="changes-diff">
      <div className="changes-diff-head">
        <span className="changes-path mono" title={orig ? `${orig} → ${path}` : path}>
          {path}
        </span>
        {sel.kind === "branch" ? (
          <span className="changes-range mono" title={t("changes.rangeTitle", { branch: sel.branch ?? "HEAD", base: sel.base })}>
            {t("changes.range", { branch: sel.branch ?? "HEAD", base: sel.base })}
          </span>
        ) : (
          sel.file.kind !== "untracked" && (
            <span className="changes-sides">
              <button
                type="button"
                className={sel.side === "unstaged" ? "is-active" : ""}
                disabled={sel.file.worktree === "."}
                onClick={() => onSide("unstaged")}
              >
                {t("changes.unstaged")}
              </button>
              <button type="button" className={sel.side === "staged" ? "is-active" : ""} disabled={sel.file.index === "."} onClick={() => onSide("staged")}>
                {t("changes.staged")}
              </button>
            </span>
          )
        )}
      </div>
      <div ref={ref} className="changes-diff-body mono" onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}>
        {error && <div className="callout is-error">{error}</div>}
        {!diff && !error && <div className="inspector-empty">{t("changes.loadingDiff")}</div>}
        {diff?.binary && <div className="inspector-empty">{t("changes.binary")}</div>}
        {diff && !diff.binary && lines.length === 0 && (
          <div className="inspector-empty">{sel.kind === "branch" ? t("changes.noDiff") : t("changes.noDiffSide")}</div>
        )}
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
        {diff?.truncated && <div className="callout">{t("changes.diffTruncated")}</div>}
      </div>
    </div>
  );
}
