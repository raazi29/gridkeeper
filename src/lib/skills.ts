// Pure helpers for the Skills panel (Agent Skills from GitHub, installed into a project). No store, no IPC.

import { t } from "../i18n";
import type { AgentKind, InstalledSkill, SkillFile, SkillTarget } from "./types";

/** Install targets with the agents that read them (`hosts` follows the UI language: a getter). */
export const SKILL_TARGETS: readonly { id: SkillTarget; readonly hosts: string }[] = [
  { id: ".claude/skills", hosts: "Claude Code" },
  {
    id: ".agents/skills",
    get hosts() {
      return t("skills.targetHostsAgents");
    },
  },
];

/** Same rule as the Rust side (`skills::validate_repo`). */
export const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** Branch / tag / SHA, same rule as `skills::validate_ref`. */
export function isValidRef(r: string): boolean {
  return (
    r.length > 0 &&
    r.length <= 200 &&
    /^[A-Za-z0-9._/-]+$/.test(r) &&
    !/^[-/.]/.test(r) &&
    !/[/.]$/.test(r) &&
    !r.includes("..") &&
    !r.includes("//") &&
    !r.includes("/.")
  );
}

export interface RepoInput {
  /** `owner/name`. */
  repo: string;
  ref: string | null;
  /** Skill folder hinted by a `/tree/<ref>/<path>` URL. */
  path: string | null;
}

/**
 * "owner/repo", "owner/repo#ref", "https://github.com/owner/repo(.git)", ".../tree/<ref>/<path>",
 * ".../blob/<ref>/<path>/SKILL.md", "git@github.com:owner/repo.git". null when it is none of these.
 * (A branch name with slashes in a /tree/ URL is ambiguous: use "owner/repo#feature/x" for those.)
 */
export function parseRepoInput(input: string): RepoInput | null {
  let s = input.trim();
  if (!s) return null;
  let ref: string | null = null;
  const hash = s.indexOf("#");
  if (hash >= 0) {
    ref = s.slice(hash + 1).trim() || null;
    s = s.slice(0, hash);
  }
  s = s
    .replace(/^git@github\.com:/i, "")
    .replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "")
    .replace(/[?].*$/, "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return null; // another host / scheme
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const repo = `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`;
  if (!REPO_RE.test(repo) || repo.endsWith("/.") || repo.endsWith("/..")) return null;
  let path: string | null = null;
  if ((parts[2] === "tree" || parts[2] === "blob") && parts[3]) {
    ref = ref ?? decodeURIComponent(parts[3]);
    const rest = parts.slice(4).map((p) => decodeURIComponent(p));
    if (rest.length && /^skill\.md$/i.test(rest[rest.length - 1])) rest.pop();
    path = rest.length ? rest.join("/") : null;
  }
  if (ref !== null && !isValidRef(ref)) return null;
  return { repo, ref, path };
}

/** Extensions shown with an "executable" warning (mirrors `skills::EXECUTABLE_EXTS`). */
export const EXECUTABLE_EXTS = new Set([
  "ps1", "psm1", "psd1", "sh", "bash", "zsh", "bat", "cmd", "exe", "com", "dll", "msi", "scr", "vbs", "js", "mjs",
  "cjs", "ts", "py", "rb", "pl", "php", "jar", "lua",
]);

export function isExecutablePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && EXECUTABLE_EXTS.has(name.slice(dot + 1).toLowerCase());
}

/** Files the review warns about: scripts/ and executable-looking files. */
export function riskyFiles(files: readonly SkillFile[]): SkillFile[] {
  return files.filter((f) => f.executable || f.path.startsWith("scripts/") || isExecutablePath(f.path));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.ceil(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatStars(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** "today", "yesterday", "5 days ago", "3 months ago", "2 years ago"; "" for missing / bad input. */
export function relativeTime(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const days = Math.floor(Math.max(0, nowMs - at) / 86_400_000);
  if (days < 1) return t("skills.time.today");
  if (days === 1) return t("skills.time.yesterday");
  if (days < 30) return t("skills.time.daysAgo", { count: days });
  if (days < 365) return t("skills.time.monthsAgo", { count: Math.floor(days / 30) });
  return t("skills.time.yearsAgo", { count: Math.floor(days / 365) });
}

/** Whole minutes until `resetAtSec` (epoch seconds), at least 1; null when unknown or past. */
export function minutesUntil(resetAtSec: number | null | undefined, nowMs: number): number | null {
  if (!resetAtSec) return null;
  const ms = resetAtSec * 1000 - nowMs;
  return ms > 0 ? Math.max(1, Math.ceil(ms / 60_000)) : null;
}

export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "";
}

/** The YAML frontmatter block (without the `---` fences) and the Markdown after it. */
export function splitFrontmatter(md: string): { frontmatter: string | null; body: string } {
  const text = md.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return { frontmatter: null, body: text };
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trimEnd();
    if (l === "---" || l === "...") return { frontmatter: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n").replace(/^\n+/, "") };
  }
  return { frontmatter: null, body: text };
}

/** Does an agent of this kind read skills from `target`? (Generic catalog CLIs count as Agent Skills hosts.) */
export function readsTarget(agent: AgentKind, target: SkillTarget): boolean {
  if (target === ".claude/skills") return agent === "claude";
  return agent === "codex" || agent === "generic";
}

/** Default install targets for the agents of a workspace; both when there are none yet. */
export function defaultTargets(agents: readonly AgentKind[]): SkillTarget[] {
  const out = SKILL_TARGETS.map((t) => t.id).filter((t) => agents.some((a) => readsTarget(a, t)));
  return out.length ? out : SKILL_TARGETS.map((t) => t.id);
}

/** The agents (of `agents`) that read at least one of `targets`. */
export function agentsReading<T extends { agent: AgentKind }>(targets: readonly SkillTarget[], agents: readonly T[]): T[] {
  return agents.filter((a) => targets.some((t) => readsTarget(a.agent, t)));
}

/** "a and b" (and "a and b and c") in the UI language. */
export function joinAnd(items: readonly string[]): string {
  return items.reduce((acc, item, i) => (i === 0 ? item : t("skills.listAnd", { first: acc, second: item })), "");
}

/** Toast after an install. Never claims live reload: agents load project skills when (re)started. */
export function installToast(name: string, installed: readonly string[], agentCount: number): string {
  if (agentCount > 0) return t("skills.installedToastAgents", { name, count: agentCount });
  return t("skills.installedToastFolders", { name, folders: joinAnd(installed) });
}

/** Installed copies of one repository skill (by provenance). */
export function installedCopies(installed: readonly InstalledSkill[], repo: string, path: string): InstalledSkill[] {
  const r = repo.toLowerCase();
  return installed.filter((i) => i.provenance && i.provenance.repo.toLowerCase() === r && i.provenance.path === path);
}

export function repoKey(repo: string, ref: string | null | undefined): string {
  return `${repo.toLowerCase()}#${ref ?? ""}`;
}

export function pageKey(sort: string, query: string, page: number): string {
  return `${sort}\u0000${query.trim()}\u0000${page}`;
}

/** github.com page of a repository, or of a folder at a pinned commit. */
export function githubUrl(repo: string, sha?: string | null, path?: string | null): string {
  const base = `https://github.com/${repo}`;
  if (!sha) return base;
  const p = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
  return `${base}/tree/${sha}${p}`;
}

export function skillPathLabel(path: string): string {
  return path || t("skills.repoRoot");
}
