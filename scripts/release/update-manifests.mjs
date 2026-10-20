#!/usr/bin/env node
// Rewrites the package-manager manifests for a published Gridkeeper release:
//   bucket/gridkeeper.json                                  Scoop
//   Casks/gridkeeper.rb                                     Homebrew cask
//   packaging/winget/manifests/r/raazi29/Gridkeeper/<ver>/  winget (new folder copied from the previous version)
//
// Usage (Node >= 20, no dependencies):
//   node scripts/release/update-manifests.mjs [version] [--dir <folder>] [--repo owner/name] [--dry-run]
//
//   version   defaults to package.json "version"; a leading "v" is ignored.
//   --dir     hash local installer files (e.g. the downloaded AppVeyor artifacts) instead of the GitHub release.
//   --repo    GitHub repository the release lives in (default raazi29/gridkeeper).
//   --dry-run print what would be written, change nothing.
//
// Without --dir the script reads https://api.github.com/repos/<repo>/releases/tags/v<version> (set GITHUB_TOKEN or
// GH_TOKEN for drafts / rate limits), takes each asset's SHA-256 from the API's "digest" field and downloads and hashes
// the asset when the field is missing. Asset names are the Tauri bundler defaults for productName "Gridkeeper":
//   Gridkeeper_<ver>_x64-setup.exe, Gridkeeper_<ver>_{universal,aarch64,x64}.dmg, Gridkeeper_<ver>_amd64.{AppImage,deb}
// The cask follows whichever dmg exists (universal, both arches, or one arch). Exit code 2 = a manifest was skipped
// because its installer is missing; the others were still written.
//
// Formats (checked 2026-10):
//   Scoop:    https://github.com/ScoopInstaller/Scoop/wiki/App-Manifests (NSIS setup unpacked with the "#/dl.7z" trick)
//   Homebrew: https://docs.brew.sh/Cask-Cookbook
//   winget:   https://learn.microsoft.com/windows/package-manager/package/manifest, schema 1.28.0
//             (https://github.com/microsoft/winget-cli/tree/master/schemas/JSON/manifests/v1.28.0)

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_REPO = "raazi29/gridkeeper";
export const PRODUCT = "Gridkeeper";
export const WINGET_ID = "raazi29.Gridkeeper";
export const SCOOP_PATH = "bucket/gridkeeper.json";
export const CASK_PATH = "Casks/gridkeeper.rb";
export const WINGET_DIR = "packaging/winget/manifests/r/raazi29/Gridkeeper";
export const WINGET_FILES = {
  version: `${WINGET_ID}.yaml`,
  installer: `${WINGET_ID}.installer.yaml`,
  locale: `${WINGET_ID}.locale.en-US.yaml`,
};

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DMG_ARCHES = ["universal", "aarch64", "x64"];

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (unit-tested in update-manifests.test.mjs)
// ---------------------------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { version: undefined, dir: undefined, repo: DEFAULT_REPO, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--dir" || a === "--repo" || a === "--version") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else if (opts.version === undefined) opts.version = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (opts.version !== undefined) opts.version = normalizeVersion(opts.version);
  if (!/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) throw new Error(`--repo must look like owner/name, got ${opts.repo}`);
  return opts;
}

export function normalizeVersion(v) {
  const out = String(v).trim().replace(/^v/, "");
  if (!VERSION_RE.test(out)) throw new Error(`not a version: ${v}`);
  return out;
}

