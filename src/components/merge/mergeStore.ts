// Which merge dialog is open (one at a time). Opened from a sign-off card ("merge…").

import { create } from "zustand";
import { evidencePath } from "../../actions/handoff";
import { notify } from "../../actions/notify";
import type { SessionId } from "../../lib/types";
import { useApp } from "../../store/appStore";

export interface MergeDialogRequest {
  sessionId: SessionId;
  /** The session's worktree (its evidence folder). */
  path: string;
}

export const useMergeDialog = create<{ req: MergeDialogRequest | null }>()(() => ({ req: null }));

export function openMergeDialog(sessionId: SessionId): void {
  const meta = useApp.getState().persisted.sessions.find((m) => m.id === sessionId);
  const path = evidencePath(meta);
  if (!path) {
    notify("warn", "This session has no folder to merge from");
    return;
  }
  useMergeDialog.setState({ req: { sessionId, path } });
}

export function closeMergeDialog(): void {
  useMergeDialog.setState({ req: null });
}
