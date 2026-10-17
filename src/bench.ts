// Benchmark mode: ALTERA_BENCH="sessions=6;mode=sustained;seconds=60;rate=2000;layout=grid"
// Creates an in-memory "Bench" workspace with N PowerShell sessions running scripts/bench/flood.ps1.
// Persistence is disabled in bench mode so the user's saved workspaces are never modified.
//   mode=idle      interactive shells only (idle measurement)
//   mode=lines     print `count` lines once, then stay at a prompt
//   mode=sustained continuous output at `rate` lines/s for `seconds`
//   mode=unicode / garbage  rendering-robustness checks

import { newSession } from "./actions/sessions";
import type { AppInfo } from "./lib/ipc";
import type { LayoutPreset } from "./lib/types";
import { useApp } from "./store/appStore";

export function parseBench(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(/[;,]/)) {
    const [k, v] = part.split("=").map((x) => x.trim());
    if (k) out[k.toLowerCase()] = v ?? "";
  }
  return out;
}

export function setupBench(info: AppInfo): boolean {
  if (!info.bench) return false;
  const cfg = parseBench(info.bench);
  const n = Math.max(1, Math.min(32, Number(cfg.sessions ?? 6) || 6));
  const mode = cfg.mode ?? "idle";
  const scripts = info.benchScriptsDir;
  const cwd = scripts ?? "C:\\";
  const app = useApp.getState();
  const wsId = app.createWorkspace(`Bench ${n}× ${mode}`, cwd);
  const ws = useApp.getState().persisted.workspaces.find((w) => w.id === wsId)!;
  const groupId = ws.groups[0].id;
  app.updateLayout(groupId, { preset: (cfg.layout as LayoutPreset) ?? "grid" });

  for (let i = 0; i < n; i++) {
    const args = ["-NoProfile"];
    if (mode !== "idle" && scripts) {
      args.push("-NoExit", "-File", `${scripts}\\flood.ps1`, "-Mode", mode);
      if (cfg.count) args.push("-Count", cfg.count);
      if (cfg.rate) args.push("-Rate", cfg.rate);
      if (cfg.seconds) args.push("-Seconds", cfg.seconds);
    }
    newSession({ groupId, agent: "powershell", cwd, name: `bench ${i + 1}`, args });
  }
  return true;
}
