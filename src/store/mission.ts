// Mission Control / Formations overlay state (ephemeral, not persisted).

import { create } from "zustand";
import { useAttentionUi } from "./attention";
import { useUi } from "./uiStore";

/** `collapsed` key of the lead box (group ids are UUIDs, so they never collide with it). */
export const LEAD_BOX = "lead";

interface MissionUi {
  open: boolean;
  formationOpen: boolean;
  /** Group a formation should launch into ("Launch formation here"); used only while that group is empty. */
  formationGroupId: string | null;
  /** Collapsed Mission Control boxes: a group id (lane) or LEAD_BOX. Ephemeral (this run only). */
  collapsed: Record<string, true>;
  toggleCollapsed: (key: string, collapsed?: boolean) => void;
  toggle: (open?: boolean) => void;
  openFormation: (opts?: { groupId?: string | null }) => void;
  closeFormation: () => void;
}

export const useMission = create<MissionUi>()((set, get) => ({
  open: false,
  formationOpen: false,
  formationGroupId: null,
  collapsed: {},
  toggleCollapsed: (key, collapsed) =>
    set((s) => {
      const next = collapsed ?? !s.collapsed[key];
      if (next === !!s.collapsed[key]) return s;
      const out = { ...s.collapsed };
      if (next) out[key] = true;
      else delete out[key];
      return { collapsed: out };
    }),
  toggle: (open) => {
    const next = open ?? !get().open;
    if (next) {
      // Never stack two full-window overlays.
      useAttentionUi.getState().close();
      useAttentionUi.getState().toggleComms(false);
      useUi.getState().closePalette();
    }
    set({ open: next });
  },
  openFormation: (opts) => {
    useUi.getState().closePalette();
    set({ formationOpen: true, formationGroupId: opts?.groupId ?? null });
  },
  closeFormation: () => set({ formationOpen: false, formationGroupId: null }),
}));
