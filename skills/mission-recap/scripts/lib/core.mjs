// mission-recap: the pure part (no I/O, Node >= 18, no dependencies). recap.mjs runs git and reads files,
// this module turns that raw text into Gridkeeper replay events (the format of src/replay/events.ts):
//
//   start   goal, team roster, task board at the first moment
//   task    one task changed state
//   attn    an agent lane's state (working / done)
//   branch  a lane's counters after each commit: commits, files, +ins / -del (`w` = opaque folder hash)
//   msg     a short line in the comms ticker (commit subjects, merges)
//   join    a lane appeared (branch created / first commit)
//
// PRIVACY: nothing leaves this module that is a file path, file content, diff, e-mail address or commit
// hash. Free text goes through scrubText() (a port of src/replay/events.ts, parity-tested against it);
// commit subjects additionally lose relative paths and file names (scrubSubject). Author names appear
// only with --show-authors.
//
// Ports kept in step with the app (see test/parity.test.ts): scrubText, folderHash, slugify,
// normalizeRole, parseMission, ownerMatches, snapMission / diffMission, toEvent / parseReplay.

export const REPLAY_FORMAT = 1;
export const MSG_MAX = 120;
export const TEXT_MAX = 160;
export const NAME_MAX = 40;
export const AGENT_MAX = 24;
export const LENGTHS = [15, 30, 45, 60];
export const ASPECTS = ["landscape", "square", "vertical"];

