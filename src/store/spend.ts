// Spend guard runtime: books every `session-meter` change into the ledger (src/lib/spend.ts), saves it to
// `<data>/spend-ledger.json` (debounced, only after a change), and runs each workspace's guard: a toast at the
// warn share, the chosen action at 100 % (toast; pause that folder's Autopilot; optional OS notification) and a
// persistent banner (components/spend/SpendGuardLayer.tsx). Agents are never stopped. Event driven: the only
// timer is the pending save.

import { create } from "zustand";
import { errorMessage, ipc } from "../lib/ipc";
import {
  bookMeter,
  dueSteps,
  emptyLedger,
  formatBudget,
  formatUsd,
  markResumed,
  markTripped,
  markWarned,
  normalizeGuard,
  parseLedger,
  pruneLedger,
  spendNote,
  spentToday,
  type SpendLedger,
} from "../lib/spend";
import type { SessionId, SessionMeter, SpendGuard } from "../lib/types";
import { notify } from "../actions/notify";
import { t } from "../i18n";
import { useApp } from "./appStore";
import { policyOf, setPolicy } from "./leadControl";
import { useMeter } from "./meter";

interface SpendState {
  /** null until the stored ledger was read. */
  ledger: SpendLedger | null;
}

export const useSpend = create<SpendState>()(() => ({ ledger: null }));

export const SAVE_DEBOUNCE_MS = 2000;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

async function flushSave(): Promise<void> {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  if (!dirty) return;
  dirty = false;
  const l = useSpend.getState().ledger;
  if (!l) return;
  try {
    await ipc.spendLedgerWrite(JSON.stringify(l));
  } catch (e) {
    ipc.log("warn", `spend ledger: could not save: ${errorMessage(e)}`);
  }
}

function setLedger(next: SpendLedger): void {
  if (next === useSpend.getState().ledger) return;
  useSpend.setState({ ledger: next });
  dirty = true;
  saveTimer ??= setTimeout(() => void flushSave(), SAVE_DEBOUNCE_MS);
}

/** The workspace that owns a pane right now. */
export function workspaceOfSession(id: SessionId): { id: string; name: string; projectDir: string | null } | null {
  for (const w of useApp.getState().persisted.workspaces) {
    if (w.groups.some((g) => g.sessionIds.includes(id))) return { id: w.id, name: w.name, projectDir: w.projectDir };
  }
  return null;
}

export function guardOf(workspaceId: string): SpendGuard | null {
  return normalizeGuard(useApp.getState().persisted.settings.spendGuards?.[workspaceId]);
}

/** Set (or clear with null) a workspace's guard. */
export function setGuard(workspaceId: string, guard: SpendGuard | null): void {
  const cur = useApp.getState().persisted.settings.spendGuards ?? {};
  const next = { ...cur };
  if (guard) next[workspaceId] = guard;
  else delete next[workspaceId];
  useApp.getState().updateSettings({ spendGuards: next });
}

let osPermission: Promise<boolean> | null = null;

async function osNotify(title: string, body: string): Promise<void> {
  if (useApp.getState().persisted.settings.notifications?.dnd) return;
  try {
    const n = await import("@tauri-apps/plugin-notification");
    osPermission ??= (async () => (await n.isPermissionGranted()) || (await n.requestPermission()) === "granted")();
    if (await osPermission) n.sendNotification({ title, body });
  } catch (e) {
    ipc.log("warn", `spend guard notification failed: ${errorMessage(e)}`);
  }
}

/** The 100 % action. Returns the project folder whose Autopilot was paused (null: nothing paused). */
function applyTrip(workspaceId: string, g: SpendGuard, spent: number): string | null {
  const ws = useApp.getState().persisted.workspaces.find((w) => w.id === workspaceId);
  const name = ws?.name ?? t("spend.workspaceFallback");
  let pausedDir: string | null = null;
  if (g.action !== "warn" && ws?.projectDir) {
    const p = policyOf(ws.projectDir);
    if (p.mode === "autopilot" && !p.paused) {
      setPolicy(ws.projectDir, { paused: true });
      pausedDir = ws.projectDir;
    }
  }
  const vals = { name, spent: formatUsd(spent), budget: formatBudget(g.budgetUsd) };
  notify("warn", t(pausedDir ? "spend.toast.tripPaused" : "spend.toast.trip", { ...vals, note: spendNote() }), 12000);
  if (g.action === "pauseNotify") void osNotify(t("spend.os.title", { name }), t(pausedDir ? "spend.os.bodyPaused" : "spend.os.body", vals));
  return pausedDir;
}

