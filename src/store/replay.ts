// Mission replay UI state (ephemeral zustand store): which projects are recording, the auto-record
// preference (localStorage, per machine) and the Replay dialog. The recorder itself (subscriptions,
// batching, file IO) lives in replay/recorder.ts; it publishes here only when a batch is flushed, so
// recording never causes per-event re-renders.

import { create } from "zustand";
import { selectActiveWorkspace, useApp } from "./appStore";

export interface RecordingStatus {
  /** Project folder as the workspace spells it. */
  dir: string;
  /** Recording file name (null while it is being chosen). */
  file: string | null;
  startedAt: number;
  /** Events written so far (updated per flush). */
  events: number;
  bytes: number;
  /** Started by the user ("rec") rather than automatically. */
  manual: boolean;
}

interface ReplayStore {
  /** By dirKey (see store/missionDoc). */
  recording: Record<string, RecordingStatus>;
  /** Record automatically while a mission file of the active project is open. Default on. */
  auto: boolean;
  dialog: { open: boolean; dir: string | null };
  /** Bumped when a recording file changes on disk (flush / stop / delete): the dialog re-lists. */
  version: number;
}

const LS_AUTO = "gridkeeper.replay.autoRecord";

function readAuto(): boolean {
  try {
    return globalThis.localStorage?.getItem(LS_AUTO) !== "0";
  } catch {
    return true;
  }
}

export const useReplay = create<ReplayStore>()(() => ({ recording: {}, auto: readAuto(), dialog: { open: false, dir: null }, version: 0 }));

export function setAutoRecord(on: boolean): void {
  try {
    globalThis.localStorage?.setItem(LS_AUTO, on ? "1" : "0");
  } catch {
    /* storage unavailable: the choice lasts for this run */
  }
  useReplay.setState({ auto: on });
}

/** Open the Replay dialog for a project (default: the active workspace's). */
export function openReplay(dir?: string | null): void {
  const d = dir ?? selectActiveWorkspace(useApp.getState())?.projectDir ?? null;
  useReplay.setState({ dialog: { open: true, dir: d } });
}

export function closeReplay(): void {
  useReplay.setState({ dialog: { open: false, dir: null } });
}

export function bumpReplayVersion(): void {
  useReplay.setState((s) => ({ version: s.version + 1 }));
}
