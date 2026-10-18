// Mission replay dialog: recordings of the active project, a live preview canvas (play / scrub), options
// (length, aspect, theme, watermark) and export to MP4 / WebM (real-time MediaRecorder) or GIF (worker
// encoder). Opened from Mission Control's header ("replay…") and the palette ("Mission replay…").
// The preview animates only while playing (requestAnimationFrame, stops on pause / close); with reduced
// motion it never autoplays.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { notify } from "../../actions/notify";
import { errorMessage, ipc } from "../../lib/ipc";
import type { ReplayExportKind, ReplayInfo } from "../../lib/types";
import { ExportCancelled, exportReplay, pickVideoType, type ExportProgress } from "../../replay/export";
import { goalSlug, metaFromName, parseReplay, summarize, type RecordingSummary, type ReplayEvent } from "../../replay/events";
import { activePalette, paletteFromTheme } from "../../replay/palette";
import { flushRecording, startRecording, stopRecording } from "../../replay/recorder";
import { ASPECTS, loadReplayFonts, makeScene, paintFrame, type Aspect } from "../../replay/render";
import { formatClock, formatClockRange, formatWall, LENGTHS, type ReplayLength } from "../../replay/timeline";
import { useApp } from "../../store/appStore";
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
}

const DEFAULT_PREFS: Prefs = { length: 30, aspect: "landscape", watermark: true, theme: "active" };

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
  return today ? `today ${formatClock(ms)}` : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${formatClock(ms)}`;
}

const fmtSec = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

// ---- dialog -------------------------------------------------------------------------------------------

export function ReplayDialog() {
  const dir = useReplay((s) => s.dialog.dir);
  const version = useReplay((s) => s.version);
  const auto = useReplay((s) => s.auto);
  const rec = useReplay((s) => (dir ? s.recording[dirKey(dir)] : undefined));
  const themeId = useApp((s) => s.persisted.settings.theme);
  const reduceSetting = useApp((s) => s.persisted.settings.reduceMotion);

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
  const scene = useMemo(() => (events && events.length ? makeScene(events, prefs.length) : null), [events, prefs.length]);
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
          message: `Mission replay saved (${formatBytes(out.bytes)})`,
          detail: out.path,
          action: { label: "Show in folder", run: () => void revealPath(out.path) },
        });
    } catch (e) {
      if (!(e instanceof ExportCancelled)) notify("error", `Export failed: ${errorMessage(e)}`);
    } finally {
      setExp(null);
    }
  };

  const remove = async () => {
    if (!dir || !current) return;
    const live = rec?.file === current.info.name;
    const ok = await confirmDialog({
      title: "Delete this recording?",
      message: `${current.loaded?.summary.goal ?? current.info.name}${live ? " — it is still recording; recording stops first." : ""}`,
      detail: current.info.name,
      confirmLabel: "Delete",
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
      notify("error", `Could not delete the recording: ${errorMessage(e)}`);
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
      ? "Saving…"
      : exp.progress.phase === "encode"
        ? exp.kind === "gif"
          ? "Finishing the GIF…"
          : "Finishing the video…"
        : exp.kind === "gif"
          ? `Encoding GIF… ${pct}%`
          : `Recording in real time… ${fmtSec(exp.progress.fraction * total)} / ${fmtSec(total)}`;

  const recordingBox = dir && (
    <div className="rp-recbox">
      {rec ? (
        <div className="rp-recline">
          <span className="rp-rec-dot is-on" aria-hidden="true" />
          <span>
            Recording since {formatClock(rec.startedAt)} · {rec.events} events
          </span>
          <Button size="sm" onClick={() => stopRecording(dir)}>
            Stop
          </Button>
        </div>
      ) : (
        <div className="rp-recline">
          <span className="rp-rec-dot" aria-hidden="true" />
          <span className="rp-dim">Not recording this project</span>
          <Button size="sm" onClick={() => void startRecording(dir, { manual: true })}>
            Record
          </Button>
        </div>
      )}
      <Toggle checked={auto} onChange={setAutoRecord} label="Record automatically" hint="While Mission Control shows a mission for this project." />
    </div>
  );

  const empty = items !== null && items.length === 0;

  return (
    <Modal
      title="Mission replay"
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
            <Button onClick={() => exp.abort.abort()}>Cancel</Button>
          </div>
        ) : (
          <>
            <Button variant="danger" disabled={!current} onClick={() => void remove()}>
              Delete recording
            </Button>
            <span className="rp-footnote">{video ? `Video renders in real time: a ${prefs.length} s video takes ${prefs.length} s. Keep this window visible.` : "Video export is not available in this WebView; GIF works."}</span>
            <Button disabled={!scene} onClick={() => void runExport("gif")}>
              Export GIF
            </Button>
            <Button variant="primary" disabled={!scene || !video} title={video ? `MediaRecorder: ${video.mime}` : undefined} onClick={() => video && void runExport(video.ext)}>
              Export {video ? video.ext.toUpperCase() : "video"}
            </Button>
          </>
        )
      }
    >
      {!dir ? (
        <div className="rp-empty">
          <p>This workspace has no project folder, so it has no mission file to record.</p>
          <p className="rp-dim">Set a project folder for the workspace, open Mission Control and create a mission; replays record from there.</p>
        </div>
      ) : empty ? (
        <div className="rp-empty">
          {listError && <div className="callout is-error">{listError}</div>}
          <h3>No recordings yet</h3>
          <p>
            A mission replay is recorded from what Gridkeeper already sees while your agents work: the mission goal and task board (<code>.gridkeeper/mission.md</code>), each agent&rsquo;s
            state (working, needs you, done), branch stats (commits, files, lines) and short messages between agents (briefs, hand-offs, broadcasts).
          </p>
          <p className="rp-dim">
            It never records terminal output, file contents, environment variables, paths or account e-mails. Recordings are small JSON-lines files in <code>.gridkeeper/replay/</code> next to the
            mission file (ignored by git). Recording starts automatically when Mission Control shows a mission (if enabled below), or press Record.
          </p>
          {recordingBox}
        </div>
      ) : (
        <div className={`rp${exporting ? " is-busy" : ""}`}>
          <aside className="rp-side">
            <div className="rp-list" role="listbox" aria-label="Recordings">
              {items === null && <div className="rp-dim rp-pad">Loading…</div>}
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
                      {live && <span className="rp-live">● live</span>}
                    </span>
                    <span className="rp-item-goal">{s?.goal ?? meta.slug.replace(/-/g, " ")}</span>
                    <span className="rp-item-meta">
                      {it.error ? (
                        <span className="rp-err">{it.error}</span>
                      ) : s ? (
                        <>
                          {formatWall(s.durationMs)} · {s.events} events · {s.agents} agents{s.tasksTotal ? ` · ${s.tasksDone}/${s.tasksTotal} tasks` : ""}
                        </>
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
              <canvas ref={canvas} width={dims.w} height={dims.h} className="rp-canvas" aria-label="Replay preview" />
              {!scene && <div className="rp-stage-msg">{current?.error ?? (current && current.loaded && current.loaded.events.length === 0 ? "This recording has no events yet." : "Loading…")}</div>}
            </div>
            <div className="rp-transport">
              <Button size="sm" disabled={!scene || exporting} onClick={() => (playing ? stop() : play())} aria-label={playing ? "Pause" : "Play"}>
                {playing ? "❚❚ Pause" : "▶ Play"}
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
                aria-label="Scrub"
                onInput={(e) => {
                  stop();
                  paint(Number(e.currentTarget.value));
                }}
              />
              <span ref={timeLabel} className="rp-time mono">
                0:00 / {fmtSec(total)}
              </span>
              {rec && rec.file === selected && (
                <Button size="sm" variant="ghost" onClick={() => void refreshLive()} title="Load the events recorded since this preview was built">
                  Refresh
                </Button>
              )}
            </div>
            <div className="rp-options">
              <div className="rp-opt">
                <span className="rp-opt-label">Length</span>
                <Segmented size="sm" ariaLabel="Video length" value={String(prefs.length)} onChange={(v) => setPrefs({ length: Number(v) as ReplayLength })} options={LENGTHS.map((l) => ({ value: String(l), label: `${l} s` }))} />
              </div>
              <div className="rp-opt">
                <span className="rp-opt-label">Aspect</span>
                <Segmented
                  size="sm"
                  ariaLabel="Aspect ratio"
                  value={prefs.aspect}
                  onChange={(v) => setPrefs({ aspect: v })}
                  options={(Object.keys(ASPECTS) as Aspect[]).map((a) => ({ value: a, label: ASPECTS[a].label, title: `${ASPECTS[a].w}×${ASPECTS[a].h}` }))}
                />
              </div>
              <label className="rp-opt">
                <span className="rp-opt-label">Theme</span>
                <Select value={prefs.theme} onChange={(e) => setPrefs({ theme: e.target.value })} aria-label="Video theme">
                  <option value="active">Active theme</option>
                  {THEMES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </label>
              <div className="rp-opt">
                <Toggle checked={prefs.watermark} onChange={(v) => setPrefs({ watermark: v })} label="Watermark" hint="“Made with Gridkeeper” on the end card" />
              </div>
            </div>
            {summary && st && (
              <div className="rp-facts mono">
                <span>{formatClockRange(st.startT, st.endT)}</span>
                <span>{formatWall(st.wallMs)} → {prefs.length} s</span>
                <span>{summary.events} events</span>
                <span>{st.agents} agents</span>
                <span>
                  {st.tasksDone}/{st.tasksTotal} tasks
                </span>
                <span>
                  {st.commits} commits · +{st.ins} −{st.del}
                </span>
                {current?.loaded?.skipped ? <span className="rp-dim">{current.loaded.skipped} unreadable lines skipped</span> : null}
              </div>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}
