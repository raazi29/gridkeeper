// installPhoneAlerts: lead proposals and finished mission boards reach Rust once, with generic text only.
// The sender is mocked: nothing here touches the network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhoneAlert, PhoneConfig } from "./types";

const sent: PhoneAlert[] = [];
const ipcMock = vi.hoisted(() => ({
  phoneAlertSend: vi.fn(),
  phoneAlertsGet: vi.fn(),
  log: vi.fn(),
}));
vi.mock("./ipc", () => ({
  ipc: ipcMock,
  onMissionChanged: () => Promise.resolve(() => {}),
  errorMessage: (e: unknown) => String(e),
}));
const toasts: string[] = [];
vi.mock("../store/uiStore", async (orig) => ({
  ...(await orig<object>()),
  actionToast: (t: { message: string }) => void toasts.push(t.message),
}));

import { useApp } from "../store/appStore";
import { resetLeadControlStoreForTests, upsertProposal, useLeadControl, type Proposal } from "../store/leadControl";
import { resetMissionDocsForTests, useMissionDocs } from "../store/missionDoc";
import { parseMission } from "./missionDoc";
import { installPhoneAlerts, notifyPhone, setPhoneConfig } from "./phoneAlerts";

const CFG: PhoneConfig = {
  enabled: true,
  server: "https://ntfy.sh",
  topic: "gk-abcdefghijklmnopqrstuvwx",
  events: { needsInput: true, error: true, proposal: true, missionDone: true, done: false },
  minPriority: 3,
  quietHours: { enabled: false, start: "22:00", end: "07:00" },
  includeNames: true,
  includeTaskNames: false,
  onlyWhenAway: false,
};

const DIR = "D:\\work\\acme-secret";
const flush = () => new Promise((r) => setTimeout(r, 0));

function proposal(key: string, status: Proposal["status"] = "proposal"): Proposal {
  return {
    key,
    dirKey: DIR.toLowerCase(),
    dir: DIR,
    source: "outbox",
    file: "001.md",
    modifiedMs: 0,
    from: "lead",
    lead: "lead",
    to: ["builder-1"],
    targets: [],
    targetLabel: "builder-1",
    action: "message",
    text: "please rm -rf the D:\\work\\acme-secret\\build folder",
    edited: false,
    warnings: [],
    status,
    reason: null,
    createdAt: 0,
    queuedAt: null,
    delivered: [],
    busy: false,
  };
}

function board(text: string) {
  const file = { path: `${DIR}\\.gridkeeper\\mission.md`, exists: true, text, modifiedMs: Date.now() };
  useMissionDocs.setState((s) => ({ byDir: { ...s.byDir, [DIR]: { file, doc: parseMission(text), loading: false, error: null } } }));
}

let uninstall: () => void = () => {};

beforeEach(() => {
  sent.length = 0;
  toasts.length = 0;
  ipcMock.phoneAlertSend.mockReset().mockImplementation(async (a: PhoneAlert) => {
    sent.push(a);
    return { outcome: "sent", detail: null, firstFailure: false };
  });
  setPhoneConfig(CFG);
  resetLeadControlStoreForTests();
  resetMissionDocsForTests();
  useApp.setState((s) => ({ persisted: { ...s.persisted, workspaces: [{ id: "w1", name: "OAuth demo", projectDir: DIR, groups: [], activeGroupId: null, createdAt: null }] } }));
});

afterEach(() => uninstall());

describe("installPhoneAlerts", () => {
  it("tells each waiting proposal once, without its text or folder", async () => {
    upsertProposal(proposal("old")); // already waiting before install: not told
    uninstall = installPhoneAlerts();
    upsertProposal(proposal("a"));
    upsertProposal({ ...proposal("a"), text: "edited" });
    upsertProposal(proposal("q", "queued")); // autopilot will deliver it: not the user's business yet
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "proposal", title: "Lead proposal waiting · OAuth demo", priority: 4 });
    expect(JSON.stringify(sent[0].title + sent[0].message)).not.toMatch(/rm -rf|acme|work/);
    // The queued item gives up and becomes a proposal: told now.
    upsertProposal(proposal("q", "proposal"));
    await flush();
    expect(sent).toHaveLength(2);
    expect(useLeadControl.getState().proposals).toHaveLength(3);
  });

  it("tells a board whose last task gets checked off, once; the first read is only a baseline", async () => {
    uninstall = installPhoneAlerts();
    board("# Mission: Add OAuth login\n## Tasks\n- [x] a\n- [x] b\n"); // first sighting, already done: baseline
    await flush();
    expect(sent).toHaveLength(0);
    board("# Mission: Add OAuth login\n## Tasks\n- [x] a\n- [ ] b\n- [ ] c\n");
    board("# Mission: Add OAuth login\n## Tasks\n- [x] a\n- [x] b\n- [ ] c\n");
    await flush();
    expect(sent).toHaveLength(0);
    board("# Mission: Add OAuth login\n## Tasks\n- [x] a\n- [x] b\n- [x] c\n");
    board("# Mission: Add OAuth login\n## Tasks\n- [x] a\n- [x] b\n- [x] c\n\nnotes\n");
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "missionDone", title: "Mission done (3/3)" });
    expect(sent[0].message).not.toContain("OAuth login");
  });

  it("does nothing while phone alerts are off", async () => {
    setPhoneConfig({ ...CFG, enabled: false });
    uninstall = installPhoneAlerts();
    upsertProposal(proposal("a"));
    await notifyPhone({ kind: "needsInput", key: "s:1", paneName: "x" });
    expect(ipcMock.phoneAlertSend).not.toHaveBeenCalled();
  });

  it("tells a failure once", async () => {
    ipcMock.phoneAlertSend.mockReset().mockResolvedValueOnce({ outcome: "failed", detail: "HTTP 403", firstFailure: true }).mockResolvedValue({ outcome: "paused", detail: null, firstFailure: false });
    await notifyPhone({ kind: "error", key: "s:1" });
    await notifyPhone({ kind: "error", key: "s:2" });
    expect(toasts).toEqual(["Phone alert not delivered"]);
  });
});
