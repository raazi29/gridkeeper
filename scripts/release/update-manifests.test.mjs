import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CASK_PATH,
  SCOOP_PATH,
  WINGET_DIR,
  WINGET_FILES,
  assetNames,
  caskLayout,
  classifyAssets,
  compareVersions,
  digestToSha256,
  matchEol,
  parseArgs,
  parseCask,
  pickWingetSource,
  renderCask,
  renderScoop,
  renderWinget,
  run,
} from "./update-manifests.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = "raazi29/gridkeeper";
const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const read = (rel) => readFile(path.join(ROOT, rel), "utf8");

describe("parseArgs", () => {
  it("defaults", () => {
    expect(parseArgs([])).toEqual({ version: undefined, dir: undefined, repo: REPO, dryRun: false, help: false });
  });
  it("positional version (leading v dropped) and flags", () => {
    expect(parseArgs(["v0.3.0", "--dir", "out", "--dry-run", "--repo", "me/fork"])).toEqual({
      version: "0.3.0",
      dir: "out",
      repo: "me/fork",
      dryRun: true,
      help: false,
    });
    expect(parseArgs(["--version", "1.2.3-rc.1"]).version).toBe("1.2.3-rc.1");
  });
  it("rejects bad input", () => {
    expect(() => parseArgs(["0.2"])).toThrow(/not a version/);
    expect(() => parseArgs(["--dir"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--dir", "--dry-run"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option/);
    expect(() => parseArgs(["1.0.0", "2.0.0"])).toThrow(/unexpected argument/);
    expect(() => parseArgs(["--repo", "nope"])).toThrow(/owner\/name/);
  });
});

describe("versions and assets", () => {
  it("compareVersions is numeric and puts pre-releases first", () => {
    const sorted = ["0.10.0", "0.2.0", "0.2.0-rc.1", "0.9.1", "1.0.0"].sort(compareVersions);
    expect(sorted).toEqual(["0.2.0-rc.1", "0.2.0", "0.9.1", "0.10.0", "1.0.0"]);
  });
  it("uses the Tauri bundler file names", () => {
    expect(assetNames("0.2.0")).toEqual({
      windows: "Gridkeeper_0.2.0_x64-setup.exe",
      dmg: {
        universal: "Gridkeeper_0.2.0_universal.dmg",
        aarch64: "Gridkeeper_0.2.0_aarch64.dmg",
        x64: "Gridkeeper_0.2.0_x64.dmg",
      },
      appimage: "Gridkeeper_0.2.0_amd64.AppImage",
      deb: "Gridkeeper_0.2.0_amd64.deb",
    });
  });
  it("classifyAssets ignores other versions and unrelated files", () => {
    const found = classifyAssets(
      ["Gridkeeper_0.2.0_x64-setup.exe", "Gridkeeper_0.2.0_aarch64.dmg", "Gridkeeper_0.1.1_x64-setup.exe", "notes.md"],
      "0.2.0",
    );
    expect(found.windows).toBe("Gridkeeper_0.2.0_x64-setup.exe");
    expect(found.dmg).toEqual({ universal: undefined, aarch64: "Gridkeeper_0.2.0_aarch64.dmg", x64: undefined });
    expect(found.appimage).toBeUndefined();
  });
  it("digestToSha256 reads GitHub asset digests", () => {
    expect(digestToSha256(`sha256:${"AB".repeat(32)}`)).toBe("ab".repeat(32));
    expect(digestToSha256("sha512:abc")).toBeUndefined();
    expect(digestToSha256(null)).toBeUndefined();
  });
  it("matchEol follows the file being replaced", () => {
    expect(matchEol("a\nb\n", "x\r\ny\r\n")).toBe("a\r\nb\r\n");
    expect(matchEol("a\r\nb\n", "x\n")).toBe("a\nb\n");
    expect(matchEol("a\nb\n", undefined)).toBe("a\nb\n");
  });
});

describe("Scoop", () => {
  it("bumps version, url and hash and keeps the rest of the committed manifest", async () => {
    const prev = await read(SCOOP_PATH);
    const out = JSON.parse(renderScoop(prev, { version: "0.3.0", repo: REPO, sha256: A }));
    const before = JSON.parse(prev);
    expect(out.version).toBe("0.3.0");
    expect(out.architecture["64bit"]).toEqual({
      url: "https://github.com/raazi29/gridkeeper/releases/download/v0.3.0/Gridkeeper_0.3.0_x64-setup.exe#/dl.7z",
      hash: A,
    });
    for (const k of ["##", "description", "homepage", "license", "notes", "post_install", "shortcuts", "checkver", "autoupdate"]) {
      expect(out[k]).toEqual(before[k]);
    }
    expect(Object.keys(out)).toEqual(Object.keys(before));
  });
  it("is a fixed point for its own version and hash (committed file is formatted the same way)", async () => {
    const prev = await read(SCOOP_PATH);
    const m = JSON.parse(prev);
    expect(renderScoop(prev, { version: m.version, repo: REPO, sha256: m.architecture["64bit"].hash })).toBe(prev);
  });
  it("rejects a bad hash", () => {
    expect(() => renderScoop("{}", { version: "1.0.0", repo: REPO, sha256: "XYZ" })).toThrow(/SHA-256/);
  });
});

describe("Homebrew cask", () => {
  it("picks the layout from the dmgs that exist", () => {
    expect(caskLayout({ universal: A, aarch64: B })).toBe("universal");
    expect(caskLayout({ aarch64: A, x64: B })).toBe("both");
    expect(caskLayout({ aarch64: A })).toBe("arm");
    expect(caskLayout({ x64: A })).toBe("intel");
    expect(caskLayout({})).toBeUndefined();
    expect(() => renderCask({ version: "1.0.0", repo: REPO, sha: {} })).toThrow(/no dmg/);
  });
  it("universal dmg: one url, no arch restriction", () => {
    const rb = renderCask({ version: "0.3.0", repo: REPO, sha: { universal: A, aarch64: B } });
    expect(rb).toContain(`sha256 "${A}"`);
    expect(rb).toContain('url "https://github.com/raazi29/gridkeeper/releases/download/v#{version}/Gridkeeper_#{version}_universal.dmg"');
    expect(rb).not.toContain("depends_on arch");
    expect(rb).not.toContain("arch arm:");
  });
  it("both arches: arch + sha256 arm/intel", () => {
    const rb = renderCask({ version: "0.3.0", repo: REPO, sha: { aarch64: A, x64: B } });
    expect(rb).toContain('arch arm: "aarch64", intel: "x64"');
    expect(rb).toContain(`sha256 arm:   "${A}",\n         intel: "${B}"`);
    expect(rb).toContain("_#{version}_#{arch}.dmg");
    expect(rb).not.toContain("depends_on arch");
  });
  it("single arch: arm-only is restricted, Intel-only is not (Rosetta 2)", () => {
    expect(renderCask({ version: "0.3.0", repo: REPO, sha: { aarch64: A } })).toContain("depends_on arch: :arm64\n");
    const intel = renderCask({ version: "0.3.0", repo: REPO, sha: { x64: C } });
    expect(intel).not.toContain("depends_on arch");
    expect(intel).toContain("_x64.dmg");
  });
  it("has the fixed stanzas", () => {
    const rb = renderCask({ version: "0.3.0", repo: REPO, sha: { aarch64: A } });
    expect(rb).toMatch(/^cask "gridkeeper" do$/m);
    expect(rb).toContain('app "Gridkeeper.app"');
    expect(rb).toContain("depends_on macos: :big_sur");
    expect(rb).toContain("strategy :github_latest");
    expect(rb).toContain('"~/Library/Application Support/app.gridkeeper.desktop",');
    expect(rb).toContain("Open Anyway");
    expect(rb).toContain('xattr -dr com.apple.quarantine "/Applications/Gridkeeper.app"');
    expect(rb.trimEnd().endsWith("end")).toBe(true);
  });
  it.each([{ universal: A }, { aarch64: A, x64: B }, { aarch64: A }, { x64: B }])("parseCask round-trips %o", (sha) => {
    const rb = renderCask({ version: "1.2.3", repo: REPO, sha });
    expect(parseCask(rb)).toEqual({ version: "1.2.3", sha });
  });
  it("the committed cask is exactly what the template produces", async () => {
    const committed = (await read(CASK_PATH)).replace(/\r\n/g, "\n");
    const { version, sha } = parseCask(committed);
    expect(renderCask({ version, repo: REPO, sha })).toBe(committed);
  });
});

describe("winget", () => {
  async function committedWinget() {
    const dirs = await readdir(path.join(ROOT, WINGET_DIR));
    const from = pickWingetSource(dirs, "99.0.0");
    const prev = {};
    for (const [kind, file] of Object.entries(WINGET_FILES)) prev[kind] = await read(`${WINGET_DIR}/${from}/${file}`);
    return { from, prev };
  }

  it("pickWingetSource prefers the target, then the newest older version", () => {
    expect(pickWingetSource(["0.2.0", "0.3.0"], "0.3.0")).toBe("0.3.0");
    expect(pickWingetSource(["0.2.0", "0.10.0", "0.9.0"], "0.11.0")).toBe("0.10.0");
    expect(pickWingetSource(["0.2.0", "0.4.0"], "0.3.0")).toBe("0.2.0");
    expect(pickWingetSource(["0.4.0", "junk"], "0.3.0")).toBe("0.4.0");
    expect(pickWingetSource([], "0.3.0")).toBeUndefined();
  });
  it("rewrites version, installer url/hash and release notes in the committed manifests", async () => {
    const { from, prev } = await committedWinget();
    const out = renderWinget(prev, { version: "0.3.0", repo: REPO, sha256: A });
    for (const kind of Object.keys(WINGET_FILES)) {
      expect(out[kind]).toMatch(/^PackageVersion: 0\.3\.0$/m);
      expect(out[kind]).not.toContain(`PackageVersion: ${from}`);
      expect(out[kind]).toMatch(/^ManifestVersion: 1\.28\.0$/m);
      expect(out[kind]).toContain("# yaml-language-server: $schema=");
    }
    expect(out.installer).toContain(
      "  InstallerUrl: https://github.com/raazi29/gridkeeper/releases/download/v0.3.0/Gridkeeper_0.3.0_x64-setup.exe\n",
    );
    expect(out.installer).toContain(`  InstallerSha256: ${A.toUpperCase()}\n`);
    expect(out.installer).toContain("InstallerType: nullsoft");
    expect(out.installer).toContain("Scope: user");
    expect(out.locale).toContain("ReleaseNotesUrl: https://github.com/raazi29/gridkeeper/releases/tag/v0.3.0\n");
  });
  it("keeps CRLF files CRLF and fails on a missing key", async () => {
    const { prev } = await committedWinget();
    const crlf = Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, v.replace(/\n/g, "\r\n")]));
    const out = renderWinget(crlf, { version: "0.3.0", repo: REPO, sha256: A });
    expect(out.installer).toContain(`InstallerSha256: ${A.toUpperCase()}\r\n`);
    expect(out.installer.replace(/\r\n/g, "")).not.toContain("\n");
    expect(() =>
      renderWinget({ ...prev, locale: prev.locale.replace(/^ReleaseNotesUrl:.*$/m, "") }, { version: "0.3.0", repo: REPO, sha256: A }),
    ).toThrow(/ReleaseNotesUrl/);
  });
});

