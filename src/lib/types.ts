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
