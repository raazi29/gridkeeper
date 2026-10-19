// Team templates UI intent: which panel the Formations dialog's "Templates" tab opens on. Set by the palette
// commands ("Team template: import… / export…"), consumed once by the tab when it mounts.

import { create } from "zustand";
import { useMission } from "./mission";

export type TemplateIntent = "browse" | "import" | "export";

export const useTeamTemplateUi = create<{ intent: TemplateIntent | null }>()(() => ({ intent: null }));

export function openTeamTemplates(intent: TemplateIntent = "browse"): void {
  useTeamTemplateUi.setState({ intent });
  useMission.getState().openFormation();
}

export function takeTemplateIntent(): TemplateIntent | null {
  const i = useTeamTemplateUi.getState().intent;
  if (i) useTeamTemplateUi.setState({ intent: null });
  return i;
}
