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
  profileId?: string | null;
  command?: string | null;
  args?: string[];
  env?: EnvVar[];
  resume?: ResumeMode;
  /** Pin a NEW conversation id (claude --session-id). */
  agentSessionId?: string | null;
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

export interface AgentAvailability {
  kind: AgentKind;
  path: string | null;
  version: string | null;
  error: string | null;
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
};
