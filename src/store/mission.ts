// Mission Control / Formations overlay state (ephemeral, not persisted).

import { create } from "zustand";
import { useAttentionUi } from "./attention";
import { useUi } from "./uiStore";

interface MissionUi {
  open: boolean;
  formationOpen: boolean;
  /** Group a formation should launch into ("Launch formation here"); used only while that group is empty. */
  formationGroupId: string | null;
  toggle: (open?: boolean) => void;
  openFormation: (opts?: { groupId?: string | null }) => void;
  closeFormation: () => void;
}

export const useMission = create<MissionUi>()((set, get) => ({
  open: false,
  formationOpen: false,
  formationGroupId: null,
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