// ---- privacy (port of src/replay/events.ts) -----------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const WIN_PATH_RE = /(?:\b[A-Za-z]:[\\/]|\\\\[^\s\\/]+[\\/])[^\s"'<>|*?]*/g;
const POSIX_PATH_RE = /(?:^|(?<=[\s("'=]))(?:~|\/(?:home|Users|root|mnt|tmp|var|etc|opt|usr|private|Volumes|srv|data))(?:\/[^\s"'<>|]*)+/g;
const SECRET_PREFIX_RE = /\b(?:(?:sk|pk|rk)[-_][-_A-Za-z0-9]{12,}|(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{12,}|xox[abprs]-[-A-Za-z0-9]{10,}|glpat-[-_A-Za-z0-9]{12,}|AKIA[0-9A-Z]{16}|AIza[-_A-Za-z0-9]{30,})/g;
const secretPrefix = (m) => (/^[spr]k[-_]/.test(m) && !/[0-9]/.test(m) ? m : "‹redacted›");
const OPAQUE_RE = /[A-Za-z0-9+_=-]{32,}/g;
const opaque = (m) => (/[0-9]/.test(m) && /[A-Za-z]/.test(m) ? "‹redacted›" : m);

/** One line of display text with absolute paths, e-mails and secret-looking tokens removed, cut to `max`. */
export function scrubText(raw, max = TEXT_MAX) {
  if (!raw) return "";
  let s = String(raw)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(EMAIL_RE, "‹email›")
    .replace(WIN_PATH_RE, "‹path›")
    .replace(POSIX_PATH_RE, "‹path›")
    .replace(SECRET_PREFIX_RE, secretPrefix)
    .replace(OPAQUE_RE, opaque)
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) s = `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
  return s;
}

/** FNV-1a 32-bit of a normalized folder key, as 8 hex digits: groups lanes by worktree without a path. */
export function folderHash(path) {
  const key = String(path).trim().replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// Relative paths ("src/auth/callback.ts", "docs\setup.md", "./run") and bare file names ("callback.ts").
// Prose with slashes stays: one slash without an extension ("and/or", "client/server"), or capitalized
// words ("Windows/Ubuntu/macOS").
const REL_PATH_RE = /(?<![\w‹])(?:\.{1,2}[\\/])?(?:[\w@.-]+[\\/])+[\w@.-]*[\w-](?![\w›])/g;
const relPath = (m) => {
  if (!/[A-Za-z]/.test(m)) return m;
  const parts = m.split(/[\\/]/);
  const ext = /\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(parts[parts.length - 1]);
  const dirs = parts.length > 2 && (/^[a-z0-9._@-]+$/.test(parts[0]) || parts.some((p) => /[._]/.test(p)));
  return ext || dirs || /^\.{1,2}[\\/]/.test(m) ? "‹path›" : m;
};
const FILE_EXT =
  "tsx?|jsx?|mjs|cjs|vue|svelte|rs|py|pyi|go|java|kt|kts|scala|rb|php|cs|fs|cpp|cc|cxx|c|h|hh|hpp|m|mm|swift|dart|lua|zig|nim|ex|exs|erl|hs|ml|clj|r|jl|pl|sh|bash|zsh|fish|ps1|psm1|bat|cmd|json|jsonc|ya?ml|toml|ini|cfg|conf|env|lock|xml|html?|css|scss|sass|less|md|mdx|rst|txt|csv|sql|graphql|gql|proto|tf|gradle|sln|csproj|plist|wasm|png|jpe?g|gif|svg|webp|ico|pdf|zip";
const FILE_NAME_RE = new RegExp(`(?<![\\w‹])[\\w@-][\\w@.-]*\\.(?:${FILE_EXT})(?![\\w›])`, "gi");
// "Node.js", "Vue.js", "Next.js": product names, not files.
const PRODUCT_JS = /^[A-Z][A-Za-z0-9]*\.js$/;

/** A commit subject for the comms ticker: scrubText plus relative paths and file names removed. */
export function scrubSubject(raw, max = MSG_MAX) {
  const s = scrubText(raw, 400)
    .replace(REL_PATH_RE, relPath)
    .replace(FILE_NAME_RE, (m) => (PRODUCT_JS.test(m) ? m : "‹file›"))
    .replace(/(?:‹(?:path|file)›[\s,]*){2,}/g, "‹files› ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…` : s;
}

// ---- mission.md (port of src/lib/missionDoc.ts + src/lib/roles.ts) -------------------------------

const TASK_RE = /^(\s*(?:[-*+]|\d{1,4}[.)])\s+)\[([ xX~\-/!]?)\](.*)$/;
const FENCE_RE = /^\s*(```|~~~)/;
const OWNER_RE = /(^|[\s(\[,;])@([A-Za-z0-9][A-Za-z0-9_-]*)/g;
const EVERYONE = new Set(["all", "everyone", "team"]);
export const BUILTIN_ROLES = ["lead", "scout", "builder", "reviewer", "verifier"];
const ROLE_MAX_LEN = 24;

export function stateOfBox(ch) {
  switch (ch) {
    case "x":
    case "X":
      return "done";
    case "~":
    case "-":
    case "/":
      return "doing";
    case "!":
      return "blocked";
    default:
      return "todo";
  }
}

/** Name -> owner slug: lowercase, spaces/underscores -> "-", other characters dropped. */
export function slugify(name) {
  if (!name) return "";
  let out = "";
  for (const ch of String(name).trim().toLowerCase()) {
    if (/[a-z0-9-]/.test(ch)) out += ch;
    else if (ch === " " || ch === "_" || ch === "\t") out += "-";
  }
  return out.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

/** Free text -> role id (lower-case [a-z0-9-], at most 24 chars); empty -> null. */
export function normalizeRole(raw) {
  if (!raw) return null;
  let out = "";
  for (const ch of String(raw).trim().toLowerCase()) {
    if (out.length >= ROLE_MAX_LEN) break;
    if (/[a-z0-9-]/.test(ch)) out += ch;
    else if (ch === " " || ch === "_") out += "-";
  }
  out = out.replace(/^-+|-+$/g, "");
  return out || null;
}

function ownersOf(rest) {
  const owners = [];
  const text = rest
    .replace(OWNER_RE, (_m, pre, raw) => {
      const slug = slugify(raw);
      if (slug && !owners.includes(slug)) owners.push(slug);
      return pre;
    })
    .replace(/\(\s*\)|\[\s*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { owners, text };
}

/** Parse a mission file: { goal, context, tasks: [{ line, text, state, owners }] }. Never throws. */
export function parseMission(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  let goal = null;
  let goalSeen = false;
  let contextOpen = false;
  let contextDone = false;
  const context = [];
  const tasks = [];
  let fence = null;
  let comment = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (fence) {
      if (l.trim().startsWith(fence)) fence = null;
      continue;
    }
    const f = FENCE_RE.exec(l);
    if (f) {
      fence = f[1];
      contextDone ||= contextOpen;
      continue;
    }
    if (comment) {
      if (l.includes("-->")) comment = false;
      continue;
    }
    if (/^\s*<!--/.test(l)) {
      if (!l.includes("-->")) comment = true;
      continue;
    }
    const m = TASK_RE.exec(l);
    if (m) {
      const { owners, text: t } = ownersOf(m[3]);
      tasks.push({ line: i, text: t, state: stateOfBox(m[2]), owners });
      contextDone = true;
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) {
      if (h[1].length === 1 && !goalSeen) {
        goalSeen = true;
        const g = h[2].replace(/^mission\b\s*[:\-–—]?\s*/i, "").trim();
        goal = g || null;
        contextOpen = !contextDone;
      } else contextDone = true;
      continue;
    }
    if (contextOpen && !contextDone) context.push(l.trim());
  }
  return { goal, context: context.join("\n").replace(/\n{3,}/g, "\n\n").trim(), tasks };
}

/** Does owner token `token` name this member (name slug, role, plural role or everyone)? */
export function ownerMatches(token, m) {
  if (EVERYONE.has(token)) return true;
  if (slugify(m.name) === token) return true;
  const role = normalizeRole(m.role);
  return !!role && (role === token || `${role}s` === token);
}

// ---- mission diff (port of src/replay/diff.ts) ---------------------------------------------------

export const EMPTY_SNAP = { goal: null, tasks: [] };

export function snapMission(doc) {
  if (!doc) return EMPTY_SNAP;
  const goal = doc.goal ? scrubText(doc.goal, TEXT_MAX) || null : null;
  const tasks = [];
  for (const t of doc.tasks) {
    const text = scrubText(t.text, TEXT_MAX);
    if (!text) continue;
    tasks.push({ text, s: t.state, o: t.owners.slice(0, 8).map((o) => o.slice(0, 40)), line: t.line });
  }
  return { goal, tasks };
}

export const plainTasks = (snap) => snap.tasks.map(({ text, s, o }) => ({ text, s, o }));

const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();

function keyed(tasks) {
  const seen = new Map();
  const out = new Map();
  for (const t of tasks) {
    const base = norm(t.text);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(n === 1 ? base : `${base}#${n}`, t);
  }
  return out;
}

const sameOwners = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Events that turn snapshot `prev` into `next` at time `t`. */
export function diffMission(prev, next, t) {
  const out = [];
  if (prev.goal !== next.goal) out.push({ t, k: "goal", goal: next.goal });
  const before = keyed(prev.tasks);
  const after = keyed(next.tasks);
  const removed = new Map();
  for (const [k, task] of before) if (!after.has(k)) removed.set(task.line, k);
  const renamedFrom = new Set();
  for (const [k, n] of after) {
    const p = before.get(k);
    if (p) {
      if (p.s !== n.s || !sameOwners(p.o, n.o)) out.push({ t, k: "task", text: n.text, s: n.s, o: n.o });
      continue;
    }
    const oldKey = removed.get(n.line);
    const old = oldKey !== undefined ? before.get(oldKey) : undefined;
    if (oldKey !== undefined && old && !renamedFrom.has(oldKey)) {
      renamedFrom.add(oldKey);
      out.push({ t, k: "task", text: n.text, s: n.s, o: n.o, was: old.text });
    } else out.push({ t, k: "task", text: n.text, s: n.s, o: n.o });
  }
  for (const [k, p] of before) if (!after.has(k) && !renamedFrom.has(k)) out.push({ t, k: "task", text: p.text, s: "gone", o: [] });
  return out;
}

// ---- Gridkeeper recordings (port of toEvent / parseReplay in src/replay/events.ts) ----------------

const ATTN = new Set(["working", "needs", "done", "error", "idle"]);
const TASK_STATES = new Set(["todo", "doing", "done", "blocked"]);
const LEAVE = new Set(["stopped", "exited", "error", "removed"]);
export const RECORDING_NAME_RE = /^[A-Za-z0-9._-]+\.jsonl$/;

const str = (v, max = TEXT_MAX) => (typeof v === "string" ? v.slice(0, max * 2) : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
const strs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 32) : []);

function member(v) {
  if (!v || typeof v !== "object") return null;
  const slug = str(v.slug, NAME_MAX);
  if (!slug) return null;
  return { slug, name: str(v.name, NAME_MAX) || slug, role: typeof v.role === "string" ? v.role : null, agent: str(v.agent, 24), live: v.live !== false };
}

function taskSnap(v) {
  if (!v || typeof v !== "object") return null;
  const text = str(v.text);
  if (!text || typeof v.s !== "string" || !TASK_STATES.has(v.s)) return null;
  return { text, s: v.s, o: strs(v.o) };
}

/** Validate one decoded object into an event (unknown fields dropped, bad events -> null). */
export function toEvent(v) {
  if (!v || typeof v !== "object") return null;
  const t = typeof v.t === "number" && Number.isFinite(v.t) ? v.t : NaN;
  if (!Number.isFinite(t) || t <= 0) return null;
  switch (v.k) {
    case "start":
      return {
        t,
        k: "start",
        v: num(v.v) || 1,
        goal: typeof v.goal === "string" ? v.goal : null,
        team: (Array.isArray(v.team) ? v.team : []).map(member).filter(Boolean),
        tasks: (Array.isArray(v.tasks) ? v.tasks : []).map(taskSnap).filter(Boolean),
      };
    case "task": {
      const text = str(v.text);
      const s = typeof v.s === "string" && (TASK_STATES.has(v.s) || v.s === "gone") ? v.s : null;
      if (!text || !s) return null;
      return typeof v.was === "string" && v.was ? { t, k: "task", text, s, o: strs(v.o), was: v.was } : { t, k: "task", text, s, o: strs(v.o) };
    }
    case "goal":
      return { t, k: "goal", goal: typeof v.goal === "string" ? v.goal : null };
    case "attn": {
      const slug = str(v.slug, NAME_MAX);
      return slug && typeof v.s === "string" && ATTN.has(v.s) ? { t, k: "attn", slug, s: v.s } : null;
    }
    case "branch": {
      const slug = str(v.slug, NAME_MAX);
      if (!slug) return null;
      return { t, k: "branch", slug, w: str(v.w, 16) || slug, ahead: num(v.ahead), files: num(v.files), ins: num(v.ins), del: num(v.del) };
    }
    case "msg": {
      const text = str(v.text, MSG_MAX);
      if (!text) return null;
      return { t, k: "msg", from: str(v.from, NAME_MAX) || "you", to: strs(v.to), text };
    }
    case "join": {
      const slug = str(v.slug, NAME_MAX);
      if (!slug) return null;
      const ev = { t, k: "join", slug, name: str(v.name, NAME_MAX) || slug, role: typeof v.role === "string" ? v.role : null, agent: str(v.agent, 24) };
      return typeof v.was === "string" && v.was ? { ...ev, was: v.was } : ev;
    }
    case "leave": {
      const slug = str(v.slug, NAME_MAX);
      if (!slug) return null;
      return { t, k: "leave", slug, why: typeof v.why === "string" && LEAVE.has(v.why) ? v.why : "stopped" };
    }
    case "end":
      return { t, k: "end" };
    default:
      return null;
  }
}

/** Parse a JSONL recording. Never throws; events come back sorted by time (stable). */
export function parseReplay(text) {
  const events = [];
  let skipped = 0;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    let v;
    try {
      v = JSON.parse(l);
    } catch {
      skipped++;
      continue;
    }
    const ev = toEvent(v);
    if (ev) events.push(ev);
    else skipped++;
  }
  events.sort((a, b) => a.t - b.t);
  return { events, skipped };
}

