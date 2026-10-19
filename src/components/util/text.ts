// Pure UI helpers (no DOM / store imports) — unit-tested in node.

/**
 * Split a command-line string into arguments, respecting "double" and 'single' quotes.
 * Backslash escapes a quote inside double quotes only (Windows paths keep their backslashes).
 */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && input[i + 1] === '"') {
        cur += '"';
        i++;
      } else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/**
 * Subsequence fuzzy score. Returns null when `query` is not a subsequence of `text`.
 * Higher is better: rewards consecutive runs, word-start hits and early matches.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  let score = 0;
  let ti = 0;
  let run = 0;
  let first = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === " ") continue;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === ch) {
        found = ti;
        break;
      }
      ti++;
    }
    if (found < 0) return null;
    if (first < 0) first = found;
    const prev = found > 0 ? text[found - 1] : " ";
    const wordStart = found === 0 || /[\s\-_/\\.:›>]/.test(prev) || (prev === prev.toLowerCase() && text[found] !== text[found].toLowerCase());
    run = found === ti && qi > 0 && t[found - 1] === q[qi - 1] ? run + 1 : 0;
    score += 1 + run * 3 + (wordStart ? 4 : 0);
    ti = found + 1;
  }
  if (direct >= 0) score += 10 + (direct === 0 ? 8 : 0);
  score -= Math.min(first, 20) * 0.2;
  score -= (t.length - q.length) * 0.01;
  return score;
}

/** Filter + sort items by fuzzy score on `key(item)`; stable for equal scores. */
export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string): T[] {
  if (!query.trim()) return items;
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    const s = fuzzyScore(query, key(item));
    if (s !== null) scored.push({ item, score: s, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.map((x) => x.item);
}

/** Last path component of a Windows or POSIX path. */
export function basename(p: string | null | undefined): string {
  if (!p) return "";
  const trimmed = p.replace(/[\\/]+$/, "");
  const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return i >= 0 ? trimmed.slice(i + 1) || trimmed : trimmed;
}

/** Join a child onto a base path using the separator already present in `base`. */
export function joinPath(base: string, child: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  return base.replace(/[\\/]+$/, "") + sep + child.replace(/^[\\/]+/, "");
}

/** Default worktree location: `<repo>-worktrees/<branch>` with branch slashes flattened. */
export function defaultWorktreePath(repoRoot: string, branch: string): string {
  const root = repoRoot.replace(/[\\/]+$/, "");
  const safe = branch.trim().replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
  return joinPath(`${root}-worktrees`, safe);
}

/** Loose validity check for a git branch name (mirrors the common `git check-ref-format` rules). */
export function isValidBranchName(b: string): boolean {
  const s = b.trim();
  if (!s || s.startsWith("-") || s.startsWith("/") || s.endsWith("/") || s.endsWith(".") || s.endsWith(".lock")) return false;
  if (/\.\.|@\{|\/\/|[\s~^:?*\[\\\x00-\x1f\x7f]/.test(s)) return false;
  return s !== "@";
}

/** Initials for the collapsed rail ("api server" -> "AS", "frontend" -> "FR"). */
export function initials(name: string): string {
  const words = name.trim().split(/[\s\-_.]+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// ---- number / resource formatting --------------------------------------------

/** Task-Manager style CPU percent: per-core sum divided by logical cores, clamped to 0..100. */
export function taskManagerCpu(cpuPercentSum: number, logicalCores: number): number {
  const cores = logicalCores > 0 ? logicalCores : 1;
  const v = cpuPercentSum / cores;
  if (!Number.isFinite(v) || v < 0) return 0;
  return Math.min(100, v);
}

export function formatCpu(pct: number): string {
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
}

export function formatMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 10240) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return sameDay ? time : `${d.toLocaleDateString()} ${time}`;
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * A long path shortened in the middle, keeping the root and the last folders whole:
 * "C:\Users\me\AppData\Local\Temp\demo\oauth-app" → "C:\…\demo\oauth-app". Never cuts a folder name;
 * a path that already fits (or has too few parts) comes back unchanged. `max` counts characters.
 */
export function shortPath(p: string, max = 32): string {
  if (p.length <= max) return p;
  const sep = p.includes("\\") ? "\\" : "/";
  const parts = p.split(sep);
  if (parts.length <= 3) return p;
  const head = parts[0] === "" ? sep : parts[0] + sep; // "C:\" or "/" (POSIX root)
  const tail: string[] = [parts[parts.length - 1]];
  for (let i = parts.length - 2; i > 0; i--) {
    const next = `${head}…${sep}${[parts[i], ...tail].join(sep)}`;
    if (next.length > max) break;
    tail.unshift(parts[i]);
  }
  return `${head}…${sep}${tail.join(sep)}`;
}

/** Elapsed time as a short label: "42s", "3m 05s", "2h 14m", "3d 4h". */
export function formatSince(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
