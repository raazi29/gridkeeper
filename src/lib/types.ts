// IPC contract — mirrors src-tauri/src/types.rs. Change both sides together.

export type SessionId = string;
export type AgentKind = "powershell" | "claude" | "codex" | "generic";

export type ResumeMode =
  | { mode: "none" }
  | { mode: "continue" }
  | { mode: "session"; id: string }
  /** The agent's own interactive picker (claude --resume, codex resume). */
  | { mode: "pick" };

export interface EnvVar {
  key: string;
  value: string;
}

export interface SessionSpec {
  id: SessionId;
  name: string;
  agent: AgentKind;
  cwd: string;
  /** Account id for whichever agent this session runs (historically Claude-only). */
  profileId?: string | null;
  command?: string | null;
  args?: string[];
  env?: EnvVar[];
  resume?: ResumeMode;
  /** Pin a NEW conversation id (claude --session-id). */
  agentSessionId?: string | null;
  /** Catalog tool id for generic sessions, e.g. "hermes". */
  preset?: string | null;
  cols: number;
  rows: number;
}

export type SessionState =
  | { state: "starting" }
  | { state: "running" }
  | { state: "stopping" }
  | { state: "exited"; code: number | null }
  | { state: "failed"; message: string };

export interface SessionInfo {
  id: SessionId;
  name: string;
  agent: AgentKind;
  pid: number | null;
  state: SessionState;
  cwd: string;
  profileId: string | null;
  commandDisplay: string;
  startedAt: string | null;
  endedAt: string | null;
  bytesOut: number;
}

export const EVT_SESSION_STATE = "session-state";

/** Attention signal from Rust (see src-tauri/src/pty/attention.rs). */
export const EVT_SESSION_ATTENTION = "session-attention";
/** Payload { projectDir } — the mission file of a watched project folder changed (see mission_watch). */
export const EVT_MISSION_CHANGED = "mission-changed";
/** macOS app menu: payload NativeMenuCommand — a custom menu item was chosen (see src-tauri/src/app_menu.rs). */
export const EVT_NATIVE_MENU = "native-menu";
export interface NativeMenuCommand {
  /** Command id from src/actions/commands.ts, e.g. "view.settings". */
  command: string;
}
export type AttentionKind = "bell" | "notify" | "status" | "idle" | "active";

export interface SessionAttention {
  id: SessionId;
  kind: AttentionKind;
  /** Notification title (control chars stripped, <= 200 chars). */
  title?: string;
  body?: string;
  /** status: OSC 7501 state (idle|working|done|blocked|error|clear|…); idle: "done" when the run counts as finished. */
  status?: string;
  /** OSC 7501 blocked kind: permission | question | auth. */
  reason?: string;
  /** idle: duration of the active run that just ended. */
  activeMs?: number;
}

/** First byte of every binary message on a session output channel. */
export const FRAME_DATA = 0;
export const FRAME_RESET = 1;

export interface ProfileStatus {
  dirExists: boolean;
  likelyAuthenticated: boolean;
  /** True when `claude auth status` actually ran. */
  verified: boolean;
  loggedIn: boolean | null;
  authMethod: string | null;
  /** UI display only. */
  account: string | null;
  note: string | null;
}

export interface ClaudeProfile {
  id: string;
  name: string;
  /** null = Claude Code default config location. */
  configDir: string | null;
  color: string;
  status: ProfileStatus;
}

/**
 * An account of any agent (Claude: CLAUDE_CONFIG_DIR, Codex: CODEX_HOME, Hermes: HERMES_HOME).
 * Same fields as ClaudeProfile plus the agent it belongs to. `configDir: null` = the agent's default home.
 */
export interface Account extends ClaudeProfile {
  agent: AgentKind;
  /** Catalog tool id when agent = "generic" (e.g. "hermes"). */
  preset: string | null;
  /** Added by the automatic scan. */
  autoDetected: boolean;
  /** Home folder this account resolves to (default home expanded). */
  resolvedDir: string | null;
}

