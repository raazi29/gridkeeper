import { afterAll, describe, expect, it } from "vitest";
import {
  addDays,
  announcement,
  chipText,
  creditedSessions,
  dayKey,
  daysBetween,
  emptyLog,
  FLIGHTLOG_VERSION,
  heatLevel,
  heatWeeks,
  isDayKey,
  MEDALS,
  missionFinished,
  newlyDone,
  parseLog,
  projectHash,
  RANKS,
  rankFor,
  rankProgress,
  recordCommits,
  recordMission,
  resetLog,
  serializeLog,
  statusLine,
  streakInfo,
  weekday,
  type FlightLogData,
} from "./flightlog";
import { parseMission } from "./missionDoc";

// Local-date behaviour is checked in a zone with DST (US Eastern: 2026-03-08 spring forward,
// 2026-11-01 fall back). Node re-reads TZ when it is assigned.
// Set at module load: describe bodies (and their constants) run before any beforeAll hook.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const ORIGINAL_TZ = env.TZ;
env.TZ = "America/New_York";
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete env.TZ;
  else env.TZ = ORIGINAL_TZ;
});

/** Local time in the test zone. */
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

const days = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, 1]));
const run = (from: string, n: number) => Array.from({ length: n }, (_, i) => addDays(from, i));

describe("local dates", () => {
  it("buckets by the local calendar day", () => {
    expect(dayKey(at(2026, 10, 19, 0, 5))).toBe("2026-10-19");
    expect(dayKey(at(2026, 10, 19, 23, 59))).toBe("2026-10-19");
    // 03:30 UTC is still the previous evening in New York.
    expect(dayKey(Date.UTC(2026, 9, 20, 3, 30))).toBe("2026-10-19");
  });

  it("handles DST transitions", () => {
    // Spring forward: 02:00 → 03:00 on 2026-03-08 (a 23-hour day).
    expect(dayKey(at(2026, 3, 8, 0, 30))).toBe("2026-03-08");
    expect(dayKey(at(2026, 3, 8, 23, 30))).toBe("2026-03-08");
    expect(at(2026, 3, 9, 0, 0) - at(2026, 3, 8, 0, 0)).toBe(23 * 3600_000);
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    // Fall back: 01:00–02:00 happens twice on 2026-11-01 (a 25-hour day).
    expect(dayKey(at(2026, 11, 1, 1, 30))).toBe("2026-11-01");
    expect(dayKey(at(2026, 11, 1, 23, 59))).toBe("2026-11-01");
    expect(daysBetween("2026-10-31", "2026-11-02")).toBe(2);
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(addDays("2026-03-08", -1)).toBe("2026-03-07");
  });

  it("streaks run straight through DST days", () => {
    const d = days(...run("2026-03-05", 7)); // includes 2026-03-08
    expect(streakInfo(d, "2026-03-11").current).toBe(7);
    const f = days(...run("2026-10-29", 5)); // includes 2026-11-01
    expect(streakInfo(f, "2026-11-02").current).toBe(5);
  });

  it("validates day keys and does calendar arithmetic", () => {
    expect(isDayKey("2026-02-28")).toBe(true);
    expect(isDayKey("2026-02-30")).toBe(false);
    expect(isDayKey("2026-2-3")).toBe(false);
    expect(isDayKey(20261019)).toBe(false);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(daysBetween("2026-01-01", "2027-01-01")).toBe(365);
    expect(weekday("2026-10-19")).toBe(0); // a Monday
    expect(weekday("2026-10-25")).toBe(6);
  });
});

