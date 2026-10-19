// Mission replay dialog: recordings of the active project, a live preview canvas (play / scrub), options
// (length, aspect, theme, watermark) and export to MP4 / WebM (real-time MediaRecorder) or GIF (worker
// encoder). Opened from Mission Control's header ("replay…") and the palette ("Mission replay…").
// The preview animates only while playing (requestAnimationFrame, stops on pause / close); with reduced
// motion it never autoplays.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { notify } from "../../actions/notify";
import { formatDate, t as translate, useT } from "../../i18n";
import { errorMessage, ipc } from "../../lib/ipc";
import { dayKey, statusLine } from "../../lib/flightlog";
import type { ReplayExportKind, ReplayInfo } from "../../lib/types";
import { ExportCancelled, exportReplay, pickVideoType, type ExportProgress } from "../../replay/export";
import { goalSlug, metaFromName, parseReplay, summarize, type RecordingSummary, type ReplayEvent } from "../../replay/events";
import { activePalette, paletteFromTheme } from "../../replay/palette";
import { flushRecording, startRecording, stopRecording } from "../../replay/recorder";
import { ASPECTS, loadReplayFonts, makeScene, paintFrame, type Aspect } from "../../replay/render";
import { formatClock, formatClockRange, formatWall, LENGTHS, type ReplayLength } from "../../replay/timeline";
import { useApp } from "../../store/appStore";
import { useFlightLog } from "../../store/flightlog";
import { dirKey } from "../../store/missionDoc";
import { closeReplay, setAutoRecord, useReplay } from "../../store/replay";
import { actionToast, confirmDialog } from "../../store/uiStore";
import { getTheme, THEMES } from "../../theme/themes";
import { Button } from "../ui/Button";
import { Segmented, Select, Toggle } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { revealPath } from "../util/pick";
import { formatBytes } from "../util/text";
import "./replay.css";

const LIST_LIMIT = 30;
const LS_PREFS = "gridkeeper.replay.prefs";

interface Prefs {
  length: ReplayLength;
  aspect: Aspect;
  watermark: boolean;
  theme: string; // "active" or a theme id
  /** Flight log line ("Day 7 streak · Captain") on the end card. */
  flightLine: boolean;
}

const DEFAULT_PREFS: Prefs = { length: 30, aspect: "landscape", watermark: true, theme: "active", flightLine: true };