export interface AccountsSnapshot {
  accounts: Account[];
  /** Number of removed (hidden) homes the scan skips. */
  dismissed: number;
}

/** An agent in the Accounts dialog: with verified account isolation, or installed without it. */
export interface AccountAgentInfo {
  key: string;
  agent: AgentKind;
  preset: string | null;
  label: string;
  isolation: "verified" | "none";
  homeEnv: string | null;
  defaultHome: string | null;
  installed: boolean;
  hasStatusCommand: boolean;
  loginArgs: string[];
  deviceLoginArgs: string[] | null;
  loginHint: string | null;
  loginVerified: boolean;
  note: string | null;
}

export interface PlannedHome {
  path: string;
  exists: boolean;
  empty: boolean;
}

export interface AgentAvailability {
  kind: AgentKind;
  path: string | null;
  version: string | null;
  error: string | null;
  /** Catalog tool id (kind = "generic"), e.g. "hermes"; null for built-in kinds. */
  preset: string | null;
  label: string | null;
  supportsResume: boolean;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
  isMain: boolean;
}

export interface GitInfo {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  dirty: boolean;
  worktrees: WorktreeInfo[];
}

/** One changed path from `git status --porcelain=v2` (read-only Changes panel). */
export interface ChangedFile {
  /** Repository-relative, forward slashes. */
  path: string;
  origPath: string | null;
  /** Staged status letter ("." = unchanged). */
  index: string;
  /** Work-tree status letter ("?" = untracked). */
  worktree: string;
  kind: "changed" | "renamed" | "unmerged" | "untracked";
}

export interface RepoChanges {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: ChangedFile[];
  truncated: boolean;
}

export interface FileDiff {
  text: string;
  truncated: boolean;
  binary: boolean;
}

/** A TCP port a session's process tree listens on. */
export interface SessionPort {
  port: number;
  pid: number;
  addresses: string[];
}

export interface SessionPorts {
  id: SessionId;
  ports: SessionPort[];
}

/** Result of the embeddability probe for a browser pane URL. */
export interface FrameProbe {
  reachable: boolean;
  status: number | null;
  /** false: the site forbids framing; null: unknown. */
  frameable: boolean | null;
  reason: string | null;
  title: string | null;
  error: string | null;
}

export interface PathInfo {
  exists: boolean;
  isDir: boolean;
  normalized: string | null;
}

export interface ProcStats {
  cpuPercent: number;
  memoryBytes: number;
  processCount: number;
}

export interface Diagnostics {
  host: ProcStats;
  webview: ProcStats;
  sessionsTotal: ProcStats;
  sessions: { id: SessionId; stats: ProcStats }[];
  logicalCores: number;
  systemMemoryTotal: number;
  systemMemoryUsed: number;
  runningSessions: number;
  /** Windows GPU performance counters (same source as Task Manager); absent from older backends. */
  gpu?: GpuStats | null;
}

/** Busiest engine of each class, percent. */
export interface EnginePercent {
  "3d": number;
  copy: number;
  video: number;
  compute: number;
  other: number;
}

export interface GpuAdapter {
  /** Adapter LUID as printed in the counter instance names. */
  luid: string;
  dedicatedUsedBytes: number;
  enginePercent: EnginePercent;
  /** Holds the app's WebView2 GPU allocations: this adapter draws the UI and terminals. */
  carriesUi: boolean;
}

export interface GpuStats {
  available: boolean;
  /** First sample after opening the counters: utilization is not known yet. */
  warmingUp: boolean;
  webview3dPercent: number;
  /** Busiest engine of any class (Task Manager's per-process "GPU" column). */
  webviewTotalPercent: number;
  webviewDedicatedBytes: number;
  webviewSharedBytes: number;
  hostPercent: number;
  sessionsPercent: number;
  adapters: GpuAdapter[];
  engineInstances: number;
  /** Cost of reading the counters, ms. */
  sampleMs: number;
  error?: string;
}

// ---- persisted state -------------------------------------------------------