/** A recording's events with every free-text field scrubbed again (and the goal replaced, if given). */
export function sanitizeRecording(events, goalOverride) {
  const goal = goalOverride ? scrubText(goalOverride, TEXT_MAX) || null : undefined;
  const name = (s) => scrubText(s, NAME_MAX);
  const out = [];
  for (const e of events) {
    switch (e.k) {
      case "start":
        out.push({
          ...e,
          goal: goal !== undefined ? goal : scrubText(e.goal, TEXT_MAX) || null,
          team: e.team.map((m) => ({ ...m, name: name(m.name) || m.slug, agent: scrubText(m.agent, AGENT_MAX) })),
          tasks: e.tasks.map((t) => ({ ...t, text: scrubText(t.text, TEXT_MAX) })).filter((t) => t.text),
        });
        break;
      case "goal":
        if (goal === undefined) out.push({ ...e, goal: scrubText(e.goal, TEXT_MAX) || null });
        break;
      case "task": {
        const text = scrubText(e.text, TEXT_MAX);
        if (!text) break;
        out.push(e.was ? { ...e, text, was: scrubText(e.was, TEXT_MAX) } : { ...e, text });
        break;
      }
      case "msg": {
        const text = scrubText(e.text, MSG_MAX);
        if (text) out.push({ ...e, text });
        break;
      }
      case "join":
        out.push({ ...e, name: name(e.name) || e.slug, agent: scrubText(e.agent, AGENT_MAX) });
        break;
      default:
        out.push(e);
    }
  }
  return out;
}

