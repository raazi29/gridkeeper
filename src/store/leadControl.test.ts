import { beforeEach, describe, expect, it, vi } from "vitest";

// A fake webview localStorage, installed before the store module reads it.
class FakeStorage {
  map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}
const ls = new FakeStorage();
ls.setItem("gridkeeper.leadControl.v1:d:\\saved", JSON.stringify({ mode: "autopilot", paused: true, autoReview: false, shareOutput: true }));
ls.setItem("gridkeeper.leadControl.v1:d:\\bad", "{not json");
ls.setItem("gridkeeper.leadControl.v1:d:\\weird", JSON.stringify({ mode: "root", paused: "yes" }));
ls.setItem("unrelated", "x");
vi.stubGlobal("window", { localStorage: ls });

const store = await import("./leadControl");
const {
  countAutopilot,
  countQueued,
  countWaiting,
  DEFAULT_POLICY,
  editProposal,
  effectiveMode,
  getProposal,
  loadPolicies,
  patchProposal,
  policyOf,
  removeDirProposals,
  removeProposal,
  resetLeadControlStoreForTests,
  setPolicy,
  upsertProposal,
  useLeadControl,
} = store;
type Proposal = import("./leadControl").Proposal;

function proposal(key: string, p: Partial<Proposal> = {}): Proposal {
  return {
    key,
    dirKey: "d:\\proj",
    dir: "D:\\proj",
    source: "outbox",
    file: `${key}.md`,
    modifiedMs: 1,
    from: "lead",
    lead: null,
    to: ["builder-1"],
    targets: ["B1"],
    targetLabel: "builder-1",
    action: "message",
    text: "[from lead] hi",
    edited: false,
    warnings: [],
    status: "proposal",
    reason: null,
    createdAt: 1,
    queuedAt: null,
    delivered: [],
    busy: false,
    ...p,
  };
}

beforeEach(() => resetLeadControlStoreForTests());

describe("policies", () => {
  it("are loaded from localStorage, sanitized, keyed by the normalized folder", () => {
    const all = loadPolicies();
    expect(all["d:\\saved"]).toEqual({ mode: "autopilot", paused: true, autoReview: false, shareOutput: true });
    expect(all["d:\\weird"]).toEqual({ mode: "off", paused: false, autoReview: true, shareOutput: false });
    expect(all["d:\\bad"]).toBeUndefined();
    expect(Object.keys(all)).not.toContain("unrelated");
    expect(policyOf("D:/Saved/")).toEqual(all["d:\\saved"]);
    expect(policyOf("D:\\never")).toBe(DEFAULT_POLICY);
    expect(policyOf(null)).toBe(DEFAULT_POLICY);
    expect(DEFAULT_POLICY).toEqual({ mode: "off", paused: false, autoReview: true, shareOutput: false });
  });

  it("setPolicy persists; leaving autopilot clears pause; the default removes the entry", () => {
    setPolicy("D:\\Proj", { mode: "autopilot" });
    expect(JSON.parse(ls.getItem("gridkeeper.leadControl.v1:d:\\proj") ?? "")).toEqual({ mode: "autopilot", paused: false, autoReview: true, shareOutput: false });
    setPolicy("d:/proj/", { paused: true });
    expect(policyOf("D:\\proj").paused).toBe(true);
    setPolicy("D:\\proj", { mode: "advisor" });
    expect(policyOf("D:\\proj")).toEqual({ mode: "advisor", paused: false, autoReview: true, shareOutput: false });
    setPolicy("D:\\proj", { mode: "off" });
    expect(ls.getItem("gridkeeper.leadControl.v1:d:\\proj")).toBeNull();
    expect(policyOf("D:\\proj").mode).toBe("off");
  });

  it("effectiveMode: paused autopilot behaves like advisor", () => {
    expect(effectiveMode({ mode: "autopilot", paused: true })).toBe("advisor");
    expect(effectiveMode({ mode: "autopilot", paused: false })).toBe("autopilot");
    expect(effectiveMode({ mode: "off", paused: true })).toBe("off");
  });

  it("a storage that throws never breaks the store", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    });
    try {
      expect(loadPolicies()).toEqual({});
      expect(setPolicy("D:\\x", { mode: "advisor" }).mode).toBe("advisor");
      expect(policyOf("D:\\x").mode).toBe("advisor");
    } finally {
      vi.stubGlobal("window", { localStorage: ls });
    }
  });
});

describe("proposals", () => {
  it("upsert keeps position, patch / edit / remove", () => {
    upsertProposal(proposal("a"));
    upsertProposal(proposal("b"));
    upsertProposal(proposal("a", { text: "new" }));
    expect(useLeadControl.getState().proposals.map((p) => `${p.key}:${p.text}`)).toEqual(["a:new", "b:[from lead] hi"]);
    patchProposal("b", { status: "queued" });
    expect(getProposal("b")?.status).toBe("queued");
    editProposal("a", "edited");
    expect(getProposal("a")).toMatchObject({ text: "edited", edited: true });
    const before = useLeadControl.getState().proposals;
    patchProposal("missing", { text: "x" });
    removeProposal("missing");
    expect(useLeadControl.getState().proposals).toBe(before);
    removeProposal("a");
    expect(useLeadControl.getState().proposals.map((p) => p.key)).toEqual(["b"]);
    upsertProposal(proposal("c", { dirKey: "d:\\other" }));
    removeDirProposals("d:\\proj");
    expect(useLeadControl.getState().proposals.map((p) => p.key)).toEqual(["c"]);
  });

  it("primitive counters for the badges", () => {
    upsertProposal(proposal("a", { status: "queued" }));
    upsertProposal(proposal("b"));
    upsertProposal(proposal("c", { dirKey: "d:\\other", status: "queued" }));
    const s = useLeadControl.getState();
    expect(countQueued(s)).toBe(2);
    expect(countQueued(s, "d:\\proj")).toBe(1);
    expect(countWaiting(s)).toBe(1);
    expect(countWaiting(s, "d:\\other")).toBe(0);
    useLeadControl.setState({ active: { "d:\\saved": "D:\\saved", "d:\\proj": "D:\\proj" } });
    setPolicy("D:\\proj", { mode: "autopilot" });
    const t = useLeadControl.getState();
    expect(countAutopilot(t, false)).toBe(2); // d:\saved is autopilot (paused) and controlled
    expect(countAutopilot(t, true)).toBe(1);
  });
});