export const STATE_VERSION = 1;
export type RendererPref = "auto" | "webgl" | "dom";
export type LayoutPreset = "grid" | "columns" | "rows";
export type UiDensity = "compact" | "comfortable";

export interface AgentPaths {
  claude: string | null;
  codex: string | null;
  powershell: string | null;
}

export interface Settings {
  scrollbackLines: number;
  bufferKib: number;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  renderer: RendererPref;
  cursorBlink: boolean;
  defaultLayout: LayoutPreset;
  agentPaths: AgentPaths;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  statusBarDiagnostics: boolean;
  keybindings: Record<string, string>;
  /** Theme id (src/theme/themes.ts); unknown ids fall back to the default theme. */
  theme: string;
  /** Disable UI animation and effects (also honoured when the OS asks for reduced motion). */
  reduceMotion: boolean;
  uiDensity: UiDensity;
  notifications: NotificationSettings;
  /** Confirm before pasting >64 KiB or >20 lines into a program without bracketed paste. */
  pasteWarning: boolean;
  /** Blade colour for the Saber Duel theme (src/theme/saber.ts preset id). */
  saberColor: string;
  /** Star-streak transition on workspace switch: "auto" = only with the Hyperspace theme. */
  hyperspaceTransition: HyperspaceMode;
  /** Saber effects (blade ignition, blade dividers, duel): "auto" = full with Saber Duel, subtle elsewhere. */
  saberEffects: SaberEffectsMode;
  /** Outside Saber Duel the blade follows the theme accent until the user picks a blade colour. */
  saberBladeFromTheme: boolean;
  /** Synthesized ignite / retract sound with the saber effects (off by default; uses the alert volume). */
  saberSound: boolean;
  /** Terminal right-click: "menu" = context menu (default); "paste" = copy selection / paste (Windows Terminal style). */
  rightClickAction: RightClickAction;
  /** Cost & context meter for Claude panes (opt-in; applies to newly started panes). */
  costMeter: boolean;
  /** The one-time "turn on the cost meter" hint was dismissed. */
  costMeterHintDismissed: boolean;
}

export type HyperspaceMode = "auto" | "on" | "off";
export type SaberEffectsMode = "auto" | "off" | "subtle" | "full";
export type RightClickAction = "menu" | "paste";
/** "toast": Windows notification in the background, in-app toast in front; "inApp": in-app toasts only; "off": Comms feed only. */
export type NotifyDelivery = "toast" | "inApp" | "off";
export type SoundSet = "comm" | "console" | "droid" | "none";

export interface QuietHours {
  enabled: boolean;
  /** "HH:MM", local time. A range may cross midnight (22:00 → 07:00). */
  start: string;
  end: string;
}

export interface AgentNotifyFilter {
  claude: boolean;
  codex: boolean;
  powershell: boolean;
  /** Generic / catalog tools. */
  other: boolean;
}

export interface NotificationSettings {
  enabled: boolean;
  /** Notify when a session goes quiet after working ("finished"). */
  onIdle: boolean;
  /** Notify on bell / notification escapes (OSC 9 / 777 / 99). */
  onBell: boolean;
  /** Short in-app sound with each alert (master switch; the set is `soundSet`). */
  sound: boolean;
  /** An agent is blocked on you: permission prompt, question, "waiting for you" status. */
  onInput: boolean;
  /** A session crashed, failed to start or reported an error. */
  onError: boolean;
  delivery: NotifyDelivery;
  soundSet: SoundSet;
  /** 0–100. */
  volume: number;
  /** Do not disturb: alerts only go to the Comms feed. */
  dnd: boolean;
  quietHours: QuietHours;
  /** Only alert while the window is in the background. */
  onlyWhenUnfocused: boolean;
  agents: AgentNotifyFilter;
  mutedSessions: SessionId[];
  mutedWorkspaces: string[];
}

export interface Layout {
  preset: LayoutPreset;
  maximized: SessionId | null;
  sizes: Record<string, number[]>;
}