/** Time range and goal of a recording (for picking the one that covers the recap window). */
export function recordingInfo(events) {
  let goal = null;
  let active = 0;
  for (const e of events) {
    if (e.k === "start" || e.k === "goal") goal = e.goal ?? goal;
    if (e.k !== "start" && e.k !== "end" && e.k !== "goal") active++;
  }
  return { goal, first: events.length ? events[0].t : null, last: events.length ? events[events.length - 1].t : null, active };
}

/**
 * Recordings to use for a window starting at `t0`: those that overlap it, with activity, of the same
 * goal as the most recent one. `recs` = [{ name, events }]. Returns the merged events or null.
 */
export function pickRecordings(recs, t0) {
  const cands = recs
    .map((r) => ({ ...r, info: recordingInfo(r.events) }))
    .filter((r) => r.info.active > 0 && r.info.last !== null && (t0 === null || r.info.last >= t0))
    .sort((a, b) => a.info.last - b.info.last);
  if (!cands.length) return null;
  const latest = cands[cands.length - 1];
  const key = norm(latest.info.goal ?? "");
  const chosen = cands.filter((r) => norm(r.info.goal ?? "") === key);
  const events = chosen.flatMap((r) => r.events).sort((a, b) => a.t - b.t);
  return { names: chosen.map((r) => r.name), events, goal: latest.info.goal };
}

// ---- git output parsing ---------------------------------------------------------------------------

/** `git log` format: record separator, fields (hash, parents, committer time, author, subject, body). */
export const LOG_FORMAT = "%x1e%H%x1f%P%x1f%ct%x1f%an%x1f%s%x1f%b%x1d";

/**
 * Parse `git log --numstat --format=LOG_FORMAT` output into commits (in the order git printed them):
 * { sha, parents, t (ms), author, subject, agent, files: [{ path, ins, del }] }. Paths stay in memory
 * (unique-file counts) and are never written out.
 */
export function parseLog(text) {
  const out = [];
  for (const rec of String(text ?? "").split("\x1e")) {
    if (!rec.trim()) continue;
    const cut = rec.indexOf("\x1d");
    const head = cut >= 0 ? rec.slice(0, cut) : rec;
    const tail = cut >= 0 ? rec.slice(cut + 1) : "";
    const f = head.split("\x1f");
    if (f.length < 5 || !/^[0-9a-f]{7,64}$/i.test(f[0].trim())) continue;
    const t = Number(f[2]) * 1000;
    if (!Number.isFinite(t) || t <= 0) continue;
    const files = [];
    for (const line of tail.split(/\r?\n/)) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (m) files.push({ path: m[3], ins: m[1] === "-" ? 0 : Number(m[1]), del: m[2] === "-" ? 0 : Number(m[2]) });
    }
    out.push({
      sha: f[0].trim(),
      parents: f[1].trim() ? f[1].trim().split(/\s+/) : [],
      t,
      author: f[3],
      subject: f[4],
      agent: agentHint(f.slice(5).join("\x1f")),
      files,
    });
  }
  return out;
}

