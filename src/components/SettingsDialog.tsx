// Settings: terminal, agents, keybindings, interface. Everything persists through updateSettings.

import { memo, useEffect, useState } from "react";
import { COMMANDS, THEME_COMMAND_PREFIX } from "../actions/commands";
import { notify } from "../actions/notify";
import { DEFAULT_BINDINGS, displayCombo, eventToCombo, forbiddenReason } from "../keybindings/combo";
import { errorMessage, ipc } from "../lib/ipc";
import type { AgentPaths, LayoutPreset, RendererPref, Settings, UiDensity } from "../lib/types";
import { DEFAULT_SETTINGS } from "../lib/types";
import { useApp } from "../store/appStore";
import { setKeyRecording, useUi } from "../store/uiStore";
import { useShortcutMap } from "./hooks";
import { IconFolder } from "./icons";
import { Button } from "./ui/Button";
import { Field, Input, NumberInput, Segmented, Toggle } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { pickExecutable } from "./util/pick";
import { TERMINAL_FONTS, preloadFont } from "../styles/fonts";
import { themeScopeStyle } from "../theme/applyTheme";
import { THEMES, getTheme, type Theme } from "../theme/themes";

type Section = "appearance" | "terminal" | "agents" | "keys" | "interface";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "agents", label: "Agents" },
  { id: "keys", label: "Keybindings" },
  { id: "interface", label: "Interface" },
];

function useSetting<K extends keyof Settings>(key: K): [Settings[K], (v: Settings[K]) => void] {
  const v = useApp((s) => s.persisted.settings[key]);
  return [v, (nv) => useApp.getState().updateSettings({ [key]: nv } as Partial<Settings>)];
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const initial = useUi((s) => (s.dialog?.kind === "settings" ? s.dialog.section : undefined));
  const [section, setSection] = useState<Section>((initial as Section) ?? "appearance");
  return (
    <Modal title="Settings" onClose={onClose} width={760} className="settings" footer={<Button onClick={onClose}>Done</Button>}>
      <div className="settings-layout">
        <nav className="settings-nav" role="tablist" aria-orientation="vertical">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={section === s.id} className={`settings-tab${section === s.id ? " is-active" : ""}`} onClick={() => setSection(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="settings-content">
          {section === "appearance" && <AppearanceSection />}
          {section === "terminal" && <TerminalSection />}
          {section === "agents" && <AgentsSection />}
          {section === "keys" && <KeysSection />}
          {section === "interface" && <InterfaceSection />}
        </div>
      </div>
    </Modal>
  );
}

// ---- appearance -----------------------------------------------------------------

function AppearanceSection() {
  const themeId = getTheme(useApp((s) => s.persisted.settings.theme)).id;
  const [density, setDensity] = useSetting("uiDensity");
  const [reduceMotion, setReduceMotion] = useSetting("reduceMotion");
  const fontFamily = useApp((s) => s.persisted.settings.fontFamily);
  const scanlines = useUi((s) => s.scanlines);
  const focusMode = useUi((s) => s.focusMode);
  const presentation = useUi((s) => s.presentation);
  const theme = getTheme(themeId);
  const fontPreset = TERMINAL_FONTS.find((f) => f.value === fontFamily)?.value ?? "custom";

  return (
    <div className="appearance">
      <section className="appearance-group">
        <div className="micro-label">Theme</div>
        <div className="theme-grid" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <ThemeCard key={t.id} theme={t} selected={t.id === themeId} onSelect={() => useApp.getState().updateSettings({ theme: t.id })} />
          ))}
        </div>
      </section>

      <section className="appearance-group form">
        <div className="micro-label">Interface</div>
        <Field label="Density">
          <Segmented<UiDensity>
            ariaLabel="Density"
            value={density}
            onChange={setDensity}
            options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfortable" },
            ]}
          />
        </Field>
        <Field label="Terminal font" hint={fontPreset === "custom" ? "Custom font set in Terminal settings" : "Bundled fonts work offline"}>
          <Segmented<string>
            ariaLabel="Terminal font"
            value={fontPreset}
            onChange={async (v) => {
              await preloadFont(v);
              useApp.getState().updateSettings({ fontFamily: v });
            }}
            options={TERMINAL_FONTS.map((f) => ({ value: f.value, label: f.label }))}
          />
        </Field>
        <Toggle checked={reduceMotion} onChange={setReduceMotion} label="Reduce motion" hint="Turns off transitions, lamp pulses and the CRT overlay. Also follows the Windows animation setting." />
        {theme.effects?.scanlines && (
          <Toggle checked={scanlines} onChange={(v) => useUi.getState().setScanlines(v)} disabled={reduceMotion} label="CRT scanlines" hint={`Static scanline overlay on panes (${theme.name} only).`} />
        )}
      </section>

      <section className="appearance-group">
        <div className="micro-label">Modes</div>
        <div className="mode-row">
          <Button size="sm" className={focusMode ? "is-on" : undefined} onClick={() => useUi.getState().setFocusMode(!focusMode)}>
            {focusMode ? "Exit focus mode" : "Focus mode"}
          </Button>
          <Button size="sm" onClick={() => useUi.getState().setPresentation(!presentation)}>
            {presentation ? "Exit presentation mode" : "Presentation mode"}
          </Button>
        </div>
        <p className="explain">Focus hides the sidebar, tabs and status bar (Esc outside a terminal exits). Presentation enlarges terminal text by 3 pt and scales the interface. Neither is saved between runs.</p>
      </section>
    </div>
  );
}