export interface Group {
  id: string;
  name: string;
  layout: Layout;
  sessionIds: SessionId[];
}

export interface Workspace {
  id: string;
  name: string;
  projectDir: string | null;
  groups: Group[];
  activeGroupId: string | null;
  createdAt: string | null;
}

export interface WorktreeRef {
  path: string;
  branch: string | null;
}

/** What a pane shows. Missing (older state files) = "terminal". Use paneKind() from lib/paneKind. */
export type PaneKind = "terminal" | "browser";

export interface SessionMeta {
  id: SessionId;
  name: string;
  agent: AgentKind;
  cwd: string;
  /** Terminal (default) or browser pane. Browser panes have no process. */
  kind?: PaneKind;
  /** Browser panes: page to (re)open (http / https / file, <= 2048 chars). Always null for terminals. */
  url?: string | null;
  /** Browser panes: the pane name follows the page title. */
  titleAsName?: boolean;
  profileId: string | null;
  command: string | null;
  args: string[];
  env: EnvVar[];
  autoStart: boolean;
  resumeOnRestore: ResumeMode;
  agentSessionId: string | null;
  /** Catalog tool id for generic sessions. */
  preset?: string | null;
  worktree: WorktreeRef | null;
  createdAt: string | null;
  lastExitCode: number | null;
  /** Team role (lead, scout, builder, reviewer, verifier or custom; [a-z0-9-], <= 24 chars). */
  role?: string | null;
}

export interface PersistedState {
  version: number;
  settings: Settings;
  workspaces: Workspace[];
  sessions: SessionMeta[];
  activeWorkspaceId: string | null;
}

export interface AppErrorPayload {
  code: string;
  message: string;
}

export const DEFAULT_SETTINGS: Settings = {
  scrollbackLines: 5000,
  bufferKib: 2048,
  fontSize: 13,
  fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, monospace',
  lineHeight: 1.15,
  renderer: "auto",
  cursorBlink: false,
  defaultLayout: "grid",
  agentPaths: { claude: null, codex: null, powershell: null },
  sidebarCollapsed: false,
  inspectorOpen: false,
  statusBarDiagnostics: true,
  keybindings: {},
  theme: "deep-space",
  reduceMotion: false,
  uiDensity: "compact",
  notifications: {
    enabled: true,
    onIdle: true,
    onBell: true,
    sound: false,
    onInput: true,
    onError: true,
    delivery: "toast",
    soundSet: "comm",
    volume: 50,
    dnd: false,
    quietHours: { enabled: false, start: "22:00", end: "07:00" },
    onlyWhenUnfocused: false,
    agents: { claude: true, codex: true, powershell: true, other: true },
    mutedSessions: [],
    mutedWorkspaces: [],
  },
  saberColor: "blue",
  hyperspaceTransition: "auto",
  saberEffects: "auto",
  saberBladeFromTheme: true,
  saberSound: false,
  pasteWarning: true,
  rightClickAction: "menu",
  costMeter: false,
  costMeterHintDismissed: false,
};

// ---- Mission (shared task board file) ------------------------------------------------------------

/** `<projectDir>/.gridkeeper/mission.md`, read by mission_read / written by mission_write. */
export interface MissionFile {
  /** Absolute path of the mission file (whether or not it exists). */
  path: string;
  exists: boolean;
  /** File contents (UTF-8, at most 256 KiB; "" when missing). */
  text: string;
  /** Last-write time in ms since the epoch; null when missing. Pass back to mission_write for conflict checks. */
  modifiedMs: number | null;
}

export interface MissionChanged {
  projectDir: string;
  /** What changed: `.gridkeeper/mission.md`, or a file arriving in the lead control outbox
   *  (`.gridkeeper/outbox/`). Missing from older hosts: treat as both. `team.md` never emits. */
  file?: MissionChangeKind;
}

export type MissionChangeKind = "mission" | "outbox";

