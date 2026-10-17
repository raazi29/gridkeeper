// Diagnostics › GPU: live figures from the Windows GPU performance counters (the same source as Task
// Manager), the adapter that draws the UI, and per-engine load. Nothing here is estimated.

import type { Diagnostics, EnginePercent, GpuAdapter } from "../lib/types";
import type { RendererStatus } from "../terminal/registry";
import { formatCpu, formatMb } from "./util/text";
import "../styles/tools.css";

const ENGINES: { key: keyof EnginePercent; label: string }[] = [
  { key: "3d", label: "3D" },
  { key: "copy", label: "Copy" },
  { key: "video", label: "Video" },
  { key: "compute", label: "Compute" },
  { key: "other", label: "Other" },
];

/** Status-bar / tooltip text for the WebView2 GPU load, or null when unknown. */
export function gpuLoadText(diag: Diagnostics | null | undefined): string | null {
  const g = diag?.gpu;
  if (!g?.available) return null;
  if (g.warmingUp) return "GPU …";
  return `GPU ${formatCpu(g.webview3dPercent)}`;
}

export function gpuTooltip(diag: Diagnostics | null | undefined): string {
  const g = diag?.gpu;
  if (!g) return "";
  if (!g.available) return `GPU counters unavailable${g.error ? `: ${g.error}` : ""}`;
  if (g.warmingUp) return "GPU counters: first sample, utilization appears on the next refresh";
  const ui = g.adapters.find((a) => a.carriesUi);
  return [
    `WebView2 (UI + terminals): 3D ${formatCpu(g.webview3dPercent)}, busiest engine ${formatCpu(g.webviewTotalPercent)}`,
    `GPU memory: ${formatMb(g.webviewDedicatedBytes)} dedicated, ${formatMb(g.webviewSharedBytes)} shared`,
    ui ? `Adapter ${ui.luid}: 3D ${formatCpu(ui.enginePercent["3d"])} (all apps)` : "",
    "Source: Windows GPU performance counters (as Task Manager)",
  ]
    .filter(Boolean)
    .join("\n");
}

function Figure({ value, label, title }: { value: string; label: string; title?: string }) {
  return (
    <div className="gpu-figure" title={title}>
      <span className="gpu-figure-v">{value}</span>
      <span className="gpu-figure-k">{label}</span>
    </div>
  );
}

function AdapterBars({ adapter, renderer }: { adapter: GpuAdapter; renderer: string | null }) {
  return (
    <div className="gpu-adapter">
      <div className="gpu-adapter-head">
        {adapter.carriesUi ? <span className="chip tone-accent">Draws the UI</span> : <span className="chip">Other adapter</span>}
        <span className="mono" title="Adapter LUID (Windows)">
          {adapter.luid}
        </span>
        {adapter.carriesUi && renderer && (
          <span className="mono muted" title="WebGL renderer string, verbatim">
            {renderer}
          </span>
        )}
        <span className="muted">· {formatMb(adapter.dedicatedUsedBytes)} dedicated in use (all apps)</span>
      </div>
      <div className="gpu-bars">
        {ENGINES.map(({ key, label }) => {
          const v = adapter.enginePercent[key];
          return [
            <span key={`${key}-k`} className="gpu-bar-k">
              {label}
            </span>,
            <span key={`${key}-b`} className="gpu-bar" role="meter" aria-label={`${label} engine`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)}>
              <span style={{ width: `${Math.min(100, Math.max(0, v))}%` }} />
            </span>,
            <span key={`${key}-v`} className="gpu-bar-v">
              {formatCpu(v)}
            </span>,
          ];
        })}
      </div>
    </div>
  );
}

export function GpuSection({ diag, renderer }: { diag: Diagnostics | null; renderer: RendererStatus }) {
  const g = diag?.gpu;
  return (
    <div className="diag-card gpu-section">
      <div className="gpu-head">
        <span className="section-label">GPU</span>
        <span className="mono muted" title="WebGL renderer string, verbatim">
          {renderer.gpuRenderer ?? (renderer.webglSupported ? "renderer string unavailable" : "WebGL unavailable")}
        </span>
      </div>
      {!diag ? (
        <div className="muted">—</div>
      ) : !g ? (
        <div className="muted">GPU counters are not reported by this backend.</div>
      ) : !g.available ? (
        <div className="callout">GPU counters unavailable{g.error ? `: ${g.error}` : ""}. No GPU figure is shown rather than a guess.</div>
      ) : (
        <>
          <div className="gpu-figures">
            <Figure
              value={g.warmingUp ? "…" : formatCpu(g.webview3dPercent)}
              label="WebView2 3D"
              title="Busiest 3D engine used by the app's WebView2 processes (terminal text + UI)"
            />
            <Figure
              value={g.warmingUp ? "…" : formatCpu(g.webviewTotalPercent)}
              label="WebView2 GPU"
              title="Busiest engine of any kind for WebView2 — Task Manager's per-process GPU column"
            />
            <Figure value={formatMb(g.webviewDedicatedBytes)} label="Dedicated mem" title="GPU memory (VRAM) held by WebView2" />
            <Figure value={formatMb(g.webviewSharedBytes)} label="Shared mem" title="System memory mapped for the GPU by WebView2" />
          </div>
          {g.warmingUp && <div className="muted">Measuring — utilization appears with the next refresh.</div>}
          {g.adapters.map((a) => (
            <AdapterBars key={a.luid} adapter={a} renderer={renderer.gpuRenderer} />
          ))}
          <p className="explain" style={{ marginTop: 8 }}>
            The GPU draws terminal text and the UI; agent CPU is unaffected. Host {formatCpu(g.hostPercent)} · sessions {formatCpu(g.sessionsPercent)} GPU. Source: Windows GPU
            performance counters ({g.engineInstances} engine instances, read in {g.sampleMs.toFixed(1)} ms).
          </p>
        </>
      )}
    </div>
  );
}
