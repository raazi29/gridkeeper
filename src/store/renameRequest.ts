// "Rename…" from a context menu: asks the surface that owns the inline name editor (the pane header,
// or a Mission Control card) to enter edit mode. Ephemeral; consumed once by the matching component.

import { create } from "zustand";
import type { SessionId } from "../lib/types";

export type RenameSurface = "pane" | "mission";

interface RenameRequest {
  id: SessionId | null;
  where: RenameSurface;
  seq: number;
}

export const useRenameRequest = create<RenameRequest>()(() => ({ id: null, where: "pane", seq: 0 }));

export function requestRename(id: SessionId, where: RenameSurface): void {
  useRenameRequest.setState((s) => ({ id, where, seq: s.seq + 1 }));
}

export function clearRenameRequest(): void {
  useRenameRequest.setState({ id: null });
}

/** Selector: the pending request sequence for this session on this surface (0 = none). */
export const renameSeqFor = (id: SessionId, where: RenameSurface) => (s: RenameRequest) => (s.id === id && s.where === where ? s.seq : 0);
