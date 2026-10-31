import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, STATE_VERSION, type ResumeMode, type SessionInfo, type SessionMeta } from "../lib/types";

const started: { id: string; resume: ResumeMode }[] = [];
const notices: string[] = [];

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("../terminal/registry", () => ({
  clearTerminal: vi.fn(),
  getTerminalSize: () => null,
  writeLocalNotice: (_id: string, text: string) => void notices.push(text),
}));
vi.mock("../browser/nav", () => ({ dropNav: vi.fn(), getNav: () => undefined }));
vi.mock("./notify", () => ({ notify: vi.fn() }));
vi.mock("../lib/ipc", () => ({
  errorMessage: String,
  ipc: {
    sessionStart: vi.fn(async (spec: { id: string; resume: ResumeMode }) => {
      started.push({ id: spec.id, resume: spec.resume });
      return info(spec.id, { state: "running" });
    }),
    sessionStop: vi.fn(async () => {}),
    sessionRemove: vi.fn(async () => {}),
  },
}));

import { closeSession, maybeAutoRetry, renameSession, restartSession, restoreSessions, startSession, stopSession } from "./sessions";
import { useApp } from "../store/appStore";
import { applyMemoryStatus, resetMemGuardForTests, useMemGuard } from "../store/memguard";

let memSeq = 0;
/** Puts the low-memory guard at `level` (a newer status each call). */
function memoryLevel(level: "ok" | "critical") {
  const GB = 1024 ** 3;
  applyMemoryStatus({
    supported: true,
    level,
    limitBytes: 40 * GB,
    freeBytes: level === "ok" ? 8 * GB : GB / 2,
    lowBytes: 2 * GB,
    criticalBytes: GB,
    top: [],
    agentsBytes: null,
    appBytes: null,
    reserveHeld: level === "ok",
    seq: ++memSeq,
  });
}

function info(id: string, state: SessionInfo["state"], extra: Partial<SessionInfo> = {}): SessionInfo {
  return { id, name: id, agent: "codex", pid: 1, state, cwd: "D:/p", profileId: null, commandDisplay: "", startedAt: null, endedAt: null, bytesOut: 0, ...extra };
}

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    name: id,
    agent: "codex",
    cwd: "D:/p",
    profileId: null,
    command: null,
    args: [],
    env: [],
    autoStart: true,
    resumeOnRestore: { mode: "continue" },
    agentSessionId: null,
    worktree: null,
    createdAt: null,
    lastExitCode: null,
    ...extra,
  };
}

function seed(metas: SessionMeta[], runtime: Record<string, SessionInfo> = {}) {
  useApp.setState({
    runtime,
    persisted: {
      version: STATE_VERSION,
      settings: DEFAULT_SETTINGS,
      workspaces: [
        { id: "w", name: "w", projectDir: null, activeGroupId: "g", createdAt: null, groups: [{ id: "g", name: "g", layout: { preset: "grid", maximized: null, sizes: {} }, sessionIds: metas.map((m) => m.id) }] },
      ],
      sessions: metas,
      activeWorkspaceId: "w",
    },
  });
}

beforeEach(() => {
  started.length = 0;
  notices.length = 0;
  resetMemGuardForTests();
});

describe("low-memory launch hold", () => {
  it("holds new launches while critical, but never a restart", async () => {
    seed([meta("new", { agent: "powershell" }), meta("old", { agent: "powershell", cwd: "D:/o" })], {
      old: info("old", { state: "exited", code: 0 }, { agent: "powershell" }),
    });
    memoryLevel("critical");
    const held = startSession("new");
    await restartSession("old", { mode: "none" });
    expect(started.map((s) => s.id)).toEqual(["old"]);
    expect(useMemGuard.getState().held.map((h) => h.id)).toEqual(["new"]);
    memoryLevel("ok");
    expect(await held).toBe(true);
    expect(started.map((s) => s.id)).toEqual(["old", "new"]);
  });

  it("a held launch released by closing the pane starts nothing and takes no stagger slot", async () => {
    // Claude launches are spaced 350 ms apart; a consumed slot would delay the next one.
    seed([meta("gone", { agent: "claude" }), meta("next", { agent: "claude", cwd: "D:/n" })]);
    memoryLevel("critical");
    const held = startSession("gone");
    await closeSession("gone");
    expect(await held).toBe(false);
    expect(useMemGuard.getState().held).toEqual([]);
    memoryLevel("ok");
    const t0 = Date.now();
    await startSession("next");
    expect(Date.now() - t0).toBeLessThan(300);
    expect(started.map((s) => s.id)).toEqual(["next"]);
  });
});

describe("startSession: Codex panes sharing a folder", () => {
  it("continue becomes the picker when another Codex pane has the same folder (any case), stays continue otherwise", async () => {
    seed([meta("a"), meta("b", { cwd: "d:/P" }), meta("c", { cwd: "D:/other" })]);
    await startSession("a", { mode: "continue" });
    await startSession("c", { mode: "continue" });
    expect(started).toEqual([
      { id: "a", resume: { mode: "pick" } },
      { id: "c", resume: { mode: "continue" } },
    ]);
  });
});

describe("restoreSessions", () => {
  it("skips sessions the host already knows (renderer reload), starts the rest", async () => {
    seed([meta("live", { cwd: "D:/1" }), meta("done", { cwd: "D:/2" }), meta("fresh", { cwd: "D:/3" })], {
      live: info("live", { state: "running" }),
      done: info("done", { state: "exited", code: 0 }),
    });
    await restoreSessions();
    await vi.waitFor(() => expect(started.map((s) => s.id)).toEqual(["fresh"]));
  });
});

describe("renameSession", () => {
  it("turns off following the page title", () => {
    seed([meta("a", { titleAsName: true })]);
    renameSession("a", " Docs ");
    expect(useApp.getState().persisted.sessions[0]).toMatchObject({ name: "Docs", titleAsName: false });
  });
});

describe("userStopped", () => {
  it("is cleared by the next start, so a later startup failure is still retried once", async () => {
    seed([meta("a", { cwd: "D:/x" })]);
    vi.stubGlobal("window", { setTimeout: vi.fn() }); // the retry itself is timer-driven; only its scheduling is checked
    await stopSession("a"); // user stop; the process exited with code 0, so nothing consumed the flag
    await startSession("a");
    maybeAutoRetry(info("a", { state: "exited", code: 1 }, { startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:02Z" }));
    expect(notices.some((n) => n.includes("retrying once"))).toBe(true);
    vi.unstubAllGlobals();
  });
});
