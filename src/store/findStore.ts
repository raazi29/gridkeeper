// Which pane shows the find bar (at most one). `nonce` changes on every open so a repeated
// "terminal.find" re-focuses and selects the query.

import { create } from "zustand";
import type { SessionId } from "../lib/types";

interface FindStore {
  sessionId: SessionId | null;
  nonce: number;
  open: (id: SessionId) => void;
  close: () => void;
}

export const useFind = create<FindStore>()((set) => ({
  sessionId: null,
  nonce: 0,
  open: (sessionId) => set((s) => ({ sessionId, nonce: s.nonce + 1 })),
  close: () => set({ sessionId: null }),
}));