describe("streak and shields", () => {
  it("counts consecutive mission days and stays alive until today ends", () => {
    const d = days("2026-10-14", "2026-10-15", "2026-10-16");
    expect(streakInfo(d, "2026-10-16")).toMatchObject({ current: 3, todayDone: true });
    expect(streakInfo(d, "2026-10-17")).toMatchObject({ current: 3, todayDone: false, shieldsInUse: 0 });
    expect(streakInfo(d, "2026-10-18").current).toBe(0); // 10-17 missed, no shield
    expect(streakInfo({}, "2026-10-18")).toMatchObject({ current: 0, best: 0, lastDay: null });
  });

  it("earns one shield per 7 mission days, at most 2", () => {
    expect(streakInfo(days(...run("2026-09-01", 6)), "2026-09-06").shields).toBe(0);
    expect(streakInfo(days(...run("2026-09-01", 7)), "2026-09-07").shields).toBe(1);
    expect(streakInfo(days(...run("2026-09-01", 14)), "2026-09-14").shields).toBe(2);
    expect(streakInfo(days(...run("2026-09-01", 28)), "2026-09-28").shields).toBe(2);
  });

  it("a shield forgives one missed day", () => {
    const d = days(...run("2026-09-01", 7), "2026-09-09"); // 09-08 missed
    const s = streakInfo(d, "2026-09-09");
    expect(s.current).toBe(8);
    expect(s.shields).toBe(0);
    // Still pending: a missed yesterday is covered while the shield lasts.
    const p = streakInfo(days(...run("2026-09-01", 7)), "2026-09-09");
    expect(p).toMatchObject({ current: 7, shields: 0, shieldsInUse: 1 });
  });

  it("a gap longer than the shields restarts the streak and keeps the shields", () => {
    const d = days(...run("2026-09-01", 7), "2026-09-11"); // 3 missed, 1 shield
    const s = streakInfo(d, "2026-09-11");
    expect(s.current).toBe(1);
    expect(s.shields).toBe(1);
    expect(s.best).toBe(7);
  });

  it("two shields cover two missed days", () => {
    const d = days(...run("2026-09-01", 14), "2026-09-17");
    expect(streakInfo(d, "2026-09-17")).toMatchObject({ current: 15, shields: 0 });
  });

  it("ignores days after `today`", () => {
    expect(streakInfo(days("2026-10-10", "2026-10-11"), "2026-10-10").current).toBe(1);
  });
});

describe("ranks", () => {
  it("has ascending thresholds starting at 0", () => {
    expect(RANKS[0].min).toBe(0);
    for (let i = 1; i < RANKS.length; i++) expect(RANKS[i].min).toBeGreaterThan(RANKS[i - 1].min);
    expect(RANKS.map((r) => r.name)).toEqual(["Cadet", "Pilot", "Flight Lead", "Wing Commander", "Captain", "Commodore", "Admiral", "Fleet Admiral"]);
  });

  it("maps totals to ranks and progress", () => {
    expect(rankFor(0).name).toBe("Cadet");
    expect(rankFor(4).name).toBe("Cadet");
    expect(rankFor(5).name).toBe("Pilot");
    expect(rankFor(100).name).toBe("Captain");
    expect(rankFor(99999).name).toBe("Fleet Admiral");
    expect(rankProgress(10)).toMatchObject({ toNext: 5, fraction: 0.5 });
    expect(rankProgress(2000)).toMatchObject({ next: null, toNext: 0, fraction: 1 });
  });

  it("formats the chip and the replay line", () => {
    expect(chipText(6, rankFor(40))).toBe("6-day streak · Wing Commander");
    expect(chipText(0, rankFor(0))).toBe("Cadet");
    const d: FlightLogData = { ...emptyLog(), days: { ...days(...run("2026-10-01", 7)), "2026-10-08": 120 } };
    expect(statusLine(d, "2026-10-07")).toBe("Day 7 streak · Pilot");
    expect(statusLine(d, "2026-10-08")).toBe("Day 8 streak · Captain");
    expect(statusLine(d, "2026-09-30")).toBeNull();
    expect(statusLine(d, "2026-10-20")).toBe("Captain");
  });
});

// ---- recording ----------------------------------------------------------------------------------

const PROJECT = "D:\\work\\shop";
const doc = (lines: string[]) => parseMission(lines.join("\n"));

describe("mission diffs", () => {
  it("finds tasks that went to done, matched by text", () => {
    const a = doc(["# Mission: x", "- [ ] one @a", "- [~] two", "- [x] three", "- [ ] four"]);
    const b = doc(["# Mission: x", "- [x] one @a", "- [x] two", "- [x] three", "- [ ] four", "- [x] brand new"]);
    expect(newlyDone(a, b).map((t) => t.text)).toEqual(["one", "two"]);
    expect(missionFinished(a, b)).toBe(false);
    const c = doc(["# Mission: x", "- [x] one", "- [x] two", "- [x] three", "- [x] four"]);
    expect(missionFinished(b, c)).toBe(true);
    expect(missionFinished(c, c)).toBe(false);
    expect(missionFinished(doc(["# x"]), doc(["# x"]))).toBe(false);
  });

  it("credits sessions by name, then by role, never for @all", () => {
    const team = [
      { id: "s1", name: "builder 1", role: "builder" },
      { id: "s2", name: "builder 2", role: "builder" },
      { id: "s3", name: "lead", role: "lead" },
    ];
    expect(creditedSessions({ owners: ["builder-2"] }, team)).toEqual(["s2"]);
    expect(creditedSessions({ owners: ["builders"] }, team)).toEqual(["s1", "s2"]);
    expect(creditedSessions({ owners: ["all"] }, team)).toEqual([]);
    expect(creditedSessions({ owners: [] }, team)).toEqual([]);
  });
});