/** Numeric x.y.z comparison; a pre-release sorts before its release. */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre = ""] = v.split("-", 2);
    return { nums: core.split(".").map(Number), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] < y.nums[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export function assetNames(version) {
  const base = `${PRODUCT}_${version}`;
  return {
    windows: `${base}_x64-setup.exe`,
    dmg: Object.fromEntries(DMG_ARCHES.map((a) => [a, `${base}_${a}.dmg`])),
    appimage: `${base}_amd64.AppImage`,
    deb: `${base}_amd64.deb`,
  };
}

/** Which of the expected installers are among `names`. Missing ones are undefined. */
export function classifyAssets(names, version) {
  const want = assetNames(version);
  const have = new Set(names);
  const pick = (n) => (have.has(n) ? n : undefined);
  return {
    windows: pick(want.windows),
    dmg: Object.fromEntries(DMG_ARCHES.map((a) => [a, pick(want.dmg[a])])),
    appimage: pick(want.appimage),
    deb: pick(want.deb),
  };
}

export function releaseUrl(repo, version, asset) {
  return `https://github.com/${repo}/releases/download/v${version}/${encodeURIComponent(asset)}`;
}

/** "sha256:ABC..." (GitHub asset digest) -> "abc...", anything else -> undefined. */
export function digestToSha256(digest) {
  const m = /^sha256:([0-9a-fA-F]{64})$/.exec(digest ?? "");
  return m ? m[1].toLowerCase() : undefined;
}

function assertSha(sha, what) {
  if (!SHA256_RE.test(sha ?? "")) throw new Error(`${what}: not a lowercase SHA-256: ${sha}`);
}

/** Keep the line endings of the file being replaced. */
export function matchEol(text, previous) {
  const lf = text.replace(/\r\n/g, "\n");
  return previous && previous.includes("\r\n") ? lf.replace(/\n/g, "\r\n") : lf;
}

/** Scoop: bump version, 64-bit url + hash. Everything else (checkver, autoupdate, notes) is kept. */
export function renderScoop(previousText, { version, repo, sha256 }) {
  assertSha(sha256, "scoop");
  const m = JSON.parse(previousText);
  const asset = assetNames(version).windows;
  m.version = version;
  m.architecture ??= {};
  m.architecture["64bit"] = { ...m.architecture["64bit"], url: `${releaseUrl(repo, version, asset)}#/dl.7z`, hash: sha256 };
  return matchEol(`${JSON.stringify(m, null, 4)}\n`, previousText);
}

/** Cask layout for the dmgs that exist: universal wins, then both arches, then a single arch. */
export function caskLayout(sha) {
  if (sha.universal) return "universal";
  if (sha.aarch64 && sha.x64) return "both";
  if (sha.aarch64) return "arm";
  if (sha.x64) return "intel";
  return undefined;
}

const CASK_ZAP = [
  "~/Library/Application Support/app.gridkeeper.desktop",
  "~/Library/Caches/app.gridkeeper.desktop",
  "~/Library/HTTPStorages/app.gridkeeper.desktop",
  "~/Library/Preferences/app.gridkeeper.desktop.plist",
  "~/Library/Saved Application State/app.gridkeeper.desktop.savedState",
  "~/Library/WebKit/app.gridkeeper.desktop",
];

/** Homebrew cask, generated whole so the arch stanzas always match the dmgs that were actually built. */
export function renderCask({ version, repo, sha }) {
  const layout = caskLayout(sha);
  if (!layout) throw new Error("cask: no dmg hash");
  for (const a of DMG_ARCHES) if (sha[a]) assertSha(sha[a], `cask ${a}`);
  const dl = `https://github.com/${repo}/releases/download/v#{version}/${PRODUCT}_#{version}`;
  const L = [];
  L.push(
    "# Homebrew cask for Gridkeeper, kept in the app repository itself. Users tap it by URL:",
    `#   brew tap ${repo} https://github.com/${repo}`,
    `#   brew install --cask ${repo}/gridkeeper`,
    "# Format: https://docs.brew.sh/Cask-Cookbook (tap by URL: https://docs.brew.sh/Taps, tap trust:",
    "# https://docs.brew.sh/Tap-Trust). Generated by scripts/release/update-manifests.mjs; change the template there.",
    'cask "gridkeeper" do',
  );
  if (layout === "both") {
    L.push('  arch arm: "aarch64", intel: "x64"', "");
    L.push(`  version "${version}"`);
    L.push(`  sha256 arm:   "${sha.aarch64}",`, `         intel: "${sha.x64}"`, "");
    L.push(`  url "${dl}_#{arch}.dmg"`);
  } else {
    const arch = { universal: "universal", arm: "aarch64", intel: "x64" }[layout];
    L.push(`  version "${version}"`, `  sha256 "${sha[arch]}"`, "");
    L.push(`  url "${dl}_${arch}.dmg"`);
  }
  L.push(
    `  name "${PRODUCT}"`,
    '  desc "GPU-accelerated multi-agent terminal workspace"',
    `  homepage "https://github.com/${repo}"`,
    "",
    "  livecheck do",
    "    url :url",
    "    strategy :github_latest",
    "  end",
    "",
  );
  if (layout === "arm") L.push("  depends_on arch: :arm64");
  // An Intel-only dmg has no arch restriction: Apple Silicon Macs run it through Rosetta 2.
  L.push(
    "  depends_on macos: :big_sur",
    "",
    `  app "${PRODUCT}.app"`,
    "",
    '  uninstall quit: "app.gridkeeper.desktop"',
    "",
    "  zap trash: [",
    ...CASK_ZAP.map((p) => `    "${p}",`),
    "  ]",
    "",
    "  caveats <<~EOS",
    "    Gridkeeper is ad-hoc signed but not notarized by Apple, so macOS blocks the first launch.",
    "",
    "    Recommended: open Gridkeeper once and dismiss the warning, then go to",
    "    System Settings > Privacy & Security, click \"Open Anyway\" next to Gridkeeper",
    "    (shown for about an hour after the blocked launch) and confirm with your password.",
    "    On macOS 15 and later, Control-click > Open no longer skips this check.",
    "",
    "    Alternative, if you trust this build: remove the download quarantine flag with",
    `      xattr -dr com.apple.quarantine "/Applications/${PRODUCT}.app"`,
    "  EOS",
    "end",
  );
  return `${L.join("\n")}\n`;
}

/** Version + dmg hashes of a cask written by renderCask (used to check the committed file round-trips). */
export function parseCask(text) {
  const version = /^\s*version "([^"]+)"/m.exec(text)?.[1];
  const sha = {};
  const both = /sha256 arm:\s*"([0-9a-f]{64})",\s*intel:\s*"([0-9a-f]{64})"/.exec(text);
  if (both) {
    sha.aarch64 = both[1];
    sha.x64 = both[2];
  } else {
    const single = /^\s*sha256 "([0-9a-f]{64})"/m.exec(text)?.[1];
    const arch = /_(universal|aarch64|x64)\.dmg"/.exec(text)?.[1];
    if (single && arch) sha[arch] = single;
  }
  return { version, sha };
}

