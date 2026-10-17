import { beforeEach, describe, expect, it } from "vitest";
import { getCommand, runCommand } from "../actions/commands";
import { DEFAULT_BINDINGS } from "../keybindings/combo";
import { useAttentionUi } from "./attention";
import { useMission } from "./mission";
import { useUi } from "./uiStore";

describe("mission store", () => {
  beforeEach(() => {
    useMission.setState({ open: false, formationOpen: false, formationGroupId: null });
    useAttentionUi.setState({ overlay: null, commsOpen: false });
    useUi.getState().closePalette();
  });

  it("toggle() flips; toggle(true/false) sets", () => {
    useMission.getState().toggle();
    expect(useMission.getState().open).toBe(true);
    useMission.getState().toggle();
    expect(useMission.getState().open).toBe(false);
    useMission.getState().toggle(true);
    useMission.getState().toggle(true);
    expect(useMission.getState().open).toBe(true);
    useMission.getState().toggle(false); // Esc / × close
    expect(useMission.getState().open).toBe(false);
  });

  it("opening closes the other full-window overlays and the palette", () => {
    useAttentionUi.setState({ overlay: "fleet", commsOpen: true });
    useUi.getState().openPalette("all");
    useMission.getState().toggle(true);
    expect(useAttentionUi.getState().overlay).toBeNull();
    expect(useAttentionUi.getState().commsOpen).toBe(false);
    expect(useUi.getState().palette.open).toBe(false);
  });

  it("closing leaves other overlays alone", () => {
    useMission.getState().toggle(true);
    useAttentionUi.setState({ overlay: "broadcast" });
    useMission.getState().toggle(false);
    expect(useAttentionUi.getState().overlay).toBe("broadcast");
  });

  it("the palette command and Ctrl+Shift+U binding open it", () => {
    expect(DEFAULT_BINDINGS["view.mission"]).toBe("ctrl+shift+u");
    expect(getCommand("view.mission")).toBeDefined();
    runCommand("view.mission");
    expect(useMission.getState().open).toBe(true);
    runCommand("view.mission");
    expect(useMission.getState().open).toBe(false);
  });

  it("openFormation keeps Mission Control as it is and remembers the target group", () => {
    useMission.getState().toggle(true);
    useMission.getState().openFormation({ groupId: "g1" });
    expect(useMission.getState().open).toBe(true);
    expect(useMission.getState().formationOpen).toBe(true);
    expect(useMission.getState().formationGroupId).toBe("g1");
    useMission.getState().closeFormation();
    expect(useMission.getState().formationGroupId).toBeNull();
    useMission.getState().openFormation();
    expect(useMission.getState().formationGroupId).toBeNull();
  });
});