const PREVIEW_LINES = (t: Theme) => {
  const c = t.terminal;
  return [
    [
      [c.green, "❯ "],
      [c.blue, "claude "],
      [c.brightBlack, "--continue"],
    ],
    [
      [c.yellow, "● "],
      [c.foreground, "edit "],
      [c.cyan, "app.ts "],
      [c.brightBlack, "+12 −3"],
    ],
    [
      [c.green, "✓ 41 "],
      [c.red, "✗ 1 "],
      [c.magenta, "0.8s "],
      [c.brightBlack, "vitest"],
    ],
  ] as [string, string][][];
};

const ThemeCard = memo(function ThemeCard({ theme, selected, onSelect }: { theme: Theme; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`theme-card${selected ? " is-selected" : ""}`}
      style={themeScopeStyle(theme)}
      data-theme-scope={theme.id}
      data-autofocus={selected || undefined}
      onClick={onSelect}
      title={theme.description}
    >
      <span className="tcp" aria-hidden="true">
        <span className="tcp-side">
          <i className="is-on" />
          <i />
          <i />
        </span>
        <span className="tcp-main">
          <span className="tcp-pane">
            <span className="tcp-head">
              <b />
              <i />
            </span>
            <span className="tcp-term">
              {PREVIEW_LINES(theme).map((line, i) => (
                <span key={i} style={{ display: "block" }}>
                  {line.map(([color, text], j) => (
                    <span key={j} style={{ color }}>
                      {text}
                    </span>
                  ))}
                </span>
              ))}
            </span>
          </span>
        </span>
      </span>
      <span className="theme-card-meta">
        <span className="theme-card-name">{theme.name}</span>
        <span className="theme-card-kind">{theme.kind}</span>
      </span>
      <span className="theme-card-desc">{theme.description}</span>
    </button>
  );
});

function TerminalSection() {
  const [scrollback, setScrollback] = useSetting("scrollbackLines");
  const [buffer, setBuffer] = useSetting("bufferKib");
  const [fontFamily, setFontFamily] = useSetting("fontFamily");
  const [fontSize, setFontSize] = useSetting("fontSize");
  const [lineHeight, setLineHeight] = useSetting("lineHeight");
  const [blink, setBlink] = useSetting("cursorBlink");
  const [renderer, setRenderer] = useSetting("renderer");
  const [layout, setLayout] = useSetting("defaultLayout");
  return (
    <div className="form">
      <Field label="Renderer" hint={renderer === "dom" ? "Software rendering: lowest GPU use, slower with heavy output." : "WebGL uses the GPU to draw text; falls back to DOM if a context is lost."}>
        <Segmented<RendererPref>
          ariaLabel="Renderer"
          value={renderer}
          onChange={setRenderer}
          options={[
            { value: "auto", label: "Auto (WebGL, recommended)" },
            { value: "webgl", label: "WebGL" },
            { value: "dom", label: "DOM (software)" },
          ]}
        />
      </Field>
      <Field label="Font family" htmlFor="st-font">
        <Input
          id="st-font"
          mono
          key={fontFamily}
          defaultValue={fontFamily}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (v && v !== fontFamily) setFontFamily(v);
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </Field>
      <div className="field-pair">
        <Field label="Font size" htmlFor="st-fs">
          <NumberInput id="st-fs" value={fontSize} min={8} max={32} onCommit={setFontSize} width={80} />
        </Field>
        <Field label="Line height" htmlFor="st-lh">
          <NumberInput id="st-lh" value={lineHeight} min={1} max={2} step={0.05} onCommit={(v) => setLineHeight(Math.round(v * 100) / 100)} width={80} />
        </Field>
      </div>
      <div className="field-pair">
        <Field label="Scrollback" htmlFor="st-sb" hint="Lines kept per terminal view">
          <NumberInput id="st-sb" value={scrollback} min={500} max={100000} onCommit={setScrollback} />
        </Field>
        <Field label="Output buffer" htmlFor="st-buf" hint="KiB kept per session in the backend (replayed on reattach)">
          <NumberInput id="st-buf" value={buffer} min={256} max={65536} onCommit={setBuffer} />
        </Field>
      </div>
      <Field label="Default layout">
        <Segmented<LayoutPreset>
          ariaLabel="Default layout"
          value={layout}
          onChange={setLayout}
          options={[
            { value: "grid", label: "Grid" },
            { value: "columns", label: "Columns" },
            { value: "rows", label: "Rows" },
          ]}
        />
      </Field>
      <Toggle checked={blink} onChange={setBlink} label="Cursor blink" />
      <div className="row-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            useApp.getState().updateSettings({
              scrollbackLines: DEFAULT_SETTINGS.scrollbackLines,
              bufferKib: DEFAULT_SETTINGS.bufferKib,
              fontFamily: DEFAULT_SETTINGS.fontFamily,
              fontSize: DEFAULT_SETTINGS.fontSize,
              lineHeight: DEFAULT_SETTINGS.lineHeight,
              cursorBlink: DEFAULT_SETTINGS.cursorBlink,
              renderer: DEFAULT_SETTINGS.renderer,
            })
          }
        >
          Reset terminal settings
        </Button>
      </div>
    </div>
  );
}

