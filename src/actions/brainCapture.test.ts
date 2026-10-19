import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrainIndex, BrainNoteFile, BrainNoteMeta, MissionChanged } from "../lib/types";

// ---- mocks: an in-memory brain behind IPC, toasts, localStorage ---------------------------------------------

interface Stored {
  text: string;
  ms: number;
}
const notes = new Map<string, Stored>(); // `${inbox ? "i" : "n"}|${slug}`
let clock = 1000;
const calls: string[] = [];
let listener: ((ev: MissionChanged) => void) | null = null;

function metaOf(key: string, s: Stored): BrainNoteMeta {
  const [box, slug] = key.split("|");
  const title = /title: (.*)/.exec(s.text)?.[1] ?? slug;
  return {
    slug,
    inbox: box === "i",
    title,
    kind: /kind: (.*)/.exec(s.text)?.[1] ?? "fact",
    tags: [],
    source: null,
    created: null,
    updated: null,
    confidence: box === "i" ? "suggested" : "confirmed",
    supersedes: null,
    supersededBy: null,
    excerpt: s.text.split("---").pop()?.trim().slice(0, 160) ?? "",
    modifiedMs: s.ms,
    bytes: s.text.length,
  };
}

function index(): BrainIndex {
  const all = [...notes].map(([k, s]) => metaOf(k, s));
  return { dir: "D:\\p\\.gridkeeper\\brain", exists: notes.size > 0, shared: false, notes: all.filter((n) => !n.inbox), inbox: all.filter((n) => n.inbox), ignored: [], truncated: false };
}

function file(slug: string, inbox: boolean): BrainNoteFile {
  const s = notes.get(`${inbox ? "i" : "n"}|${slug}`);
  return { slug, inbox, path: `D:\\p\\.gridkeeper\\brain\\${inbox ? "inbox" : "notes"}\\${slug}.md`, exists: !!s, text: s?.text ?? "", modifiedMs: s?.ms ?? null };
}

vi.mock("../lib/ipc", () => ({
  errorMessage: (e: unknown) => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e)),
  onMissionChanged: (cb: (ev: MissionChanged) => void) => {
    listener = cb;
    return Promise.resolve(() => {
      listener = null;
    });
  },
  ipc: {
    log: vi.fn(async () => {}),
    missionWatch: vi.fn(async (dir: string) => void calls.push(`watch ${dir}`)),
    missionUnwatch: vi.fn(async (dir: string) => void calls.push(`unwatch ${dir}`)),
    brainList: vi.fn(async () => index()),
    brainRead: vi.fn(async (_d: string, slug: string, inbox: boolean) => file(slug, inbox)),
    brainWrite: vi.fn(async (_d: string, slug: string, text: string, inbox: boolean, expected?: number | null) => {
      const key = `${inbox ? "i" : "n"}|${slug}`;
      const cur = notes.get(key);
      if (expected !== undefined && (cur?.ms ?? null) !== expected) throw { code: "conflict", message: "changed" };
      calls.push(`write ${key}`);
      notes.set(key, { text, ms: ++clock });
      return file(slug, inbox);
    }),
    brainDelete: vi.fn(async (_d: string, slug: string, inbox: boolean) => {
      const key = `${inbox ? "i" : "n"}|${slug}`;
      const cur = notes.get(key);
      if (!cur) throw { code: "not_found", message: "gone" };
      notes.delete(key);
      calls.push(`delete ${key}`);
      return cur.text;
    }),
    brainApprove: vi.fn(async (_d: string, slug: string) => {
      const cur = notes.get(`i|${slug}`)!;
      notes.delete(`i|${slug}`);
      notes.set(`n|${slug}`, { text: cur.text.replace("confidence: suggested", "confidence: confirmed"), ms: ++clock });
      calls.push(`approve ${slug}`);
      return slug;
    }),
    brainSearch: vi.fn(async () => []),
    brainShare: vi.fn(async (_d: string, share: boolean) => ({ shared: share, gitignorePath: "x" })),
  },
}));

const toasts: string[] = [];
vi.mock("./notify", () => ({ notify: (kind: string, msg: string) => void toasts.push(`${kind}: ${msg}`) }));
const actionToasts: { message: string; action?: { label: string; run: () => void } }[] = [];
vi.mock("../store/uiStore", () => ({
  actionToast: (t: { message: string; action?: { label: string; run: () => void } }) => void actionToasts.push(t),
  confirmDialog: async () => true,
}));