/** Run the guards of these workspaces against today's totals (one-time steps only). */
export function evaluateGuards(workspaceIds: Iterable<string>, now = Date.now()): void {
  let l = useSpend.getState().ledger;
  if (!l) return;
  for (const ws of new Set(workspaceIds)) {
    const g = guardOf(ws);
    if (!g) continue;
    const spent = spentToday(l, ws, now);
    const { warn, trip } = dueSteps(l, ws, spent, g, now);
    if (trip) {
      l = markTripped(l, ws, g, now, applyTrip(ws, g, spent));
    } else if (warn) {
      const name = useApp.getState().persisted.workspaces.find((w) => w.id === ws)?.name ?? t("spend.workspaceFallback");
      notify("warn", t("spend.toast.warn", { name, spent: formatUsd(spent), budget: formatBudget(g.budgetUsd), pct: g.warnPct }), 8000);
      l = markWarned(l, ws, g, now);
    }
  }
  setLedger(l);
}

/** Book meter updates into the ledger and run the guards they touch. */
export function bookMeters(meters: Iterable<SessionMeter>, now = Date.now()): void {
  const start = useSpend.getState().ledger;
  if (!start) return;
  let l = pruneLedger(start, now);
  const touched: string[] = [];
  for (const m of meters) {
    const ws = workspaceOfSession(m.sessionId);
    const b = bookMeter(l, m, ws?.id ?? null, now);
    l = b.ledger;
    if (b.delta > 0 && ws) touched.push(ws.id);
  }
  setLedger(l);
  if (touched.length) evaluateGuards(touched, now);
}

/** "Resume" on the banner: Autopilot the guard paused runs again; no new budget stop today for this budget. */
export function resumeGuard(workspaceId: string, now = Date.now()): void {
  const l = useSpend.getState().ledger;
  const g = guardOf(workspaceId);
  if (!l || !g) return;
  const dir = l.tripped[workspaceId]?.pausedDir;
  if (dir && policyOf(dir).mode === "autopilot" && policyOf(dir).paused) setPolicy(dir, { paused: false });
  setLedger(markResumed(l, workspaceId, g, now));
}

/** "Raise budget" on the banner. Autopilot the guard paused runs again when the new budget leaves room. */
export function raiseBudget(workspaceId: string, budgetUsd: number, now = Date.now()): void {
  const g = guardOf(workspaceId);
  const next = normalizeGuard({ ...(g ?? {}), budgetUsd });
  if (!next) return;
  setGuard(workspaceId, next);
  const l = useSpend.getState().ledger;
  const dir = l?.tripped[workspaceId]?.pausedDir;
  if (l && dir && spentToday(l, workspaceId, now) < next.budgetUsd && policyOf(dir).mode === "autopilot" && policyOf(dir).paused) {
    setPolicy(dir, { paused: false });
  }
  evaluateGuards([workspaceId], now);
}

/** Install once (Shell): read the ledger, then follow meter changes and guard settings. Returns cleanup. */
export function installSpendGuard(): () => void {
  let disposed = false;
  let prevMeters = useMeter.getState().bySession;
  let prevGuards = useApp.getState().persisted.settings.spendGuards;
  const unsubMeter = useMeter.subscribe((s) => {
    if (s.bySession === prevMeters) return;
    const before = prevMeters;
    prevMeters = s.bySession;
    if (!useSpend.getState().ledger) return; // booked in one go once the ledger is loaded
    const changed: SessionMeter[] = [];
    for (const id in s.bySession) if (s.bySession[id] !== before[id]) changed.push(s.bySession[id]);
    if (changed.length) bookMeters(changed);
  });
  const unsubApp = useApp.subscribe((s) => {
    const guards = s.persisted.settings.spendGuards;
    if (guards === prevGuards) return;
    prevGuards = guards;
    // A lowered budget (or a new guard) may already be reached.
    if (useSpend.getState().ledger) evaluateGuards(Object.keys(guards ?? {}));
  });
  void ipc
    .spendLedgerRead()
    .catch((e) => {
      ipc.log("warn", `spend ledger: could not read: ${errorMessage(e)}`);
      return null;
    })
    .then((text) => {
      if (disposed) return;
      useSpend.setState({ ledger: parseLedger(text) ?? emptyLedger() });
      bookMeters(Object.values(useMeter.getState().bySession));
      evaluateGuards(Object.keys(useApp.getState().persisted.settings.spendGuards ?? {}));
    });
  return () => {
    disposed = true;
    unsubMeter();
    unsubApp();
    void flushSave();
  };
}

/** Tests only. */
export function resetSpendForTests(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = null;
  dirty = false;
  osPermission = null;
  useSpend.setState({ ledger: null });
}