describe("recordMission", () => {
  const t = at(2026, 10, 19, 14);

  it("counts completions, days, projects and agents", () => {
    const r = recordMission(emptyLog(), { project: PROJECT, goal: "Shop", completions: [{ text: "one", at: t, agents: ["s1"] }, { text: "two", at: t, agents: ["s1", "s2"] }] }, t);
    expect(r.changed).toBe(true);
    expect(r.data.tasks).toBe(2);
    expect(r.data.days["2026-10-19"]).toBe(2);
    expect(r.data.projects).toEqual([projectHash(PROJECT)]);
    expect(r.data.agents).toHaveLength(2);
    // Nothing readable is stored.
    const raw = serializeLog(r.data);
    expect(raw).not.toContain("shop");
    expect(raw).not.toContain("one");
    expect(raw).not.toContain("s1");
  });

  it("is idempotent per project + task text + day", () => {
    const u = { project: PROJECT, goal: "Shop", completions: [{ text: "Write  tests", at: t, agents: [] }] };
    const a = recordMission(emptyLog(), u, t);
    const b = recordMission(a.data, { ...u, completions: [{ text: "write tests", at: t + 3600_000, agents: [] }] }, t + 3600_000);
    expect(b.changed).toBe(false);
    expect(b.data.tasks).toBe(1);
    // Same project spelled differently: still the same project.
    const c = recordMission(a.data, { ...u, project: "d:/work/shop/" }, t);
    expect(c.data.tasks).toBe(1);
    // Another project, or the next day: counts.
    expect(recordMission(a.data, { ...u, project: "D:\\work\\other" }, t).data.tasks).toBe(2);
    const next = at(2026, 10, 20, 9);
    expect(recordMission(a.data, { ...u, completions: [{ text: "write tests", at: next, agents: [] }] }, next).data.tasks).toBe(2);
  });

  it("counts a finished mission once per project + goal + day", () => {
    const u = { project: PROJECT, goal: "Shop", completions: [{ text: "one", at: t, agents: [] }], finished: { at: t, clean: false } };
    const a = recordMission(emptyLog(), u, t);
    expect(a.data.missions).toBe(1);
    expect(a.medals.map((m) => m.id)).toContain("first-jump");
    const b = recordMission(a.data, { ...u, completions: [] }, t);
    expect(b.data.missions).toBe(1);
    expect(b.medals).toEqual([]);
  });

  it("does nothing while disabled", () => {
    const off = { ...emptyLog(), enabled: false };
    const r = recordMission(off, { project: PROJECT, goal: null, completions: [{ text: "x", at: t, agents: [] }] }, t);
    expect(r.changed).toBe(false);
    expect(r.data).toBe(off);
  });

  it("promotes once when a threshold is crossed", () => {
    let d = emptyLog();
    const promos: string[] = [];
    for (let i = 0; i < 16; i++) {
      const r = recordMission(d, { project: PROJECT, goal: "g", completions: [{ text: `task ${i}`, at: t, agents: [] }] }, t);
      d = r.data;
      if (r.promoted) promos.push(r.promoted.name);
    }
    expect(promos).toEqual(["Pilot", "Flight Lead"]);
    expect(d.rank).toBe(2);
  });
});