/** `git worktree list --porcelain` -> [{ path, head, branch (short name or null), detached, bare }]. */
export function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5).trim();
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, "");
    else if (line === "detached") cur.detached = true;
    else if (line === "bare") cur.bare = true;
  }
  return out;
}

/** `git for-each-ref --format=%(refname:short)%09%(objectname)%09%(committerdate:unix) refs/heads`. */
export function parseRefs(text) {
  const out = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const [name, sha, t] = line.split("\t");
    if (name && sha && /^\d+$/.test(t ?? "")) out.push({ name, sha, t: Number(t) * 1000 });
  }
  return out;
}

/**
 * The creation entry of a branch reflog (`git reflog show --date=unix --format=%H%x09%gd%x09%gs <ref>`,
 * oldest entry last): { sha, t } when the oldest entry is "branch: Created from …", else null.
 */
export function parseCreation(text) {
  const lines = String(text ?? "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return null;
  const [sha, sel, subject] = lines[lines.length - 1].split("\t");
  if (!sha || !/^branch: Created from /i.test(subject ?? "")) return null;
  const m = /@\{(\d+)\}$/.exec(sel ?? "");
  return { sha, t: m ? Number(m[1]) * 1000 : null };
}

const AGENT_HINTS = [
  ["claude", /\bclaude\b|anthropic/],
  ["codex", /\bcodex\b|openai/],
  ["gemini", /\bgemini\b/],
  ["cursor", /\bcursor\b/],
  ["copilot", /\bcopilot\b/],
  ["aider", /\baider\b/],
];

/** Agent CLI named in a commit body's trailers ("Co-Authored-By: Claude …", "Generated with …"), or "". */
export function agentHint(body) {
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const l = line.trim().toLowerCase();
    if (!/^(co-authored-by|generated-by|assisted-by|signed-off-by)\s*:|generated with|generated by/.test(l)) continue;
    for (const [id, re] of AGENT_HINTS) if (re.test(l)) return id;
  }
  return "";
}

// ---- lanes ----------------------------------------------------------------------------------------

/** A role id when the lane name contains one as a word ("builder-1", "gk-reviewer"), else null. */
export function inferRole(name) {
  for (const part of slugify(String(name).replace(/[/.]/g, "-")).split("-")) {
    const p = part.replace(/s$/, "");
    if (BUILTIN_ROLES.includes(p)) return p;
  }
  return null;
}

/** Long hex ids in branch names ("worktree-agent-a7a23264f9c48ecb1") shortened like a short hash. */
export const shortIds = (s) => String(s).replace(/\b([0-9a-f]{7})[0-9a-f]{5,}\b/gi, "$1");

/**
 * Display names for branches: the last path segment ("gk/1017-1530/builder-1" -> "builder-1"), more
 * segments when two lanes would collide; agent worktree branches lose the "worktree-" prefix.
 */
export function laneNames(branches) {
  const segs = branches.map((b) =>
    shortIds(b)
      .split("/")
      .filter(Boolean)
      .map((s) => s.replace(/^worktree-(?=.)/i, "")),
  );
  const depth = branches.map(() => 1);
  for (let round = 0; round < 8; round++) {
    const names = segs.map((s, i) => s.slice(-depth[i]).join("/") || branches[i]);
    let clash = false;
    names.forEach((n, i) => {
      if (names.some((m, j) => j !== i && m === n) && depth[i] < segs[i].length) {
        depth[i]++;
        clash = true;
      }
    });
    if (!clash) return names;
  }
  return segs.map((s, i) => s.slice(-depth[i]).join("/") || branches[i]);
}