function replaceYamlKey(text, key, value, file) {
  const re = new RegExp(`^([ \\t]*(?:- )?${key}:[ \\t]*)[^\\r\\n]*`, "gm");
  if (!re.test(text)) throw new Error(`winget ${file}: no ${key}`);
  return text.replace(re, (_m, head) => `${head}${value}`);
}

/** winget: the previous version's three files with version, installer URL, hash and release notes URL replaced. */
export function renderWinget(previous, { version, repo, sha256 }) {
  assertSha(sha256, "winget");
  const asset = assetNames(version).windows;
  const out = {};
  for (const [kind, file] of Object.entries(WINGET_FILES)) {
    let t = previous[kind];
    if (t === undefined) throw new Error(`winget: previous ${file} missing`);
    t = replaceYamlKey(t, "PackageVersion", version, file);
    if (kind === "installer") {
      t = replaceYamlKey(t, "InstallerUrl", releaseUrl(repo, version, asset), file);
      t = replaceYamlKey(t, "InstallerSha256", sha256.toUpperCase(), file);
    }
    if (kind === "locale") {
      t = replaceYamlKey(t, "ReleaseNotesUrl", `https://github.com/${repo}/releases/tag/v${version}`, file);
    }
    out[kind] = t;
  }
  return out;
}

/** The version folder to copy from: the target itself if present, else the newest older one, else the newest. */
export function pickWingetSource(versions, target) {
  const valid = versions.filter((v) => VERSION_RE.test(v)).sort(compareVersions);
  if (valid.includes(target)) return target;
  const older = valid.filter((v) => compareVersions(v, target) < 0);
  return older.at(-1) ?? valid.at(-1);
}

// ---------------------------------------------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------------------------------------------