describe("medals", () => {
  const ids = (r: { medals: { id: string }[] }) => r.medals.map((m) => m.id);

  it("has ten distinct medals", () => {
    expect(MEDALS).toHaveLength(10);
    expect(new Set(MEDALS.map((m) => m.id)).size).toBe(10);
  });

  it("night shift: a task done between 00:00 and 05:00 local", () => {
    const late = at(2026, 10, 19, 4, 59);
    expect(ids(recordMission(emptyLog(), { project: PROJECT, goal: "g", completions: [{ text: "a", at: late, agents: [] }] }, late))).toContain("night-shift");
    const morning = at(2026, 10, 19, 5, 0);
    expect(ids(recordMission(emptyLog(), { project: PROJECT, goal: "g", completions: [{ text: "a", at: morning, agents: [] }] }, morning))).not.toContain("night-shift");
  });

  it("hyperspace: 10 tasks in one day", () => {
    const t = at(2026, 10, 19, 15);
    const completions = Array.from({ length: 10 }, (_, i) => ({ text: `t${i}`, at: t, agents: [] }));
    const r = recordMission(emptyLog(), { project: PROJECT, goal: "g", completions }, t);
    expect(ids(r)).toContain("hyperspace");
    expect(ids(recordMission(emptyLog(), { project: PROJECT, goal: "g", completions: completions.slice(0, 9) }, t))).not.toContain("hyperspace");
  });

  it("seven suns: a 7-day streak", () => {
    let d = emptyLog();
    let got: string[] = [];
    for (let i = 0; i < 7; i++) {
      const t = at(2026, 10, 10 + i, 12);
      const r = recordMission(d, { project: PROJECT, goal: "g", completions: [{ text: "daily", at: t, agents: [] }] }, t);
      d = r.data;
      got = got.concat(ids(r));
    }
    expect(got).toContain("seven-suns");
    expect(got).not.toContain("long-patrol");
    expect(streakInfo(d.days, "2026-10-16").current).toBe(7);
  });

  it("full squadron: 5 agents complete tasks on one mission (a new goal starts a new squad)", () => {
    const t = at(2026, 10, 19, 12);
    const team = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ text: `job ${from + i}`, at: t, agents: [`s${from + i}`] }));
    const a = recordMission(emptyLog(), { project: PROJECT, goal: "g1", completions: team(4) }, t);
    expect(ids(a)).not.toContain("full-squadron");
    const other = recordMission(a.data, { project: PROJECT, goal: "g2", completions: team(1, 4) }, t);
    expect(ids(other)).not.toContain("full-squadron");
    const same = recordMission(a.data, { project: PROJECT, goal: "g1", completions: team(1, 4) }, t);
    expect(ids(same)).toContain("full-squadron");
  });

  it("clean landing, outer rim, ten campaigns", () => {
    const t = at(2026, 10, 19, 12);
    const clean = recordMission(emptyLog(), { project: PROJECT, goal: "g", completions: [{ text: "a", at: t, agents: [] }], finished: { at: t, clean: true } }, t);
    expect(ids(clean)).toEqual(expect.arrayContaining(["clean-landing", "first-jump"]));
    let d = emptyLog();
    let got: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = recordMission(d, { project: `D:\\p${i}`, goal: "g", completions: [{ text: "a", at: t, agents: [] }], finished: { at: t, clean: false } }, t);
      d = r.data;
      got = got.concat(ids(r));
    }
    expect(got).toEqual(expect.arrayContaining(["outer-rim", "ten-campaigns"]));
    expect(got).not.toContain("clean-landing");
    expect(d.missions).toBe(10);
  });

  it("medals are awarded once", () => {
    const t = at(2026, 10, 19, 2);
    const a = recordMission(emptyLog(), { project: PROJECT, goal: "g", completions: [{ text: "a", at: t, agents: [] }] }, t);
    const b = recordMission(a.data, { project: PROJECT, goal: "g", completions: [{ text: "b", at: t, agents: [] }] }, t);
    expect(ids(a)).toContain("night-shift");
    expect(ids(b)).not.toContain("night-shift");
  });
});

describe("recordCommits", () => {
  const t = at(2026, 10, 19, 12);

  it("uses the first value as a baseline and counts increases", () => {
    let r = recordCommits(emptyLog(), PROJECT, "a1b2c3d4", 3, t);
    expect(r.data.commits).toBe(0);
    expect(r.changed).toBe(true);
    r = recordCommits(r.data, PROJECT, "a1b2c3d4", 5, t);
    expect(r.commits).toBe(2);
    r = recordCommits(r.data, PROJECT, "a1b2c3d4", 5, t);
    expect(r.changed).toBe(false);
    r = recordCommits(r.data, PROJECT, "a1b2c3d4", 0, t); // merged
    expect(r.data.commits).toBe(2);
    r = recordCommits(r.data, PROJECT, "a1b2c3d4", 1, t);
    expect(r.data.commits).toBe(3);
  });

  it("supply line after 50 commits", () => {
    let r = recordCommits(emptyLog(), PROJECT, "w", 0, t);
    r = recordCommits(r.data, PROJECT, "w", 50, t);
    expect(r.medals.map((m) => m.id)).toEqual(["supply-line"]);
  });
});