/** A slug for `name` not in `used` (name slug, else "agent"; "-2", "-3", … on collisions). */
export function uniqueSlug(name, used) {
  const base = slugify(scrubText(name, NAME_MAX).replace(/[‹›]/g, "").replace(/[/.]/g, "-")).slice(0, NAME_MAX) || "agent";
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * Give every commit to exactly one lane. Lanes that are not the base claim first, smallest first (a
 * builder branch merged into the lead's branch keeps its own commits); the base lane gets the rest.
 * Returns new lane objects with `commits` sorted by time (oldest first).
 */
export function assignCommits(lanes) {
  const order = lanes
    .map((l, i) => ({ l, i }))
    .sort((a, b) => Number(a.l.base) - Number(b.l.base) || a.l.commits.length - b.l.commits.length || String(a.l.branch).localeCompare(String(b.l.branch)));
  const claimed = new Set();
  const out = lanes.map((l) => ({ ...l, commits: [] }));
  for (const { l, i } of order) {
    // git prints newest first: reverse, then a stable sort by time keeps parents before children.
    const mine = [...l.commits].reverse().filter((c) => !claimed.has(c.sha));
    for (const c of mine) claimed.add(c.sha);
    out[i].commits = mine.sort((a, b) => a.t - b.t);
  }
  return out;
}

// ---- events ---------------------------------------------------------------------------------------

const author = (lane) => {
  const n = new Map();
  for (const c of lane.commits) if (c.author) n.set(c.author, (n.get(c.author) ?? 0) + 1);
  const ranked = [...n.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return "";
  const first = scrubText(ranked[0][0], AGENT_MAX).replace(/‹email›/g, "").trim();
  return ranked.length > 1 ? `${first} +${ranked.length - 1}` : first;
};

const mostCommon = (xs) => {
  const n = new Map();
  for (const x of xs) if (x) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
};

/**
 * Replay events from git lanes and an optional task board.
 *
 * input = {
 *   goal: string | null,
 *   lanes: [{ branch, base, folder (abs path or null, hashed), createdAt (ms or null), merged, commits }],
 *   board: null | { kind: "final", doc } | { kind: "history", snaps: [{ t (ms or null = at the start), doc }] },
 *   t0: window start (ms) or null, showAuthors, subjects (commit subjects in the ticker, default true)
 * }
 * Returns { events, lanes: [{ slug, name, branch, commits }], commits, tasks }.
 */
export function buildEvents(input) {
  const { goal: rawGoal = null, board = null, t0 = null, showAuthors = false, subjects = true } = input;
  const goal = scrubText(rawGoal, TEXT_MAX) || null;
  const assigned = assignCommits(input.lanes ?? []);
  // Lanes with commits; the base lane first, then by first commit.
  const lanes = assigned
    .filter((l) => l.commits.length > 0)
    .sort((a, b) => Number(b.base) - Number(a.base) || a.commits[0].t - b.commits[0].t);
  const names = laneNames(lanes.map((l) => (l.branch === "HEAD" ? "detached" : l.branch)));
  const used = new Set();
  const L = lanes.map((l, i) => {
    const name = scrubText(names[i], NAME_MAX) || "lane";
    const slug = uniqueSlug(name, used);
    used.add(slug);
    const hint = mostCommon(l.commits.map((c) => c.agent));
    const agent = (showAuthors ? [hint, author(l)].filter(Boolean).join(" · ") : hint).slice(0, AGENT_MAX);
    const first = l.commits[0].t;
    const created = typeof l.createdAt === "number" && l.createdAt <= first && (t0 === null || l.createdAt >= t0) ? l.createdAt : null;
    return { ...l, name, slug, role: inferRole(name), agent, joinAt: created ?? first, w: folderHash(l.folder ? l.folder : `branch:${l.branch}`) };
  });

  const allCommits = L.flatMap((l) => l.commits.map((c) => ({ ...c, slug: l.slug }))).sort((a, b) => a.t - b.t);
  const snaps = board?.kind === "history" ? board.snaps.filter((s) => s && s.doc).map((s) => ({ t: s.t, snap: snapMission(s.doc) })) : [];
  const timed = snaps.filter((s) => typeof s.t === "number" && (t0 === null || s.t >= t0));
  const candidates = [...L.map((l) => l.joinAt), ...(allCommits.length ? [allCommits[0].t] : []), ...timed.map((s) => s.t)];
  if (!candidates.length) return { events: [], lanes: [], commits: 0, tasks: 0 };
  const ts = Math.min(...candidates);
  const lastCommitT = allCommits.length ? allCommits[allCommits.length - 1].t : ts;

  const ev = [];
  const push = (e) => ev.push(e);

  // ---- board ----
  let startTasks = [];
  const taskEvents = [];
  const doneAt = new Map(); // task text -> last time it turned done
  let finalTasks = [];
  if (board?.kind === "history" && snaps.length) {
    const initial = snaps.filter((s) => s.t === null || s.t <= ts).pop() ?? null;
    let prev = initial ? initial.snap : EMPTY_SNAP;
    startTasks = plainTasks(prev);
    for (const s of snaps) {
      if (s === initial || s.t === null || s.t <= ts) continue;
      for (const e of diffMission(prev, s.snap, s.t)) if (e.k === "task") taskEvents.push(e);
      prev = s.snap;
    }
    finalTasks = prev.tasks;
  } else if (board?.kind === "final" && board.doc) {
    const snap = snapMission(board.doc);
    finalTasks = snap.tasks;
    startTasks = snap.tasks.map((t) => ({ text: t.text, s: "todo", o: t.o }));
    // Final states only: tick them off in commit order, on the commits of the lanes that own them.
    const lanesFor = (task) => L.filter((l) => task.o.some((tok) => ownerMatches(tok, l)));
    const groups = new Map();
    for (const task of snap.tasks) {
      if (task.s === "todo") continue;
      const owners = lanesFor(task);
      const key = owners.map((l) => l.slug).sort().join(",") || "*";
      if (!groups.has(key)) {
        const times = (owners.length ? allCommits.filter((c) => owners.some((l) => l.slug === c.slug)) : allCommits).map((c) => c.t);
        const startT = owners.length ? Math.min(...owners.map((l) => l.joinAt)) : ts;
        groups.set(key, { times: times.length ? times : allCommits.map((c) => c.t), startT, tasks: [] });
      }
      groups.get(key).tasks.push(task);
    }
    for (const g of groups.values()) {
      const n = g.times.length;
      const done = g.tasks.filter((t) => t.s === "done");
      let prevT = g.startT;
      done.forEach((task, i) => {
        const tDone = n ? g.times[Math.min(n - 1, Math.max(0, Math.ceil(((i + 1) * n) / done.length) - 1))] : lastCommitT;
        const tDoing = Math.min(tDone, prevT + 1);
        taskEvents.push({ t: tDoing, k: "task", text: task.text, s: "doing", o: task.o });
        taskEvents.push({ t: tDone, k: "task", text: task.text, s: "done", o: task.o });
        prevT = tDone;
      });
      for (const task of g.tasks) {
        if (task.s === "doing") taskEvents.push({ t: Math.min(lastCommitT, prevT + 1), k: "task", text: task.text, s: "doing", o: task.o });
        else if (task.s === "blocked") taskEvents.push({ t: n ? g.times[n - 1] : lastCommitT, k: "task", text: task.text, s: "blocked", o: task.o });
      }
    }
  }

  // ---- roster ----
  const inStart = L.filter((l) => l.joinAt <= ts);
  push({
    t: ts,
    k: "start",
    v: REPLAY_FORMAT,
    goal,
    team: inStart.map((l) => ({ slug: l.slug, name: l.name, role: l.role, agent: l.agent, live: true })),
    tasks: startTasks,
  });

  const laneOf = new Map();
  for (const l of L) for (const c of l.commits) laneOf.set(c.sha, l);
  const doneLane = new Map(); // slug -> time

  for (const l of L) {
    if (l.joinAt > ts) push({ t: l.joinAt, k: "join", slug: l.slug, name: l.name, role: l.role, agent: l.agent });
    push({ t: l.joinAt, k: "branch", slug: l.slug, w: l.w, ahead: 0, files: 0, ins: 0, del: 0 });
    push({ t: l.joinAt, k: "attn", slug: l.slug, s: "working" });
    const files = new Set();
    let ahead = 0;
    let ins = 0;
    let del = 0;
    for (const c of l.commits) {
      ahead++;
      for (const f of c.files) {
        files.add(f.path);
        ins += f.ins;
        del += f.del;
      }
      push({ t: c.t, k: "branch", slug: l.slug, w: l.w, ahead, files: files.size, ins, del });
      if (c.parents.length > 1) {
        const merged = [...new Set(c.parents.slice(1).map((p) => laneOf.get(p)).filter((m) => m && m !== l))];
        for (const m of merged) {
          push({ t: c.t, k: "msg", from: l.slug, to: [m.slug], text: scrubText(`merged ${m.name} into ${l.name}`, MSG_MAX) });
          if (!doneLane.has(m.slug)) doneLane.set(m.slug, c.t);
        }
      } else if (subjects) {
        const text = scrubSubject(c.subject);
        if (text) push({ t: c.t, k: "msg", from: l.slug, to: [], text });
      }
    }
  }

  for (const e of taskEvents) {
    push(e);
    if (e.s === "done") doneAt.set(e.text, e.t);
  }

  // ---- lanes that finished: merged, or every task they own is done ----
  let endT = lastCommitT;
  for (const e of ev) if (e.t > endT) endT = e.t;
  for (const l of L) {
    if (doneLane.has(l.slug)) continue;
    const owned = finalTasks.filter((t) => t.o.some((tok) => ownerMatches(tok, l)));
    if (owned.length && owned.every((t) => t.s === "done")) {
      const tt = owned.map((t) => doneAt.get(t.text)).filter((x) => typeof x === "number");
      doneLane.set(l.slug, tt.length ? Math.max(...tt) : endT);
    } else if (l.merged && !l.base) doneLane.set(l.slug, endT);
  }
  for (const [slug, t] of doneLane) push({ t, k: "attn", slug, s: "done" });

  // Stable sort: same-time events keep their order (baseline before the first commit, doing before done).
  const events = ev.map((e, i) => ({ e, i })).sort((a, b) => a.e.t - b.e.t || a.i - b.i).map((x) => x.e);
  return {
    events,
    lanes: L.map((l) => ({ slug: l.slug, name: l.name, branch: l.branch, commits: l.commits.length })),
    commits: allCommits.length,
    tasks: finalTasks.length,
  };
}

// ---- defaults and options -------------------------------------------------------------------------

/** Local midnight of the day `now` falls on (ms). */
export function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "feat/oauth-login" -> "Oauth login" (a goal when nothing better exists). */
export function prettyBranch(branch) {
  const last = shortIds(branch ?? "").split("/").filter(Boolean).pop() ?? "";
  const s = last.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

/**
 * How far back to look when --since is not given: on a feature branch (not the default branch), from
 * where it left the default branch; otherwise from the start of today.
 */
export function defaultWindow({ current, defaultBranch }) {
  if (defaultBranch && current !== defaultBranch) return "merge-base";
  return "today";
}

/** The recap's goal: --goal, else the mission board, else a recording, else the branch, else the last commit. */
export function resolveGoal({ flag, mission, recording, branch, defaultBranch, lastSubject }) {
  const pick = [flag, mission, recording].find((g) => typeof g === "string" && g.trim());
  if (pick) return scrubText(pick, TEXT_MAX);
  if (branch && branch !== "HEAD" && branch !== defaultBranch) {
    const b = prettyBranch(branch);
    if (b) return scrubText(b, TEXT_MAX);
  }
  return scrubText(lastSubject, TEXT_MAX) ? scrubSubject(lastSubject, TEXT_MAX) : null;
}

/** "<slug(goal)>": file names for exports (same rule as goalSlug in src/replay/events.ts). */
export function goalSlug(goal) {
  const s = slugify(scrubText(goal, 200).replace(/[‹›]/g, ""))
    .slice(0, 48)
    .replace(/-+$/, "");
  return s || "mission";
}

export const USAGE = `mission-recap: turn this repo's recent agent work into a timelapse video.

Usage: node recap.mjs [options]

  --repo <dir>          repository to read (default: current folder)
  --since <date|ref>    start of the recap: a date git understands ("yesterday", "2026-10-18 09:00")
                        or a commit/branch/tag. Default: on a feature branch, where it left the
                        default branch (merge-base); on the default branch, the start of today.
  --goal "<text>"       title of the video (default: .gridkeeper/mission.md "# Mission:" line,
                        else the branch name, else the last commit subject)
  --tasks <file.md>     a Markdown checklist to show as the task board when there is no
                        .gridkeeper/mission.md ("- [x] done", "- [~] doing", "- [ ] todo")
  --out <file.html>     where to write the player page (default: ./mission-recap.html)
  --aspect <a>          landscape (1920x1080) | square (1080x1080) | vertical (1080x1920)
  --length <s>          15 | 30 | 45 | 60 seconds (default 30)
  --no-watermark        hide "Made with Gridkeeper" (can also be toggled in the page)
  --show-authors        show commit author names next to each lane (hidden by default)
  --no-subjects         keep commit subjects out of the comms ticker
  --no-replay           ignore Gridkeeper recordings (.gridkeeper/replay/*.jsonl) and use git
  --replay <file>       use this Gridkeeper recording
  --open                open the page in the default browser
  --mp4 [file]          also render the video headless (Node >= 22 + Chrome/Edge/Chromium)
  --gif [file]          also render a GIF headless
  --browser <path>      browser for --mp4 / --gif (default: auto-detect, or $CHROME_PATH)
  -h, --help            this help
`;

const ASPECT_ALIASES = { landscape: "landscape", "16:9": "landscape", wide: "landscape", square: "square", "1:1": "square", vertical: "vertical", "9:16": "vertical", portrait: "vertical" };

/** Parse argv (without node and the script). Throws Error with a readable message on bad input. */
export function parseArgs(argv) {
  const o = {
    repo: null,
    since: null,
    goal: null,
    tasks: null,
    out: null,
    aspect: "landscape",
    length: 30,
    watermark: true,
    showAuthors: false,
    subjects: true,
    replay: true,
    replayFile: null,
    open: false,
    mp4: null,
    gif: null,
    browser: null,
    help: false,
  };
  const args = [];
  for (const a of argv) {
    const m = /^(--[a-z0-9-]+)=(.*)$/s.exec(a);
    if (m) args.push(m[1], m[2]);
    else args.push(a);
  }
  const value = (i, flag) => {
    const v = args[i + 1];
    if (v === undefined || (v.startsWith("--") && v.length > 2)) throw new Error(`${flag} needs a value`);
    return v;
  };
  const optional = (i) => {
    const v = args[i + 1];
    return v !== undefined && !v.startsWith("-") ? v : null;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--repo":
        o.repo = value(i++, a);
        break;
      case "--since":
        o.since = value(i++, a);
        break;
      case "--goal":
        o.goal = value(i++, a);
        break;
      case "--tasks":
        o.tasks = value(i++, a);
        break;
      case "--out":
        o.out = value(i++, a);
        break;
      case "--aspect": {
        const v = ASPECT_ALIASES[value(i++, a).toLowerCase()];
        if (!v) throw new Error("--aspect must be landscape, square or vertical");
        o.aspect = v;
        break;
      }
      case "--length": {
        const v = Number(String(value(i++, a)).replace(/s$/, ""));
        if (!LENGTHS.includes(v)) throw new Error("--length must be 15, 30, 45 or 60");
        o.length = v;
        break;
      }
      case "--no-watermark":
        o.watermark = false;
        break;
      case "--watermark":
        o.watermark = true;
        break;
      case "--show-authors":
        o.showAuthors = true;
        break;
      case "--no-subjects":
        o.subjects = false;
        break;
      case "--no-replay":
        o.replay = false;
        break;
      case "--replay":
        o.replayFile = value(i++, a);
        break;
      case "--open":
        o.open = true;
        break;
      case "--mp4": {
        const v = optional(i);
        o.mp4 = v ?? "";
        if (v !== null) i++;
        break;
      }
      case "--gif": {
        const v = optional(i);
        o.gif = v ?? "";
        if (v !== null) i++;
        break;
      }
      case "--browser":
        o.browser = value(i++, a);
        break;
      case "-h":
      case "--help":
        o.help = true;
        break;
      default:
        throw new Error(`unknown option: ${a} (see --help)`);
    }
  }
  return o;
}