export async function sha256File(file) {
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

async function sha256Url(url, headers) {
  const res = await fetch(url, { headers: { ...headers, Accept: "application/octet-stream" }, redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`download ${url}: HTTP ${res.status}`);
  const h = createHash("sha256");
  await pipeline(Readable.fromWeb(res.body), h);
  return h.digest("hex");
}

function githubHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return {
    "User-Agent": "gridkeeper-update-manifests",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** { assetName: sha256 } for the installers the manifests need. */
async function collectHashes({ version, dir, repo }, log) {
  const hashes = {};
  if (dir) {
    const names = await readdir(dir);
    const found = classifyAssets(names, version);
    for (const name of [found.windows, ...Object.values(found.dmg)].filter(Boolean)) {
      hashes[name] = await sha256File(path.join(dir, name));
      log(`  ${name}  ${hashes[name]}  (local file)`);
    }
    return { found, hashes };
  }
  const headers = githubHeaders();
  const api = `https://api.github.com/repos/${repo}/releases/tags/v${version}`;
  const res = await fetch(api, { headers: { ...headers, Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`${api}: HTTP ${res.status} (draft release? set GITHUB_TOKEN, or use --dir)`);
  const release = await res.json();
  const assets = new Map(release.assets.map((a) => [a.name, a]));
  const found = classifyAssets([...assets.keys()], version);
  for (const name of [found.windows, ...Object.values(found.dmg)].filter(Boolean)) {
    const a = assets.get(name);
    const fromDigest = digestToSha256(a.digest);
    hashes[name] = fromDigest ?? (await sha256Url(a.browser_download_url, headers));
    log(`  ${name}  ${hashes[name]}  (${fromDigest ? "release digest" : "downloaded"})`);
  }
  return { found, hashes };
}

export async function run(argv, { root = REPO_ROOT, log = console.log, warn = console.warn } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    log("usage: node scripts/release/update-manifests.mjs [version] [--dir <folder>] [--repo owner/name] [--dry-run]");
    return 0;
  }
  const version = opts.version ?? normalizeVersion(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version);
  log(`Gridkeeper ${version} (${opts.dir ? `files in ${opts.dir}` : `release v${version} of ${opts.repo}`})`);
  const { found, hashes } = await collectHashes({ version, dir: opts.dir, repo: opts.repo }, log);
  for (const k of ["appimage", "deb"]) if (!found[k]) warn(`  note: ${assetNames(version)[k]} not found (not used by the manifests)`);

  const writes = []; // [relativePath, content]
  let skipped = 0;
  const repo = opts.repo;

  if (found.windows) {
    const sha256 = hashes[found.windows];
    const scoopPrev = await readFile(path.join(root, SCOOP_PATH), "utf8");
    writes.push([SCOOP_PATH, renderScoop(scoopPrev, { version, repo, sha256 })]);

    const versions = (await readdir(path.join(root, WINGET_DIR), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const from = pickWingetSource(versions, version);
    if (!from) throw new Error(`no winget version folder under ${WINGET_DIR}`);
    const previous = {};
    for (const [kind, file] of Object.entries(WINGET_FILES)) {
      previous[kind] = await readFile(path.join(root, WINGET_DIR, from, file), "utf8");
    }
    const next = renderWinget(previous, { version, repo, sha256 });
    for (const [kind, file] of Object.entries(WINGET_FILES)) writes.push([`${WINGET_DIR}/${version}/${file}`, next[kind]]);
    if (from !== version) log(`  winget: new folder ${version}/ copied from ${from}/`);
  } else {
    warn(`  SKIPPED Scoop + winget: ${assetNames(version).windows} not found`);
    skipped++;
  }

  const dmgSha = Object.fromEntries(DMG_ARCHES.filter((a) => found.dmg[a]).map((a) => [a, hashes[found.dmg[a]]]));
  if (caskLayout(dmgSha)) {
    const caskPrev = await readFile(path.join(root, CASK_PATH), "utf8").catch(() => undefined);
    writes.push([CASK_PATH, matchEol(renderCask({ version, repo, sha: dmgSha }), caskPrev)]);
    log(`  cask: ${caskLayout(dmgSha)} dmg layout`);
  } else {
    warn(`  SKIPPED Homebrew cask: no Gridkeeper_${version}_{universal,aarch64,x64}.dmg found`);
    skipped++;
  }

  for (const [rel, content] of writes) {
    const abs = path.join(root, rel);
    const before = await readFile(abs, "utf8").catch(() => undefined);
    const state = before === undefined ? "new" : before === content ? "unchanged" : "updated";
    if (opts.dryRun) {
      log(`\n--- ${rel} (${state}, dry run) ---\n${content}`);
    } else if (state !== "unchanged") {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
      log(`  wrote ${rel} (${state})`);
    } else {
      log(`  ${rel} unchanged`);
    }
  }
  return skipped ? 2 : 0;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`error: ${err.message}`);
      process.exit(1);
    },
  );
}
