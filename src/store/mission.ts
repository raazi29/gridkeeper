// Mission Control / Formations overlay state (ephemeral, not persisted).

import { create } from "zustand";
import { useAttentionUi } from "./attention";
import { useUi } from "./uiStore";

interface MissionUi {
  open: boolean;
  formationOpen: boolean;
  toggle: (open?: boolean) => void;
  openFormation: () => void;
  closeFormation: () => void;
}

export const useMission = create<MissionUi>()((set, get) => ({
  open: false,
  formationOpen: false,
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
  openFormation: () => {
    useUi.getState().closePalette();
    set({ formationOpen: true });
  },
  closeFormation: () => set({ formationOpen: false }),
}));
