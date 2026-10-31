// Low-memory guard, frontend half (Rust: src-tauri/src/memguard.rs; ADR-024): the level Rust reports,
// the banner (one per entry into a level, shown again only after memory recovered) and the launches held
// while memory is critically low. Event driven: one memory_status read at boot, then `memory-status` events,
// which Rust sends on every level change and on every 5 s reading while memory is short. Nothing polls here.
// Statuses carry an increasing `seq`; an older one (e.g. a slow initial read) never replaces a newer one.

import { create } from "zustand";
import { ipc, onMemoryStatus } from "../lib/ipc";
import type { MemoryLevel, MemoryStatus, SessionId, Settings } from "../lib/types";
import { useApp } from "./appStore";

const RANK: Readonly<Record<MemoryLevel, number>> = { ok: 0, low: 1, critical: 2 };

/** `announced`: the most severe level shown since memory was last ok. `visible`: the open banner, if any. */
export interface BannerState {
  announced: MemoryLevel;
  visible: MemoryLevel | null;
}

export const BANNER_IDLE: BannerState = { announced: "ok", visible: null };

/**
 * Banner after a level reading (pure). A banner opens when the level is worse than anything announced since
 * memory was last ok; going back to ok resets that. Dropping from critical to low updates an open banner and
 * never reopens a dismissed one. Rust's hysteresis keeps the level itself from flapping.
 */
export function nextBanner(prev: BannerState, level: MemoryLevel): BannerState {
  if (level === "ok") return BANNER_IDLE;
  if (RANK[level] > RANK[prev.announced]) return { announced: level, visible: level };
  return { announced: prev.announced, visible: prev.visible ? level : null };
}

/** Warnings (banner + chip) are on unless turned off in Settings. */
export const warningsOn = (s: Partial<Settings>) => s.lowMemoryWarnings !== false;
/** The launch hold needs the warnings: without the banner nobody would see why an agent waits. */
export const holdOn = (s: Partial<Settings>) => warningsOn(s) && s.lowMemoryHold !== false;

export interface HeldLaunch {
  id: SessionId;
  name: string;
}

interface MemGuardStore {
  /** Last reading (null before the first; `supported: false` on macOS). */
  status: MemoryStatus | null;
  banner: BannerState;
  /** Launches waiting for memory, in request order (one entry per session). */
  held: HeldLaunch[];
}

export const useMemGuard = create<MemGuardStore>()(() => ({ status: null, banner: BANNER_IDLE, held: [] }));

/** Resolvers of the held launches (several for a session the user tried to start twice). */
const waiters = new Map<SessionId, (() => void)[]>();

/** Effective level: "ok" where the guard does not run. */
export function levelOf(s: MemoryStatus | null): MemoryLevel {
  return s?.supported ? s.level : "ok";
}

const settings = () => useApp.getState().persisted.settings;

/** Apply a status from Rust (event or the initial read). Ignored unless newer than the current one. */
export function applyMemoryStatus(s: MemoryStatus): void {
  const cur = useMemGuard.getState().status;
  if (cur && s.seq <= cur.seq) return;
  const level = levelOf(s);
  // With the warnings off the banner state stays idle, so turning them on starts from the current level.
  useMemGuard.setState((st) => ({ status: s, banner: warningsOn(settings()) ? nextBanner(st.banner, level) : BANNER_IDLE }));
  if (level !== "critical") releaseHeld();
}

export function dismissMemoryBanner(): void {
  useMemGuard.setState((st) => ({ banner: { ...st.banner, visible: null } }));
}

/** Reopen the banner (status-bar chip) while memory is not ok. The figures are current: Rust sends every reading then. */
export function showMemoryBanner(): void {
  const level = levelOf(useMemGuard.getState().status);
  if (level !== "ok") useMemGuard.setState({ banner: nextBanner(BANNER_IDLE, level) });
}

/** Settings changed: warnings off clears the banner state; hold (or warnings) off releases held launches. */
export function applyMemorySettings(s: Partial<Settings>): void {
  if (!warningsOn(s) && useMemGuard.getState().banner !== BANNER_IDLE) useMemGuard.setState({ banner: BANNER_IDLE });
  if (!holdOn(s)) releaseHeld();
}

/** Whether a launch requested now would be held. */
export function shouldHoldLaunch(): boolean {
  return levelOf(useMemGuard.getState().status) === "critical" && holdOn(settings());
}

/**
 * The launch gate (called by `startSession`, the one place every launch passes through: new panes, restore,
 * formations, the startup retry; restarts skip it). Resolves at once unless memory is critically low and the
 * hold is on; then it resolves when memory recovers, the hold is turned off, the pane is closed, or the user
 * picks "Launch anyway".
 */
export function launchGate(id: SessionId, name: string): Promise<void> {
  if (!shouldHoldLaunch()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    waiters.set(id, [...(waiters.get(id) ?? []), resolve]);
    useMemGuard.setState((st) => (st.held.some((h) => h.id === id) ? st : { held: [...st.held, { id, name }] }));
  });
}

/** Let held launches go: the given sessions, or all of them. */
export function releaseHeld(ids?: SessionId[]): void {
  const list = ids ?? [...waiters.keys()];
  if (list.length === 0) return;
  for (const id of list) {
    const ws = waiters.get(id);
    waiters.delete(id);
    ws?.forEach((r) => r());
  }
  const gone = new Set(list);
  useMemGuard.setState((st) => ({ held: st.held.filter((h) => !gone.has(h.id)) }));
}

let started = false;

/**
 * Install once, before any launch (App boot): subscribe, then read the current level so restored sessions
 * already see it. Waits at most 2 s for the reading.
 */
export async function startMemoryWatch(): Promise<void> {
  if (started) return;
  started = true;
  await onMemoryStatus(applyMemoryStatus).catch(() => {});
  useApp.subscribe((s, prev) => {
    if (s.persisted.settings !== prev.persisted.settings) applyMemorySettings(s.persisted.settings);
  });
  const initial = ipc.memoryStatus().then(applyMemoryStatus, () => {});
  await Promise.race([initial, new Promise((r) => setTimeout(r, 2000))]);
}

/** Test helper: back to the initial state. */
export function resetMemGuardForTests(): void {
  releaseHeld();
  useMemGuard.setState({ status: null, banner: BANNER_IDLE, held: [] });
}