const AGENT_ROWS: { key: keyof AgentPaths; label: string; hint: string }[] = [
  { key: "claude", label: "Claude Code", hint: "claude.exe (native install preferred over the npm claude.cmd shim)" },
  { key: "codex", label: "Codex", hint: "codex.exe or codex.cmd" },
  { key: "powershell", label: "PowerShell", hint: "pwsh.exe (PowerShell 7) or powershell.exe" },
];

function AgentsSection() {
  const paths = useApp((s) => s.persisted.settings.agentPaths);
  const agents = useApp((s) => s.agents);
  const [detecting, setDetecting] = useState(false);

  const setPath = (key: keyof AgentPaths, value: string | null) => {
    const cur = useApp.getState().persisted.settings.agentPaths;
    useApp.getState().updateSettings({ agentPaths: { ...cur, [key]: value && value.trim() ? value.trim() : null } });
  };

  const detect = async () => {
    setDetecting(true);
    try {
      const found = await ipc.agentsDetect();
      useApp.getState().setAgents(found);
      notify("info", `Detected ${found.filter((a) => a.path).length} of ${found.length} agents`);
    } catch (e) {
      notify("error", `Detection failed: ${errorMessage(e)}`);
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="form">
      <div className="section-head-row">
        <p className="explain">Leave a path empty to auto-detect from PATH and standard install locations. A path set here takes precedence.</p>
        <Button size="sm" onClick={() => void detect()} disabled={detecting}>
          {detecting ? "Detecting…" : "Detect"}
        </Button>
      </div>
      {AGENT_ROWS.map((row) => {
        const a = agents.find((x) => x.kind === row.key);
        const status = a ? (a.path ? `Detected: ${a.path}${a.version ? ` — ${a.version}` : ""}` : `Not found${a.error ? `: ${a.error}` : ""}`) : "Not detected yet";
        return (
          <Field key={row.key} label={row.label} hint={<span title={row.hint}>{status}</span>}>
            <div className="input-group">
              <Input
                mono
                key={paths[row.key] ?? ""}
                defaultValue={paths[row.key] ?? ""}
                placeholder="Auto-detect"
                aria-label={`${row.label} executable path`}
                onBlur={(e) => {
                  const v = e.currentTarget.value.trim();
                  if ((v || null) !== paths[row.key]) setPath(row.key, v);
                }}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
              <Button
                icon={<IconFolder size={13} />}
                onClick={async () => {
                  const p = await pickExecutable(`Choose ${row.label} executable`, paths[row.key]);
                  if (p) setPath(row.key, p);
                }}
              >
                Browse…
              </Button>
            </div>
          </Field>
        );
      })}
    </div>
  );
}

function InterfaceSection() {
  const [diag, setDiag] = useSetting("statusBarDiagnostics");
  const [collapsed, setCollapsed] = useSetting("sidebarCollapsed");
  const [inspector, setInspector] = useSetting("inspectorOpen");
  return (
    <div className="form">
      <Toggle checked={diag} onChange={setDiag} label="Resource usage in status bar" hint="Polls every 2 s, only while the window is visible." />
      <Toggle checked={collapsed} onChange={setCollapsed} label="Collapse sidebar to a rail" />
      <Toggle checked={inspector} onChange={setInspector} label="Show inspector panel" />
    </div>
  );
}

// ---- keybindings --------------------------------------------------------------

function KeysSection() {
  const overrides = useApp((s) => s.persisted.settings.keybindings);
  const effective = useShortcutMap();
  const [recording, setRecording] = useState<string | null>(null);
  const [message, setMessage] = useState<{ id: string; text: string; tone: "err" | "info" } | null>(null);
  const titles = Object.fromEntries(COMMANDS.map((c) => [c.id, c.title]));
  // Per-theme commands live in the palette; listing nine of them here would bury the real shortcuts.
  const ids = COMMANDS.filter((c) => !c.id.startsWith(THEME_COMMAND_PREFIX)).map((c) => c.id);

  const apply = (id: string, combo: string) => {
    const next: Record<string, string> = { ...useApp.getState().persisted.settings.keybindings, [id]: combo };
    // Unbind whichever other command currently owns the combo.
    const owner = combo ? Object.entries(effective).find(([cid, c]) => c === combo && cid !== id)?.[0] : undefined;
    if (owner) next[owner] = "";
    // Drop overrides equal to the default to keep the file tidy.
    for (const [cid, c] of Object.entries(next)) if (DEFAULT_BINDINGS[cid] === c || (!(cid in DEFAULT_BINDINGS) && c === "")) delete next[cid];
    useApp.getState().updateSettings({ keybindings: next });
    setMessage(owner ? { id, text: `Removed from “${titles[owner] ?? owner}”`, tone: "info" } : null);
  };

  const reset = (id: string) => {
    const next = { ...useApp.getState().persisted.settings.keybindings };
    delete next[id];
    useApp.getState().updateSettings({ keybindings: next });
    setMessage(null);
  };

  return (
    <div className="keys">
      <p className="explain explain-top">
        Click a shortcut to record a new one. Terminal keys are protected: plain Ctrl+letter, Alt+letter, arrows, Tab, Enter, Esc and function keys always go to the terminal.
      </p>
      <div className="keys-list" role="table">
        {ids.map((id) => (
          <KeyRow
            key={id}
            id={id}
            title={titles[id]}
            combo={effective[id] ?? ""}
            overridden={id in overrides}
            recording={recording === id}
            message={message?.id === id ? message : null}
            onRecord={() => {
              setMessage(null);
              setRecording(id);
            }}
            onCancel={() => setRecording(null)}
            onRecorded={(combo) => {
              setRecording(null);
              const reason = forbiddenReason(combo);
              if (reason) setMessage({ id, text: `${displayCombo(combo)}: ${reason}`, tone: "err" });
              else apply(id, combo);
            }}
            onUnbind={() => apply(id, "")}
            onReset={() => reset(id)}
          />
        ))}
      </div>
      <div className="row-end">
        <Button variant="ghost" size="sm" onClick={() => useApp.getState().updateSettings({ keybindings: {} })} disabled={Object.keys(overrides).length === 0}>
          Reset all to defaults
        </Button>
      </div>
    </div>
  );
}

const KeyRow = memo(function KeyRow({
  id,
  title,
  combo,
  overridden,
  recording,
  message,
  onRecord,
  onCancel,
  onRecorded,
  onUnbind,
  onReset,
}: {
  id: string;
  title: string;
  combo: string;
  overridden: boolean;
  recording: boolean;
  message: { text: string; tone: "err" | "info" } | null;
  onRecord: () => void;
  onCancel: () => void;
  onRecorded: (combo: string) => void;
  onUnbind: () => void;
  onReset: () => void;
}) {
  useEffect(() => {
    if (!recording) return;
    setKeyRecording(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        onCancel();
        return;
      }
      const c = eventToCombo(e);
      if (c) onRecorded(c);
    };
    const onDown = () => onCancel();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      setKeyRecording(false);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [recording, onCancel, onRecorded]);

  return (
    <div className="key-row" role="row">
      <span className="key-title" role="cell" title={id}>
        {title}
      </span>
      <span role="cell" className="key-cell">
        <button type="button" className={`key-combo${recording ? " is-recording" : ""}${combo ? "" : " is-unbound"}`} onClick={onRecord} title="Click to record a new shortcut">
          {recording ? "Press keys… (Esc cancels)" : combo ? displayCombo(combo) : "Unbound"}
        </button>
        {message && <span className={`key-msg is-${message.tone}`}>{message.text}</span>}
      </span>
      <span role="cell" className="key-actions">
        {combo && (
          <button type="button" className="link-btn" onClick={onUnbind}>
            Unbind
          </button>
        )}
        {overridden && (
          <button type="button" className="link-btn" onClick={onReset}>
            Reset
          </button>
        )}
      </span>
    </div>
  );
});