/** One instruction file directly in `<projectDir>/.gridkeeper/outbox/` (mission_outbox_list). */
export interface OutboxItem {
  /** File name only, e.g. "0007-builder-1.md". */
  name: string;
  /** Contents (UTF-8, BOM stripped), at most 16 KiB. */
  text: string;
  /** Last-write time in ms since the epoch (0 when unknown). */
  modifiedMs: number;
  /** The file is larger than 16 KiB: `text` is only its beginning. */
  truncated: boolean;
}

/** Where mission_outbox_archive moves a handled instruction file (outbox/sent/ or outbox/dismissed/). */
export type OutboxDisposition = "sent" | "dismissed";

/** A worktree's branch measured against a base branch (read-only, for Mission Control sign-off). */
export interface BranchSummary {
  isRepo: boolean;
  branch: string | null;
  /** The base actually used: the requested one, else the main worktree's branch; null when unresolvable. */
  base: string | null;
  /** Commits on HEAD not on base / on base not on HEAD. */
  ahead: number;
  behind: number;
  /** `git diff --shortstat base...HEAD` (committed work only). */
  filesChanged: number;
  insertions: number;
  deletions: number;
  /** Entries in `git status --porcelain` (uncommitted, incl. untracked). */
  uncommitted: number;
  lastCommitSubject: string | null;
  /** Last commit time in ms since the epoch. */
  lastCommitMs: number | null;
}

/** One file changed by the commits on HEAD since it left a base (`git diff -M base...HEAD`). */
export interface BranchFile {
  /** Repository-relative path on HEAD (forward slashes, as git prints it). */
  path: string;
  /** Rename / copy source. */
  origPath: string | null;
  /** Status letter from `--name-status`: A, M, D, R, C, T (similarity score dropped). */
  status: string;
  insertions: number;
  deletions: number;
  /** numstat printed `-\t-` (no line counts). */
  binary: boolean;
}

/** The committed work of a worktree's branch against a base (read-only). */
export interface BranchFiles {
  isRepo: boolean;
  branch: string | null;
  /** The base actually used: the requested one, else the main worktree's branch; null when unresolvable. */
  base: string | null;
  /** Commits on HEAD not on base. */
  ahead: number;
  /** Empty when HEAD is the base, there is no base, or nothing differs. */
  files: BranchFile[];
  /** More than 2000 files: the list was cut. */
  truncated: boolean;
}

// ---- Skills (Agent Skills from GitHub, installed into a project's .claude/skills / .agents/skills) -----

/** A GitHub repository from skills_search. */
export interface SkillRepo {
  /** `owner/name`. */
  fullName: string;
  description: string | null;
  stars: number;
  /** ISO 8601. */
  pushedAt: string | null;
  /** SPDX id (or license name). */
  license: string | null;
  topics: string[];
  htmlUrl: string;
  defaultBranch: string;
  archived: boolean;
}

/** skills_search sort: trending / top (skill topics, by stars) or a free-text search (best match / stars). */
export type SkillSort = "trending" | "top" | "best" | "stars";

/** One page of skills_search. A rate limit is a result (`rateLimited`), not an error. */
export interface SkillRepoPage {
  items: SkillRepo[];
  /** Total matches GitHub reports (it serves at most 1000). */
  total: number;
  page: number;
  rateLimited: boolean;
  /** Epoch seconds when the rate limit resets (when GitHub said). */
  resetAt: number | null;
  message: string | null;
  /** The query sent to api.github.com. */
  query: string;
  /** When GitHub answered (epoch ms). */
  fetchedAtMs: number;
  /** Served from the 10-minute in-memory cache. */
  cached: boolean;
}

export interface SkillFile {
  /** Relative to the skill folder, forward slashes. */
  path: string;
  size: number;
  /** Script / binary by extension (.ps1 .sh .bat .cmd .exe .js .py ...) or git's executable bit. */
  executable: boolean;
}

