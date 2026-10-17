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
}

export interface NotificationSettings {
  enabled: boolean;
  /** Notify when a session goes quiet after working ("finished"). */
  onIdle: boolean;
  /** Notify on bell / notification escapes / "waiting for you" status. */
  onBell: boolean;
  /** Short in-app sound with each alert. */
  sound: boolean;
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

export interface SessionMeta {
  id: SessionId;
  name: string;
  agent: AgentKind;
  cwd: string;
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
  notifications: { enabled: true, onIdle: true, onBell: true, sound: false },
};
