// Settings: terminal, agents, keybindings, interface. Everything persists through updateSettings.

import { memo, useEffect, useState } from "react";
import { COMMANDS, THEME_COMMAND_PREFIX } from "../actions/commands";
import { notify } from "../actions/notify";
import { defaultBindings, displayCombo, eventToCombo, forbiddenReason } from "../keybindings/combo";
import { OS, isWindows, shellLabel } from "../lib/platform";
import { errorMessage, ipc } from "../lib/ipc";
import type { AgentPaths, LayoutPreset, RendererPref, RightClickAction, Settings, UiDensity } from "../lib/types";
import { DEFAULT_SETTINGS } from "../lib/types";
import { useApp } from "../store/appStore";
import { resetFlightLog, setFlightLogEnabled, useFlightLog } from "../store/flightlog";
import { confirmDialog, setKeyRecording, useUi } from "../store/uiStore";
import { useShortcutMap } from "./hooks";
import { NotificationSettings } from "./NotificationSettings";
import { IconFolder } from "./icons";
import { Button } from "./ui/Button";
import { Field, Input, NumberInput, Segmented, Toggle } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { pickExecutable } from "./util/pick";
import { TERMINAL_FONTS, preloadFont } from "../styles/fonts";
import { withSaber } from "../theme/saber";
import { THEMES, getTheme } from "../theme/themes";
import { HyperspaceToggle, SaberSettings, ThemeEffects } from "./AppearanceExtras";
import { ThemeCard } from "./ThemeCard";
import { BrowserSettings } from "../browser/BrowserSettings";

type Section = "appearance" | "terminal" | "agents" | "keys" | "interface" | "notifications";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "agents", label: "Agents" },
  { id: "keys", label: "Keybindings" },
  { id: "interface", label: "Interface" },
  { id: "notifications", label: "Notifications" },
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
          {section === "notifications" && <NotificationSettings />}
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
  const saberColor = useApp((s) => s.persisted.settings.saberColor);
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
            <ThemeCard key={t.id} theme={withSaber(t, saberColor)} selected={t.id === themeId} onSelect={() => useApp.getState().updateSettings({ theme: t.id })} />
          ))}
        </div>
        <ThemeEffects theme={theme} />
      </section>

      <section className="appearance-group form" aria-label="Saber">
        <div className="micro-label">Saber</div>
        <SaberSettings theme={theme} />
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
        <Toggle checked={reduceMotion} onChange={setReduceMotion} label="Reduce motion" hint={`Turns off transitions, lamp pulses, the holo band, the hyperspace jump, saber effects and the CRT overlay. Also follows the ${isWindows ? "Windows animation" : "system reduce-motion"} setting.`} />
        <HyperspaceToggle />
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

function TerminalSection() {
  const [scrollback, setScrollback] = useSetting("scrollbackLines");
  const [buffer, setBuffer] = useSetting("bufferKib");
  const [fontFamily, setFontFamily] = useSetting("fontFamily");
  const [fontSize, setFontSize] = useSetting("fontSize");
  const [lineHeight, setLineHeight] = useSetting("lineHeight");
  const [blink, setBlink] = useSetting("cursorBlink");
  const [pasteWarning, setPasteWarning] = useSetting("pasteWarning");
  const [rightClick, setRightClick] = useSetting("rightClickAction");
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
      <Field
        label="Right-click"
        hint={
          rightClick === "paste"
            ? "Copies the selection, or pastes when nothing is selected. Shift+right-click opens the menu."
            : "Opens the terminal menu (copy, paste, find, zoom, split, restart…). Programs that use the mouse get plain right-clicks; Shift+right-click opens the menu there."
        }
      >
        <Segmented<RightClickAction>
          ariaLabel="Right-click action"
          value={rightClick === "paste" ? "paste" : "menu"}
          onChange={setRightClick}
          options={[
            { value: "menu", label: "Menu (default)" },
            { value: "paste", label: "Paste (Windows Terminal style)" },
          ]}
        />
      </Field>
      <Toggle checked={blink} onChange={setBlink} label="Cursor blink" />
      <Toggle
        checked={pasteWarning}
        onChange={setPasteWarning}
        label="Confirm large pastes"
        hint="Ask before pasting more than 20 lines or 64 KiB into a program that has not enabled bracketed paste. Programs that enable it (e.g. Claude Code, Codex) are never asked."
      />
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
              rightClickAction: DEFAULT_SETTINGS.rightClickAction,
            })
          }
        >
          Reset terminal settings
        </Button>
      </div>
    </div>
  );
}