/** One skill (a folder with a SKILL.md) in a repository at a pinned commit. */
export interface SkillInfo {
  /** Folder in the repository ("" = the repository root). */
  path: string;
  /** Frontmatter `name`, else the folder name. */
  name: string;
  /** Folder name used on install (`.claude/skills/<installName>`). */
  installName: string;
  description: string | null;
  /** SKILL.md first. */
  files: SkillFile[];
  totalBytes: number;
  hasScripts: boolean;
  /** Full SKILL.md; null when not fetched (many skills) or unreadable: use skills_file. */
  skillMd: string | null;
  /** Git tree SHA of the skill folder (recorded on install, compared by update checks). */
  treeSha: string;
  /** Why it cannot be installed (over 200 files / 5 MB / 1 MB per file, unsafe names), if so. */
  blocked: string | null;
}

/** skills_inspect: a repository's skills, pinned to one commit. */
export interface RepoSkills {
  repo: string;
  /** The ref that was resolved (the default branch when none was given). */
  gitRef: string;
  commitSha: string;
  defaultBranch: string | null;
  description: string | null;
  stars: number | null;
  license: string | null;
  pushedAt: string | null;
  htmlUrl: string;
  archived: boolean;
  skills: SkillInfo[];
  warnings: string[];
  fetchedAtMs: number;
}

/** skills_file: one file at a pinned commit, for reading before install. */
export interface SkillFileText {
  path: string;
  /** UTF-8 text ("" for binary files), at most 256 KiB. */
  text: string;
  size: number;
  binary: boolean;
  truncated: boolean;
}

/** `<skill folder>/.gridkeeper-skill.json`. */
export interface SkillProvenance {
  repo: string;
  commitSha: string;
  /** Skill folder in the repository ("" = root). */
  path: string;
  treeSha: string | null;
  name: string | null;
  /** RFC 3339 (UTC). */
  installedAt: string;
}

/** Install targets, relative to the project folder. */
export type SkillTarget = ".claude/skills" | ".agents/skills";

export interface InstallResult {
  name: string;
  /** Installed folders relative to the project, e.g. ".claude/skills/pdf". */
  installed: string[];
  /** The subset of `installed` that replaced an existing folder. */
  replaced: string[];
  files: number;
  totalBytes: number;
  commitSha: string;
  warnings: string[];
}

/** A skill in the project's `.claude/skills/*` or `.agents/skills/*` (skills_installed). */
export interface InstalledSkill {
  /** Frontmatter `name`, else the folder name. */
  name: string;
  folder: string;
  description: string | null;
  target: SkillTarget;
  /** `<target>/<folder>`: pass to skills_remove. */
  dirRel: string;
  dirAbs: string;
  /** null: a local skill (not installed by Gridkeeper). */
  provenance: SkillProvenance | null;
  hasScripts: boolean;
  fileCount: number;
  /** A junction / symbolic link: listed, never removed. */
  isLink: boolean;
}

/** current: unchanged since the pinned commit; update: the skill folder changed; missing: gone upstream. */
export type SkillUpdateStatus = "current" | "update" | "missing";

export interface SkillUpdateCheck {
  repo: string;
  path: string;
  status: SkillUpdateStatus;
  pinnedSha: string;
  /** The default branch's commit now. */
  currentSha: string;
}
// ---- Mission replay (src-tauri/src/replay.rs) ----

/** One recording in `<projectDir>/.gridkeeper/replay/`. */
export interface ReplayInfo {
  name: string;
  sizeBytes: number;
  modifiedMs: number;
}

/** `replay_append` result: file size afterwards; `full` = the 5 MB cap was reached and the batch was NOT written. */
export interface ReplayAppend {
  sizeBytes: number;
  full: boolean;
}

/** A save destination chosen in the native dialog, authorized for one `replay_save_file` by `token`. */
export interface ReplaySaveTarget {
  token: string;
  path: string;
}

export type ReplayExportKind = "mp4" | "webm" | "gif";
// ---- Cost & context meter (Claude Code status line; src-tauri/src/meter) --------------------------

export const EVT_SESSION_METER = "session-meter";