describe("run --dir (end to end on a copy of the repo files)", { timeout: 30_000 }, () => {
  const tmp = [];
  afterEach(async () => {
    for (const d of tmp.splice(0)) await rm(d, { recursive: true, force: true });
  });

  async function setup(installers) {
    const root = await mkdtemp(path.join(os.tmpdir(), "gk-manifests-root-"));
    const dir = await mkdtemp(path.join(os.tmpdir(), "gk-manifests-assets-"));
    tmp.push(root, dir);
    for (const rel of [SCOOP_PATH, CASK_PATH, WINGET_DIR, "package.json"]) {
      await cp(path.join(ROOT, rel), path.join(root, rel), { recursive: true });
    }
    const sha = {};
    for (const name of installers) {
      const body = `fake ${name}`;
      await writeFile(path.join(dir, name), body);
      sha[name] = createHash("sha256").update(body).digest("hex");
    }
    return { root, dir, sha };
  }

  it("writes all three manifests for a new version", async () => {
    const names = ["Gridkeeper_0.3.0_x64-setup.exe", "Gridkeeper_0.3.0_aarch64.dmg", "Gridkeeper_0.3.0_x64.dmg"];
    const { root, dir, sha } = await setup(names);
    const logs = [];
    const code = await run(["0.3.0", "--dir", dir], { root, log: (m) => logs.push(m), warn: (m) => logs.push(m) });
    expect(code).toBe(0);
    const scoop = JSON.parse(await readFile(path.join(root, SCOOP_PATH), "utf8"));
    expect(scoop.version).toBe("0.3.0");
    expect(scoop.architecture["64bit"].hash).toBe(sha[names[0]]);
    const cask = await readFile(path.join(root, CASK_PATH), "utf8");
    expect(parseCask(cask)).toEqual({ version: "0.3.0", sha: { aarch64: sha[names[1]], x64: sha[names[2]] } });
    const installer = await readFile(path.join(root, WINGET_DIR, "0.3.0", WINGET_FILES.installer), "utf8");
    expect(installer).toContain(`InstallerSha256: ${sha[names[0]].toUpperCase()}`);
    // the previous version folder stays
    expect((await readdir(path.join(root, WINGET_DIR))).sort(compareVersions)).toContain("0.2.0");
  });

  it("--dry-run changes nothing; a missing dmg skips only the cask (exit 2)", async () => {
    const { root, dir } = await setup(["Gridkeeper_0.3.0_x64-setup.exe"]);
    const before = await readFile(path.join(root, SCOOP_PATH), "utf8");
    const logs = [];
    const quiet = { root, log: (m) => logs.push(m), warn: (m) => logs.push(m) };
    expect(await run(["0.3.0", "--dir", dir, "--dry-run"], quiet)).toBe(2);
    expect(await readFile(path.join(root, SCOOP_PATH), "utf8")).toBe(before);
    expect(await readdir(path.join(root, WINGET_DIR))).not.toContain("0.3.0");
    expect(logs.join("\n")).toMatch(/SKIPPED Homebrew cask/);

    expect(await run(["0.3.0", "--dir", dir], quiet)).toBe(2);
    expect(JSON.parse(await readFile(path.join(root, SCOOP_PATH), "utf8")).version).toBe("0.3.0");
    expect(await readFile(path.join(root, CASK_PATH), "utf8")).toBe(await read(CASK_PATH));
  });

  it("defaults to the package.json version", async () => {
    const { root, dir } = await setup([]);
    await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.4.0" }));
    const logs = [];
    expect(await run(["--dir", dir, "--dry-run"], { root, log: (m) => logs.push(m), warn: (m) => logs.push(m) })).toBe(2);
    expect(logs[0]).toContain("Gridkeeper 0.4.0");
  });
});