describe("storage", () => {
  it("round-trips", () => {
    const t = at(2026, 10, 19, 12);
    const r = recordMission(emptyLog(), { project: PROJECT, goal: "g", completions: [{ text: "a", at: t, agents: ["s1"] }], finished: { at: t, clean: true } }, t);
    const back = parseLog(serializeLog(r.data));
    expect(back.status).toBe("ok");
    expect(back.data).toEqual(r.data);
  });

  it("starts fresh on missing or unreadable data", () => {
    expect(parseLog(null)).toMatchObject({ status: "fresh" });
    expect(parseLog("{not json")).toMatchObject({ status: "repaired", data: emptyLog() });
    expect(parseLog("[1,2]")).toMatchObject({ status: "repaired" });
    expect(parseLog('"text"')).toMatchObject({ status: "repaired" });
  });

  it("drops invalid fields and keeps the valid ones", () => {
    const raw = JSON.stringify({
      v: 1,
      enabled: true,
      days: { "2026-10-19": 3, "2026-02-30": 2, nope: 1, "2026-10-18": -4 },
      tasks: "lots",
      missions: 2,
      commits: 1.7,
      agents: ["deadbeef", "DEADBEEF", 7, "deadbeef"],
      medals: { "first-jump": 1760000000000, "made-up": 1, hyperspace: "yes" },
      seen: ["2026-10-19|deadbeef|cafebabe", "../etc"],
      heads: { "deadbeef|w1": 4, "bad key": 2 },
      squads: { deadbeef: { g: "cafebabe", ids: ["deadbeef"] }, x: {} },
      rank: 99,
    });
    const { data, status } = parseLog(raw);
    expect(status).toBe("repaired");
    expect(data.days).toEqual({ "2026-10-19": 3 });
    expect(data.tasks).toBe(3); // at least the days' sum
    expect(data.missions).toBe(2);
    expect(data.commits).toBe(1);
    expect(data.agents).toEqual(["deadbeef"]);
    expect(data.medals).toEqual({ "first-jump": 1760000000000 });
    expect(data.seen).toEqual(["2026-10-19|deadbeef|cafebabe"]);
    expect(data.heads).toEqual({ "deadbeef|w1": 4 });
    expect(Object.keys(data.squads)).toEqual(["deadbeef"]);
    expect(data.rank).toBe(RANKS.length - 1);
  });

  it("migrates an unversioned (pre-v1) object", () => {
    const { data, status } = parseLog(JSON.stringify({ streakDays: ["2026-10-17", "2026-10-18", "bad"], missions: 1 }));
    expect(status).toBe("migrated");
    expect(data.v).toBe(FLIGHTLOG_VERSION);
    expect(data.days).toEqual({ "2026-10-17": 1, "2026-10-18": 1 });
    expect(data.tasks).toBe(2);
    expect(data.missions).toBe(1);
    expect(data.rank).toBe(0);
  });

  it("leaves a newer version alone", () => {
    const { status, data } = parseLog(JSON.stringify({ v: 2, enabled: false, everything: "different" }));
    expect(status).toBe("newer");
    expect(data.enabled).toBe(false);
  });

  it("reset keeps the on/off choice", () => {
    const d = { ...emptyLog(false), tasks: 9 };
    expect(resetLog(d)).toEqual(emptyLog(false));
  });
});

describe("views", () => {
  it("heat strip: 12 Monday-first weeks ending with this week", () => {
    const w = heatWeeks({ "2026-10-19": 3, "2026-10-12": 12 }, "2026-10-21");
    expect(w).toHaveLength(12);
    expect(w.every((c) => c.length === 7)).toBe(true);
    const last = w[11];
    expect(last[0].key).toBe("2026-10-19");
    expect(last[0]).toMatchObject({ count: 3, level: 2, future: false });
    expect(last[3].future).toBe(true);
    expect(w[10][0]).toMatchObject({ key: "2026-10-12", level: 4 });
    expect(w[0][0].key).toBe("2026-08-03");
    expect([0, 1, 2, 3, 6, 9, 10].map(heatLevel)).toEqual([0, 1, 1, 2, 3, 3, 4]);
  });

  it("announces in one line", () => {
    expect(announcement(rankFor(100), [])).toBe("Promoted to Captain.");
    expect(announcement(null, [MEDALS[3]])).toBe("Medal earned: Night shift.");
    expect(announcement(rankFor(5), [MEDALS[0], MEDALS[5]])).toBe("Promoted to Pilot. Medals earned: First jump, Hyperspace.");
    expect(announcement(null, [])).toBeNull();
  });
});