/** How the pane's last launch went for the meter. */
export type MeterStatus =
  /** No launch seen in this app run (data, if any, is from an earlier run). */
  | "unknown"
  /** Launched with Gridkeeper's status line; data arrives with Claude's first status line update. */
  | "metered"
  /** The session passes its own --settings, so the meter stays off. */
  | "customSettings"
  /** Managed settings own the status line (or turn status line commands off). */
  | "managed"
  /** Not possible for this launch; `note` says why. */
  | "unavailable";

/** One pane's meter (payload of EVT_SESSION_METER and of meter_snapshot). Cost is Claude Code's own estimate. */
export interface SessionMeter {
  sessionId: SessionId;
  status: MeterStatus;
  note: string | null;
  /** The user's own status line is chained (still shown inside the pane). */
  chained: boolean;
  /** Claude's conversation id of the latest data (changes on /clear). */
  claudeSessionId: string | null;
  /** cost.total_cost_usd of the current conversation (resets on /clear). */
  costUsd: number | null;
  /** Running pane total: sum of the last cost per Claude conversation (survives /clear). */
  paneCostUsd: number | null;
  contextPct: number | null;
  contextSize: number | null;
  /** Tokens currently in the context window (not cumulative). */
  inputTokens: number | null;
  outputTokens: number | null;
  apiDurationMs: number | null;
  durationMs: number | null;
  model: string | null;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  /** When data was last written (ms since the epoch); null = no data yet. */
  updatedMs: number | null;
}
// ---- Agent browser (shared browser, a tab per agent; src-tauri/src/agent_browser/model.rs) --------

export const EVT_AGENT_BROWSER_STATE = "agent-browser-state";
export const EVT_AGENT_BROWSER_ACTIVITY = "agent-browser-activity";

export interface AgentBrowserSession {
  sessionId: SessionId;
  /** "Give this agent a browser" (applies at the next launch). */
  enabled: boolean;
  /** The running process was launched with the browser tools. */
  launched: boolean;
  /** Why the last launch got no browser tools. */
  launchNote: string | null;
  /** The agent's MCP helper is connected. */
  connected: boolean;
  hasTab: boolean;
  url: string | null;
  title: string | null;
  /** The user controls the tab; agent tool calls wait. */
  takenOver: boolean;
  /** The user stopped browsing for this agent. */
  stopped: boolean;
  busy: boolean;
  /** An open JavaScript confirm / prompt dialog. */
  dialog: string | null;
  lastAction: string | null;
  lastActionMs: number | null;
}

export type AgentBrowserPromptKind = "formSubmit" | "script" | "upload" | "download";

export interface AgentBrowserPrompt {
  id: number;
  sessionId: SessionId;
  kind: AgentBrowserPromptKind;
  origin: string | null;
  detail: string;
  createdMs: number;
  expiresMs: number;
  /** "Always allow <host>" is offered. */
  rememberHost: string | null;
}

export interface AgentBrowserState {
  running: boolean;
  browser: string | null;
  pid: number | null;
  executable: string | null;
  error: string | null;
  idleMinutes: number;
  allowlist: string[];
  sessions: AgentBrowserSession[];
  prompts: AgentBrowserPrompt[];
}

export type AgentBrowserOutcome = "ok" | "error" | "blocked" | "denied" | "info";

export interface AgentBrowserActivity {
  sessionId: SessionId;
  atMs: number;
  tool: string;
  summary: string;
  url: string | null;
  outcome: AgentBrowserOutcome;
}

/** Input for a taken-over tab; coordinates in CSS pixels of the page viewport. */
export type AgentBrowserInput =
  | { type: "mouse"; action: "down" | "up" | "move" | "wheel"; x: number; y: number; button?: "left" | "middle" | "right" | "none"; clickCount?: number; deltaX?: number; deltaY?: number; modifiers: number }
  | { type: "key"; action: "down" | "up"; key: string; code: string; keyCode: number; text?: string; modifiers: number }
  | { type: "text"; text: string };