function readPrefs(): Prefs {
  try {
    const raw = globalThis.localStorage?.getItem(LS_PREFS);
    if (!raw) return DEFAULT_PREFS;
    const v = JSON.parse(raw) as Partial<Prefs>;
    return {
      length: (LENGTHS as readonly number[]).includes(v.length as number) ? (v.length as ReplayLength) : DEFAULT_PREFS.length,
      aspect: v.aspect && v.aspect in ASPECTS ? v.aspect : DEFAULT_PREFS.aspect,
      watermark: typeof v.watermark === "boolean" ? v.watermark : true,
      theme: typeof v.theme === "string" ? v.theme : "active",
      flightLine: typeof v.flightLine === "boolean" ? v.flightLine : true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(p: Prefs) {
  try {
    globalThis.localStorage?.setItem(LS_PREFS, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

// ---- recordings (parsed once per file version) ----------------------------------------------------

interface Loaded {
  size: number;
  modified: number;
  events: ReplayEvent[];
  summary: RecordingSummary;
  skipped: number;
}

const cache = new Map<string, Loaded>();

async function loadRecording(dir: string, info: ReplayInfo): Promise<Loaded> {
  const k = `${dirKey(dir)}|${info.name}`;
  const hit = cache.get(k);
  if (hit && hit.size === info.sizeBytes && hit.modified === info.modifiedMs) return hit;
  const { events, skipped } = parseReplay(await ipc.replayRead(dir, info.name));
  const entry = { size: info.sizeBytes, modified: info.modifiedMs, events, summary: summarize(events), skipped };
  cache.set(k, entry);
  return entry;
}

interface Item {
  info: ReplayInfo;
  loaded: Loaded | null;
  error: string | null;
}

function fmtDate(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? translate("replay.todayAt", { time: formatClock(ms) }) : `${formatDate(d, { month: "short", day: "numeric" })} ${formatClock(ms)}`;
}

const fmtSec = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

// ---- dialog -------------------------------------------------------------------------------------------

export function ReplayDialog() {
  const t = useT();
  const dir = useReplay((s) => s.dialog.dir);
  const version = useReplay((s) => s.version);
  const auto = useReplay((s) => s.auto);
  const rec = useReplay((s) => (dir ? s.recording[dirKey(dir)] : undefined));
  const themeId = useApp((s) => s.persisted.settings.theme);
  const reduceSetting = useApp((s) => s.persisted.settings.reduceMotion);
  const flightLog = useFlightLog((s) => s.data);

  const [items, setItems] = useState<Item[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [prefs, setPrefsState] = useState<Prefs>(readPrefs);
  const [fontsReady, setFontsReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [exp, setExp] = useState<{ kind: ReplayExportKind; progress: ExportProgress; abort: AbortController } | null>(null);
  const video = useMemo(() => pickVideoType(), []);

  const setPrefs = (p: Partial<Prefs>) =>
    setPrefsState((cur) => {
      const next = { ...cur, ...p };
      savePrefs(next);
      return next;
    });

  // Focus back to Mission Control (still open underneath) after closing.
  useLayoutEffect(() => {
    const mc = document.querySelector<HTMLElement>(".mc");
    return () => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (mc?.isConnected && !document.activeElement?.closest(".modal")) mc.focus();
        }),
      );
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadReplayFonts().then(() => !cancelled && setFontsReady(true));
    return () => {
      cancelled = true;
    };
  }, []);

  // List + parse (newest first). Re-runs when a recording is flushed / stopped / deleted.
  useEffect(() => {
    if (!dir) {
      setItems([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const list = (await ipc.replayList(dir)).slice(0, LIST_LIMIT);
        if (cancelled) return;
        setListError(null);
        setItems((prev) => list.map((info) => ({ info, loaded: prev?.find((p) => p.info.name === info.name)?.loaded ?? null, error: null })));
        for (const info of list) {
          try {
            const loaded = await loadRecording(dir, info);
            if (cancelled) return;
            setItems((prev) => prev?.map((it) => (it.info.name === info.name ? { info, loaded, error: null } : it)) ?? prev);
          } catch (e) {
            if (cancelled) return;
            setItems((prev) => prev?.map((it) => (it.info.name === info.name ? { ...it, error: errorMessage(e) } : it)) ?? prev);
          }
        }
      } catch (e) {
        if (!cancelled) {
          setListError(errorMessage(e));
          setItems([]);
        }
      }
    }, items ? 600 : 0);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dir, version]);

  useEffect(() => {
    if (!items?.length) return;
    if (!selected || !items.some((i) => i.info.name === selected)) setSelected(items[0].info.name);
  }, [items, selected]);

  const current = items?.find((i) => i.info.name === selected) ?? null;
  const events = current?.loaded?.events ?? null;
  const baseScene = useMemo(() => (events && events.length ? makeScene(events, prefs.length) : null), [events, prefs.length]);
  // Flight log status on the day the recording ends (streak and rank as they were then).
  const flightLine = useMemo(
    () => (prefs.flightLine && flightLog.enabled && events && events.length ? statusLine(flightLog, dayKey(events[events.length - 1].t)) : null),
    [prefs.flightLine, flightLog, events],
  );
  const scene = useMemo(() => (baseScene && flightLine ? { ...baseScene, flightLine } : baseScene), [baseScene, flightLine]);
  const palette = useMemo(
    () => (prefs.theme === "active" ? activePalette(themeId) : paletteFromTheme(getTheme(prefs.theme))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefs.theme, themeId],
  );

  // ---- preview -------------------------------------------------------------------------------------
  const canvas = useRef<HTMLCanvasElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const timeLabel = useRef<HTMLSpanElement>(null);
  const timeRef = useRef(0);
  const raf = useRef(0);
  const dims = useMemo(() => {
    const a = ASPECTS[prefs.aspect];
    const dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
    const k = 0.5 * dpr;
    return { w: Math.round(a.w * k), h: Math.round(a.h * k) };
  }, [prefs.aspect]);

  const paint = useCallback(
    (ms: number) => {
      const c = canvas.current;
      const ctx = c?.getContext("2d", { alpha: false });
      if (!c || !ctx || !scene) return;
      timeRef.current = ms;
      paintFrame(ctx, scene, ms, { width: c.width, height: c.height, palette, watermark: prefs.watermark });
      if (slider.current) slider.current.value = String(Math.round(ms));
      if (timeLabel.current) timeLabel.current.textContent = `${fmtSec(ms)} / ${fmtSec(scene.plan.totalMs)}`;
    },
    [scene, palette, prefs.watermark],
  );

  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const paintRef = useRef(paint);
  paintRef.current = paint;

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    raf.current = 0;
    setPlaying(false);
  }, []);

  // The loop reads the scene / painter through refs: a live refresh or an option change while playing
  // takes effect on the next frame without restarting.
  const play = useCallback(() => {
    const sc = sceneRef.current;
    if (!sc) return;
    cancelAnimationFrame(raf.current);
    const from = timeRef.current >= sc.plan.totalMs - 50 ? 0 : timeRef.current;
    const t0 = performance.now() - from;
    setPlaying(true);
    const tick = () => {
      const cur = sceneRef.current;
      const ms = performance.now() - t0;
      if (!cur || ms >= cur.plan.totalMs) {
        if (cur) paintRef.current(cur.plan.totalMs);
        raf.current = 0;
        setPlaying(false);
        return;
      }
      paintRef.current(ms);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // Another recording or length: start over (autoplay unless reduced motion).
  const reduced = useMemo(() => reduceSetting || (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches), [reduceSetting]);
  const sceneKey = scene ? `${selected}|${prefs.length}` : "";
  useEffect(() => {
    const sc = sceneRef.current;
    if (!fontsReady || !sceneKey || !sc) return;
    stop();
    if (reduced) paintRef.current(sc.plan.titleMs + sc.plan.mainMs * 0.6);
    else {
      timeRef.current = 0;
      play();
    }
  }, [sceneKey, fontsReady, reduced, play, stop]);

  // Paused: repaint on option changes, a resized canvas or refreshed data.
  useEffect(() => {
    const sc = sceneRef.current;
    if (!raf.current && sc && fontsReady) paint(Math.min(timeRef.current, sc.plan.totalMs));
  }, [paint, dims, fontsReady]);

  // ---- actions ---------------------------------------------------------------------------------------
  const baseName = goalSlug(current?.loaded?.summary.goal ?? (current ? metaFromName(current.info.name).slug : null));
  const exporting = !!exp;

  const runExport = async (kind: ReplayExportKind) => {
    if (!scene || exporting) return;
    stop();
    const abort = new AbortController();
    let last = 0;
    setExp({ kind, progress: { phase: "render", fraction: 0 }, abort });
    try {
      const out = await exportReplay(scene, kind, baseName, { aspect: prefs.aspect, palette, watermark: prefs.watermark }, abort.signal, (progress) => {
        const now = performance.now();
        if (now - last < 100 && progress.fraction < 1) return;
        last = now;
        setExp((cur) => (cur ? { ...cur, progress } : cur));
      });
      if (out)
        actionToast({
          kind: "info",
          message: t("replay.saved", { size: formatBytes(out.bytes) }),
          detail: out.path,
          action: { label: t("replay.showInFolder"), run: () => void revealPath(out.path) },
        });
    } catch (e) {
      if (!(e instanceof ExportCancelled)) notify("error", t("replay.exportFailed", { error: errorMessage(e) }));
    } finally {
      setExp(null);
    }
  };

  const remove = async () => {
    if (!dir || !current) return;
    const live = rec?.file === current.info.name;
    const ok = await confirmDialog({
      title: t("replay.deleteTitle"),
      message: live
        ? t("replay.deleteMessageLive", { goal: current.loaded?.summary.goal ?? current.info.name })
        : (current.loaded?.summary.goal ?? current.info.name),
      detail: current.info.name,
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    if (live) stopRecording(dir);
    try {
      await ipc.replayDelete(dir, current.info.name);
      cache.delete(`${dirKey(dir)}|${current.info.name}`);
      setSelected(null);
      useReplay.setState((s) => ({ version: s.version + 1 }));
    } catch (e) {
      notify("error", t("replay.deleteFailed", { error: errorMessage(e) }));
    }
  };

  const onClose = () => {
    exp?.abort.abort();
    stop();
    closeReplay();
  };

  const refreshLive = async () => {
    if (!dir) return;
    await flushRecording(dir);
    useReplay.setState((s) => ({ version: s.version + 1 }));
  };

  // ---- render ----------------------------------------------------------------------------------------
  const summary = current?.loaded?.summary ?? null;
  const st = scene?.tl.stats ?? null;
  const total = scene?.plan.totalMs ?? prefs.length * 1000;
  const pct = exp ? Math.round(exp.progress.fraction * 100) : 0;
  const expLabel = !exp
    ? ""
    : exp.progress.phase === "save"
      ? t("replay.saving")
      : exp.progress.phase === "encode"
        ? exp.kind === "gif"
          ? t("replay.finishingGif")
          : t("replay.finishingVideo")
        : exp.kind === "gif"
          ? t("replay.encodingGif", { percent: pct })
          : t("replay.recordingRealtime", { elapsed: fmtSec(exp.progress.fraction * total), total: fmtSec(total) });

  const recordingBox = dir && (
    <div className="rp-recbox">
      {rec ? (
        <div className="rp-recline">
          <span className="rp-rec-dot is-on" aria-hidden="true" />
          <span>{t("replay.recordingSince", { time: formatClock(rec.startedAt), count: rec.events })}</span>
          <Button size="sm" onClick={() => stopRecording(dir)}>
            {t("common.stop")}
          </Button>
        </div>
      ) : (
        <div className="rp-recline">
          <span className="rp-rec-dot" aria-hidden="true" />
          <span className="rp-dim">{t("replay.notRecording")}</span>
          <Button size="sm" onClick={() => void startRecording(dir, { manual: true })}>
            {t("replay.record")}
          </Button>
        </div>
      )}
      <Toggle checked={auto} onChange={setAutoRecord} label={t("replay.autoRecord")} hint={t("replay.autoRecordHint")} />
    </div>
  );

  const empty = items !== null && items.length === 0;

  return (
    <Modal
      title={t("replay.title")}
      onClose={onClose}
      width={1180}
      className="rp-modal"
      footer={
        exp ? (
          <div className="rp-progress" role="status" aria-live="polite">
            <span className="rp-progress-bar" aria-hidden="true">
              <span style={{ width: `${pct}%` }} />
            </span>
            <span className="rp-progress-label">{expLabel}</span>
            <Button onClick={() => exp.abort.abort()}>{t("common.cancel")}</Button>
          </div>
        ) : (
          <>
            <Button variant="danger" disabled={!current} onClick={() => void remove()}>
              {t("replay.deleteRecording")}
            </Button>
            <span className="rp-footnote">{video ? t("replay.realtimeNote", { seconds: prefs.length }) : t("replay.noVideo")}</span>
            <Button disabled={!scene} onClick={() => void runExport("gif")}>
              {t("replay.exportGif")}
            </Button>
            <Button variant="primary" disabled={!scene || !video} title={video ? `MediaRecorder: ${video.mime}` : undefined} onClick={() => video && void runExport(video.ext)}>
              {video ? t("replay.exportFormat", { format: video.ext.toUpperCase() }) : t("replay.exportVideo")}
            </Button>
          </>
        )
      }
    >
      {!dir ? (
        <div className="rp-empty">
          <p>{t("replay.noProject")}</p>
          <p className="rp-dim">{t("replay.noProjectHint")}</p>
        </div>
      ) : empty ? (
        <div className="rp-empty">
          {listError && <div className="callout is-error">{listError}</div>}
          <h3>{t("replay.emptyTitle")}</h3>
          <p>{t.rich("replay.emptyWhat", { code: (c) => <code>{c}</code> })}</p>
          <p className="rp-dim">{t.rich("replay.emptyPrivacy", { code: (c) => <code>{c}</code> })}</p>
          {recordingBox}
        </div>
      ) : (
        <div className={`rp${exporting ? " is-busy" : ""}`}>
          <aside className="rp-side">
            <div className="rp-list" role="listbox" aria-label={t("replay.recordings")}>
              {items === null && <div className="rp-dim rp-pad">{t("common.loading")}</div>}
              {items?.map((it) => {
                const s = it.loaded?.summary;
                const meta = metaFromName(it.info.name);
                const live = rec?.file === it.info.name;
                return (
                  <button
                    key={it.info.name}
                    type="button"
                    role="option"
                    aria-selected={it.info.name === selected}
                    className={`rp-item${it.info.name === selected ? " is-selected" : ""}`}
                    disabled={exporting}
                    onClick={() => setSelected(it.info.name)}
                  >
                    <span className="rp-item-top">
                      <span>{fmtDate(s?.startedAt ?? meta.startedAt)}</span>
                      {live && <span className="rp-live">{t("replay.live")}</span>}
                    </span>
                    <span className="rp-item-goal">{s?.goal ?? meta.slug.replace(/-/g, " ")}</span>
                    <span className="rp-item-meta">
                      {it.error ? (
                        <span className="rp-err">{it.error}</span>
                      ) : s ? (
                        s.tasksTotal ? (
                          t("replay.itemMetaTasks", { duration: formatWall(s.durationMs), events: s.events, agents: s.agents, done: s.tasksDone, total: s.tasksTotal })
                        ) : (
                          t("replay.itemMeta", { duration: formatWall(s.durationMs), events: s.events, agents: s.agents })
                        )
                      ) : (
                        formatBytes(it.info.sizeBytes)
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
            {recordingBox}
          </aside>
          <section className="rp-main">
            <div className={`rp-stage is-${prefs.aspect}`}>
              <canvas ref={canvas} width={dims.w} height={dims.h} className="rp-canvas" aria-label={t("replay.previewAria")} />
              {!scene && <div className="rp-stage-msg">{current?.error ?? (current && current.loaded && current.loaded.events.length === 0 ? t("replay.noEvents") : t("common.loading"))}</div>}
            </div>
            <div className="rp-transport">
              <Button size="sm" disabled={!scene || exporting} onClick={() => (playing ? stop() : play())} aria-label={playing ? t("replay.pause") : t("replay.play")}>
                {playing ? `❚❚ ${t("replay.pause")}` : `▶ ${t("replay.play")}`}
              </Button>
              <input
                ref={slider}
                type="range"
                className="rp-scrub"
                min={0}
                max={Math.round(total)}
                step={33}
                defaultValue={0}
                disabled={!scene || exporting}
                aria-label={t("replay.scrub")}
                onInput={(e) => {
                  stop();
                  paint(Number(e.currentTarget.value));
                }}
              />
              <span ref={timeLabel} className="rp-time mono">
                0:00 / {fmtSec(total)}
              </span>
              {rec && rec.file === selected && (
                <Button size="sm" variant="ghost" onClick={() => void refreshLive()} title={t("replay.refreshTitle")}>
                  {t("common.refresh")}
                </Button>
              )}
            </div>
            <div className="rp-options">
              <div className="rp-opt">
                <span className="rp-opt-label">{t("replay.length")}</span>
                <Segmented size="sm" ariaLabel={t("replay.lengthAria")} value={String(prefs.length)} onChange={(v) => setPrefs({ length: Number(v) as ReplayLength })} options={LENGTHS.map((l) => ({ value: String(l), label: `${l} s` }))} />
              </div>
              <div className="rp-opt">
                <span className="rp-opt-label">{t("replay.aspect")}</span>
                <Segmented
                  size="sm"
                  ariaLabel={t("replay.aspectAria")}
                  value={prefs.aspect}
                  onChange={(v) => setPrefs({ aspect: v })}
                  options={(Object.keys(ASPECTS) as Aspect[]).map((a) => ({ value: a, label: ASPECTS[a].label, title: `${ASPECTS[a].w}×${ASPECTS[a].h}` }))}
                />
              </div>
              <label className="rp-opt">
                <span className="rp-opt-label">{t("replay.theme")}</span>
                <Select value={prefs.theme} onChange={(e) => setPrefs({ theme: e.target.value })} aria-label={t("replay.themeAria")}>
                  <option value="active">{t("replay.activeTheme")}</option>
                  {THEMES.map((th) => (
                    <option key={th.id} value={th.id}>
                      {th.name}
                    </option>
                  ))}
                </Select>
              </label>
              <div className="rp-opt">
                {/* The watermark itself is drawn by replay/render.ts (English for now); the hint quotes it as drawn. */}
                <Toggle checked={prefs.watermark} onChange={(v) => setPrefs({ watermark: v })} label={t("replay.watermark")} hint={t("replay.watermarkHint", { mark: "“Made with Gridkeeper”" })} />
              </div>
              {flightLog.enabled && (
                <div className="rp-opt">
                  <Toggle
                    checked={prefs.flightLine}
                    onChange={(v) => setPrefs({ flightLine: v })}
                    label={t("replay.flightLine")}
                    hint={t("replay.flightLineHint", { example: t("flightLog.statusLine", { streak: 7, rank: t("flightLog.rank.captain") }) })}
                  />
                </div>
              )}
            </div>
            {summary && st && (
              <div className="rp-facts mono">
                <span>{formatClockRange(st.startT, st.endT)}</span>
                <span>{formatWall(st.wallMs)} → {prefs.length} s</span>
                <span>{t("replay.events", { count: summary.events })}</span>
                <span>{t("replay.agents", { count: st.agents })}</span>
                <span>{t("replay.tasks", { done: st.tasksDone, total: st.tasksTotal })}</span>
                <span>{t("replay.commits", { count: st.commits, ins: st.ins, del: st.del })}</span>
                {current?.loaded?.skipped ? <span className="rp-dim">{t("replay.skipped", { count: current.loaded.skipped })}</span> : null}
              </div>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