const AGENT_ROWS: { key: keyof AgentPaths; label: string; hint: string }[] =
  OS === "windows"
    ? [
        { key: "claude", label: "Claude Code", hint: "claude.exe (native install preferred over the npm claude.cmd shim)" },
        { key: "codex", label: "Codex", hint: "codex.exe or codex.cmd" },
        { key: "powershell", label: "PowerShell", hint: "pwsh.exe (PowerShell 7) or powershell.exe" },
      ]
    : [
        { key: "claude", label: "Claude Code", hint: "claude (native install in ~/.local/bin preferred, else PATH)" },
        { key: "codex", label: "Codex", hint: "codex on PATH" },
        { key: "powershell", label: shellLabel(), hint: "Login shell ($SHELL), e.g. /bin/zsh; any shell path works, including pwsh" },
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
      <CostMeterSetting />
    </div>
  );
}

function CostMeterSetting() {
  const [on, setOn] = useSetting("costMeter");
  return (
    <div className="cost-meter-setting">
      <div className="micro-label">Cost meter</div>
      <Toggle
        checked={on ?? false}
        onChange={(v) => {
          setOn(v);
          if (v) useApp.getState().updateSettings({ costMeterHintDismissed: true });
        }}
        label="Cost & context meter for Claude panes"
        hint={
          <>
            Shows Claude Code's own estimate (list price; on a subscription that is API-equivalent value, not a bill) and context
            use in each Claude pane header, in Mission Control and in Fleet. Gridkeeper starts Claude with a <code>--settings</code> file in
            its own data folder that sets only <code>statusLine</code>. Claude then hands Gridkeeper the status line numbers: session id,
            cost, durations, context size and use, token counts, the current usage breakdown, rate limits and the model name. Nothing
            from transcripts or credentials is read. It replaces Claude's status line in Gridkeeper panes, unless you have your own: then
            Gridkeeper runs yours and it shows as before (it finds it by reading <code>statusLine</code> from your Claude settings files,
            read-only). A pane that passes its own <code>--settings</code> isn't metered.
            Codex and Gemini CLI report no usage to other programs (shown as n/a). Applies to newly started Claude panes: restart a
            pane to apply.
          </>
        }
      />
    </div>
  );
}

function InterfaceSection() {
  const [diag, setDiag] = useSetting("statusBarDiagnostics");
  const [collapsed, setCollapsed] = useSetting("sidebarCollapsed");
  const [inspector, setInspector] = useSetting("inspectorOpen");
  const flightLog = useFlightLog((s) => s.data.enabled);
  return (
    <div className="form">
      <Toggle checked={diag} onChange={setDiag} label="Resource usage in status bar" hint="Polls every 2 s, only while the window is visible." />
      <Toggle checked={collapsed} onChange={setCollapsed} label="Collapse sidebar to a rail" />
      <Toggle checked={inspector} onChange={setInspector} label="Show inspector panel" />
      <BrowserSettings />
      <Toggle
        checked={flightLog}
        onChange={setFlightLogEnabled}
        label="Flight log (streaks, ranks, medals)"
        hint="A daily streak, ranks and medals from mission tasks Gridkeeper sees completed, shown in Mission Control. Stored on this machine only. Off stops counting and hides it."
      />
      <div className="mode-row">
        <Button
          size="sm"
          onClick={async () => {
            const ok = await confirmDialog({
              title: "Reset the flight log?",
              message: "Streak, rank, totals and medals go back to zero. This can't be undone.",
              confirmLabel: "Reset",
              danger: true,
            });
            if (ok) {
              resetFlightLog();
              notify("info", "Flight log reset.");
            }
          }}
        >
          Reset flight log
        </Button>
      </div>
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
    const defaults = defaultBindings();
    for (const [cid, c] of Object.entries(next)) if (defaults[cid] === c || (!(cid in defaults) && c === "")) delete next[cid];
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
        {OS === "macos"
          ? "Click a shortcut to record a new one. Terminal keys are protected: ⌃ Control combinations, ⌥+letter, arrows, Tab, Return, Esc and function keys always go to the terminal, and macOS / Edit-menu shortcuts (⌘C, ⌘V, ⌘Q, ⌘Tab …) stay with the system."
          : "Click a shortcut to record a new one. Terminal keys are protected: plain Ctrl+letter, Alt+letter, arrows, Tab, Enter, Esc and function keys always go to the terminal."}
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