const store = new Map<string, string>();
vi.stubGlobal("window", {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

const { installBrainCapture, isLeadProposal, resetBrainCaptureForTests, submitSuggestions } = await import("./brainCapture");
const brain = await import("../store/brain");
const { useMissionDocs } = await import("../store/missionDoc");
const { useLeadControl } = await import("../store/leadControl");
const { parseMission } = await import("../lib/missionDoc");

const DIR = "D:\\p";
const board = (tasks: string) => `# Mission: Ship it\n\n## Tasks\n${tasks}`;

function setBoard(text: string) {
  useMissionDocs.setState({
    byDir: { [DIR]: { file: { path: `${DIR}\\.gridkeeper\\mission.md`, exists: true, text, modifiedMs: ++clock }, doc: parseMission(text), loading: false, error: null } },
  });
}

const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => new Promise((r) => setTimeout(r, 0)));
async function flush() {
  for (let i = 0; i < 5; i++) await settle();
}

beforeEach(() => {
  notes.clear();
  calls.length = 0;
  toasts.length = 0;
  store.clear();
  resetBrainCaptureForTests();
  brain.resetBrainForTests();
  useMissionDocs.setState({ byDir: {} });
  useLeadControl.setState({ proposals: [] });
  actionToasts.length = 0;
});

describe("capture engine", () => {
  it("baseline first, then a done task with a note becomes an inbox suggestion (once)", async () => {
    setBoard(board("- [x] Old task @a\n  - note: this was already done before the app started\n- [~] Pick the cache key @builder\n"));
    const off = installBrainCapture();
    await flush();
    expect(calls).toEqual([]);

    setBoard(board("- [x] Old task @a\n  - note: this was already done before the app started\n- [x] Pick the cache key @builder\n  - note: the cache key must include the lock file hash\n"));
    await flush();
    expect(calls).toEqual(["write i|the-cache-key-must-include-the-lock-file-hash"]);
    const text = notes.get("i|the-cache-key-must-include-the-lock-file-hash")!.text;
    expect(text).toContain("confidence: suggested");
    expect(text).toContain("source: task “Pick the cache key”");
    expect(actionToasts.map((t) => t.message)).toEqual(["Brain: 1 suggested memory in the inbox"]);

    // The same board again (re-read) or the same trigger later: nothing new.
    setBoard(board("- [x] Old task @a\n  - note: this was already done before the app started\n- [x] Pick the cache key @builder\n  - note: the cache key must include the lock file hash\n"));
    await flush();
    expect(calls).toHaveLength(1);
    off();
  });

  it("skips duplicates of existing memories and respects the capture switch", async () => {
    notes.set("n|cache", { text: "---\ntitle: The cache key must include the lock file hash\n---\nCI reuses stale deps otherwise.", ms: 1 });
    setBoard(board("- [~] A @x\n- [~] B @x\n"));
    const off = installBrainCapture();
    setBoard(board("- [x] A @x\n  - note: the cache key must include the lock file hash\n- [~] B @x\n"));
    await flush();
    expect(calls).toEqual([]);

    brain.setBrainPrefs(DIR, { capture: false });
    setBoard(board("- [x] A @x\n  - note: the cache key must include the lock file hash\n- [x] B @x\n  - note: never run two dev sandboxes at once\n"));
    await flush();
    expect(calls).toEqual([]);
    off();
  });

  it("auto-approve writes Gridkeeper's own captures straight to notes/ as confirmed", async () => {
    brain.setBrainPrefs(DIR, { autoApprove: true });
    setBoard(board("- [!] blocked: needs the staging database — Run the migration @b\n"));
    const off = installBrainCapture();
    setBoard(board("- [~] Run the migration @b\n"));
    await flush();
    expect(calls).toEqual(["write n|blocker-needs-the-staging-database"]);
    expect(notes.get("n|blocker-needs-the-staging-database")!.text).toContain("confidence: confirmed");
    expect(actionToasts[0].message).toBe("Brain: remembered 1 memory");
    off();
  });

  it("captures decisions from the lead's outbox messages, not from self-declared leads", async () => {
    const off = installBrainCapture();
    const base = { dirKey: "d:\\p", dir: DIR, file: "1.md", modifiedMs: 1, to: ["all"], targets: [], targetLabel: "all", action: "message" as const, edited: false, warnings: [], status: "proposal" as const, reason: null, createdAt: 1, queuedAt: null, delivered: [], busy: false };
    useLeadControl.setState({
      proposals: [
        { ...base, key: "k1", source: "outbox", from: "builder-1 (self-declared)", lead: null, text: "[from builder-1] We decided to rewrite everything in Rust." },
        { ...base, key: "k2", source: "outbox", from: "lead", lead: "lead", text: "[from lead] We decided to keep the REST API stable until v2." },
      ],
    });
    await flush();
    expect(calls).toEqual(["write i|we-decided-to-keep-the-rest-api-stable-until-v2"]);
    expect(isLeadProposal({ source: "review", from: "auto-review", lead: "lead" })).toBe(false);
    off();
  });

  it("submitSuggestions caps a batch at five", async () => {
    const topics = ["keychain tokens", "cache keys", "sandbox ports", "worktree paths", "release tags", "lint rules", "commit messages", "test fixtures"];
    const list = topics.map((t, i) => ({ key: `k${i}`, title: `Remember ${t}`, kind: "fact" as const, tags: [], source: "user", body: `Something about ${t}.` }));
    expect(await submitSuggestions(DIR, list)).toBe(5);
  });
});

describe("brain store actions", () => {
  it("forget offers Undo that writes the note back", async () => {
    notes.set("n|a", { text: "---\ntitle: A\n---\nbody", ms: 5 });
    expect(await brain.forgetNote(DIR, "a", "A")).toBe(true);
    expect(notes.has("n|a")).toBe(false);
    const toast = actionToasts[actionToasts.length - 1];
    expect(toast.message).toBe("Forgot “A”");
    toast.action!.run();
    await flush();
    expect(notes.get("n|a")?.text).toBe("---\ntitle: A\n---\nbody");
  });

  it("Undo picks a free name when the slug was taken meanwhile", async () => {
    notes.set("i|s", { text: "suggestion", ms: 5 });
    await brain.discardSuggestion(DIR, "s", "S");
    notes.set("i|s", { text: "someone else", ms: 6 });
    actionToasts[actionToasts.length - 1].action!.run();
    await flush();
    expect(notes.get("i|s")?.text).toBe("someone else");
    expect(notes.get("i|s-2")?.text).toBe("suggestion");
  });

  it("approve moves the selection to the confirmed note; save reports conflicts", async () => {
    notes.set("i|x", { text: "---\ntitle: X\nconfidence: suggested\n---\nb", ms: 5 });
    brain.patchBrain({ selected: { slug: "x", inbox: true } });
    expect(await brain.approveSuggestion(DIR, "x")).toBe("x");
    expect(brain.useBrain.getState().selected).toEqual({ slug: "x", inbox: false });
    const r = await brain.saveNote(DIR, "x", false, "new text", 1);
    expect(r).toEqual({ ok: false, conflict: true });
    expect(toasts.some((t) => t.startsWith("warn: The note changed on disk"))).toBe(true);
    const ok = await brain.saveNote(DIR, "x", false, "new text", notes.get("n|x")!.ms);
    expect(ok.ok).toBe(true);
  });

  it("addMemory writes a confirmed note with a free slug; preferences persist per project", async () => {
    notes.set("n|use-pnpm", { text: "x", ms: 1 });
    const slug = await brain.addMemory({ dir: DIR, title: "Use pnpm", kind: "convention", tags: ["build"], body: "Never npm install.", source: "user", supersedes: null, target: "notes" });
    expect(slug).toBe("use-pnpm-2");
    expect(notes.get("n|use-pnpm-2")!.text).toContain("confidence: confirmed");
    expect(brain.brainPrefs(DIR)).toEqual({ capture: true, autoApprove: false, briefs: true });
    brain.setBrainPrefs("d:/p/", { briefs: false });
    expect(brain.brainBriefsOn(DIR)).toBe(false);
  });

  it("the panel's watch is ref-counted and re-reads on brain events only", async () => {
    const release = brain.acquireBrain(DIR);
    await flush();
    expect(calls).toEqual([`watch ${DIR}`]);
    expect(brain.useBrain.getState().byDir[DIR]?.index?.exists).toBe(false);
    notes.set("n|z", { text: "---\ntitle: Z\n---\nz", ms: 9 });
    listener?.({ projectDir: "d:/p", file: "mission" });
    await flush();
    expect(brain.useBrain.getState().byDir[DIR]?.index?.notes).toHaveLength(0);
    listener?.({ projectDir: "d:/p", file: "brain" });
    await flush();
    expect(brain.useBrain.getState().byDir[DIR]?.index?.notes.map((n) => n.slug)).toEqual(["z"]);
    release();
    release();
    expect(calls).toEqual([`watch ${DIR}`, `unwatch ${DIR}`]);
  });
});
