// Diagnostics › GPU: live figures from the Windows GPU performance counters (the same source as Task
// Manager), the adapter that draws the UI, and per-engine load. Nothing here is estimated.

import { t, useT, type MessageKey } from "../i18n";
import type { Diagnostics, EnginePercent, GpuAdapter } from "../lib/types";
import type { RendererStatus } from "../terminal/registry";
import { formatCpu, formatMb } from "./util/text";
import { OS, type Os } from "../lib/platform";
import "../styles/tools.css";

const ENGINES: { key: keyof EnginePercent; label: MessageKey }[] = [
  { key: "3d", label: "gpu.engine3d" },
  { key: "copy", label: "gpu.engineCopy" },
  { key: "video", label: "gpu.engineVideo" },
  { key: "compute", label: "gpu.engineCompute" },
  { key: "other", label: "gpu.engineOther" },
];

/** Status-bar / tooltip text for the WebView2 GPU load, or null when unknown. */
export function gpuLoadText(diag: Diagnostics | null | undefined): string | null {
  const g = diag?.gpu;
  if (!g?.available) return null;
  if (g.warmingUp) return "GPU …";
  return `GPU ${formatCpu(g.webview3dPercent)}`;
}

export function gpuTooltip(diag: Diagnostics | null | undefined, os: Os = OS): string {
  const g = diag?.gpu;
  if (!g) return "";
  // macOS / Linux have no GPU telemetry by design: say nothing rather than report a failure.
  if (!g.available && os !== "windows") return "";
  if (!g.available) return g.error ? t("gpu.tooltipUnavailableError", { error: g.error }) : t("gpu.tooltipUnavailable");
  if (g.warmingUp) return t("gpu.tooltipWarming");
  const ui = g.adapters.find((a) => a.carriesUi);
  return [
    t("gpu.tooltipWebview", { d3: formatCpu(g.webview3dPercent), busiest: formatCpu(g.webviewTotalPercent) }),
    t("gpu.tooltipMemory", { dedicated: formatMb(g.webviewDedicatedBytes), shared: formatMb(g.webviewSharedBytes) }),
    ui ? t("gpu.tooltipAdapter", { luid: ui.luid, d3: formatCpu(ui.enginePercent["3d"]) }) : "",
    t("gpu.tooltipSource"),
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
  const t = useT();
  return (
    <div className="gpu-adapter">
      <div className="gpu-adapter-head">
        {adapter.carriesUi ? <span className="chip tone-accent">{t("gpu.drawsUi")}</span> : <span className="chip">{t("gpu.otherAdapter")}</span>}
        <span className="mono" title={t("gpu.luidTitle")}>
          {adapter.luid}
        </span>
        {adapter.carriesUi && renderer && (
          <span className="mono muted" title={t("gpu.rendererStringTitle")}>
            {renderer}
          </span>
        )}
        <span className="muted">· {t("gpu.dedicatedInUse", { mem: formatMb(adapter.dedicatedUsedBytes) })}</span>
      </div>
      <div className="gpu-bars">
        {ENGINES.map(({ key, label: labelKey }) => {
          const v = adapter.enginePercent[key];
          const label = t(labelKey);
          return [
            <span key={`${key}-k`} className="gpu-bar-k" title={label}>
              {label}
            </span>,
            <span key={`${key}-b`} className="gpu-bar" role="meter" aria-label={t("gpu.engineAria", { engine: label })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(v)}>
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
  const t = useT();
  const g = diag?.gpu;
  return (
    <div className="diag-card gpu-section">
      <div className="gpu-head">
        <span className="section-label">GPU</span>
        <span className="mono muted" title={t("gpu.rendererStringTitle")}>
          {renderer.gpuRenderer ?? (renderer.webglSupported ? t("gpu.rendererStringUnavailable") : t("gpu.webglUnavailable"))}
        </span>
      </div>
      {!diag ? (
        <div className="muted">—</div>
      ) : !g ? (
        <div className="muted">{t("gpu.notReported")}</div>
      ) : !g.available && OS !== "windows" ? (
        <div className="muted">{t("gpu.windowsOnly")}</div>
      ) : !g.available ? (
        <div className="callout">{g.error ? t("gpu.unavailableNoGuessError", { error: g.error }) : t("gpu.unavailableNoGuess")}</div>
      ) : (
        <>
          <div className="gpu-figures">
            <Figure value={g.warmingUp ? "…" : formatCpu(g.webview3dPercent)} label="WebView2 3D" title={t("gpu.figure3dTitle")} />
            <Figure value={g.warmingUp ? "…" : formatCpu(g.webviewTotalPercent)} label="WebView2 GPU" title={t("gpu.figureGpuTitle")} />
            <Figure value={formatMb(g.webviewDedicatedBytes)} label={t("gpu.figureDedicated")} title={t("gpu.figureDedicatedTitle")} />
            <Figure value={formatMb(g.webviewSharedBytes)} label={t("gpu.figureShared")} title={t("gpu.figureSharedTitle")} />
          </div>
          {g.warmingUp && <div className="muted">{t("gpu.measuring")}</div>}
          {g.adapters.map((a) => (
            <AdapterBars key={a.luid} adapter={a} renderer={renderer.gpuRenderer} />
          ))}
          <p className="explain" style={{ marginTop: 8 }}>
            {t("gpu.explain", {
              host: formatCpu(g.hostPercent),
              sessions: formatCpu(g.sessionsPercent),
              instances: g.engineInstances,
              ms: g.sampleMs.toFixed(1),
            })}
          </p>
        </>
      )}
    </div>
  );
}
