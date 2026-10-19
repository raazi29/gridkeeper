// Settings: terminal, agents, keybindings, interface. Everything persists through updateSettings.

import { memo, useEffect, useState } from "react";
import { COMMANDS, THEME_COMMAND_PREFIX } from "../actions/commands";
import { notify } from "../actions/notify";
import { LOCALES, languageName, localeInfo, resolveLanguage, setLanguage, useI18n, useT, type LanguagePref, type MessageKey } from "../i18n";
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
import { Field, Input, NumberInput, Segmented, Select, Toggle } from "./ui/Field";
import { Modal } from "./ui/Modal";
import { pickExecutable } from "./util/pick";
import { TERMINAL_FONTS, preloadFont } from "../styles/fonts";
import { withSaber } from "../theme/saber";
import { THEMES, getTheme } from "../theme/themes";
import { HyperspaceToggle, MissionFxToggle, SaberSettings, ThemeEffects } from "./AppearanceExtras";
import { ThemeCard } from "./ThemeCard";
import { BrowserSettings } from "../browser/BrowserSettings";

type Section = "appearance" | "terminal" | "agents" | "keys" | "interface" | "notifications";
const SECTIONS: { id: Section; label: MessageKey }[] = [
  { id: "appearance", label: "settings.section.appearance" },
  { id: "terminal", label: "settings.section.terminal" },
  { id: "agents", label: "settings.section.agents" },
  { id: "keys", label: "settings.section.keys" },
  { id: "interface", label: "settings.section.interface" },
  { id: "notifications", label: "settings.section.notifications" },
];

function useSetting<K extends keyof Settings>(key: K): [Settings[K], (v: Settings[K]) => void] {
  const v = useApp((s) => s.persisted.settings[key]);
  return [v, (nv) => useApp.getState().updateSettings({ [key]: nv } as Partial<Settings>)];
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const initial = useUi((s) => (s.dialog?.kind === "settings" ? s.dialog.section : undefined));
  const [section, setSection] = useState<Section>((initial as Section) ?? "appearance");
  return (
    <Modal title={t("settings.title")} onClose={onClose} width={760} className="settings" footer={<Button onClick={onClose}>{t("common.done")}</Button>}>
      <div className="settings-layout">
        <nav className="settings-nav" role="tablist" aria-orientation="vertical">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={section === s.id} className={`settings-tab${section === s.id ? " is-active" : ""}`} onClick={() => setSection(s.id)}>
              {t(s.label)}
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
  const t = useT();
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
        <div className="micro-label">{t("settings.appearance.theme")}</div>
        <div className="theme-grid" role="radiogroup" aria-label={t("settings.appearance.theme")}>
          {THEMES.map((th) => (
            <ThemeCard key={th.id} theme={withSaber(th, saberColor)} selected={th.id === themeId} onSelect={() => useApp.getState().updateSettings({ theme: th.id })} />
          ))}
        </div>
        <ThemeEffects theme={theme} />
      </section>

      <section className="appearance-group form" aria-label={t("settings.appearance.saber")}>
        <div className="micro-label">{t("settings.appearance.saber")}</div>
        <SaberSettings theme={theme} />
      </section>

      <section className="appearance-group form">
        <div className="micro-label">{t("settings.appearance.interface")}</div>
        <Field label={t("settings.appearance.density")}>
          <Segmented<UiDensity>
            ariaLabel={t("settings.appearance.density")}
            value={density}
            onChange={setDensity}
            options={[
              { value: "compact", label: t("settings.appearance.densityCompact") },
              { value: "comfortable", label: t("settings.appearance.densityComfortable") },
            ]}
          />
        </Field>
        <Field label={t("settings.appearance.terminalFont")} hint={fontPreset === "custom" ? t("settings.appearance.terminalFontCustom") : t("settings.appearance.terminalFontBundled")}>
          <Segmented<string>
            ariaLabel={t("settings.appearance.terminalFont")}
            value={fontPreset}
            onChange={async (v) => {
              await preloadFont(v);
              useApp.getState().updateSettings({ fontFamily: v });
            }}
            options={TERMINAL_FONTS.map((f) => ({ value: f.value, label: f.label }))}
          />
        </Field>
        <Toggle
          checked={reduceMotion}
          onChange={setReduceMotion}
          label={t("settings.appearance.reduceMotion")}
          hint={isWindows ? t("settings.appearance.reduceMotionHintWindows") : t("settings.appearance.reduceMotionHintSystem")}
        />
        <HyperspaceToggle />
        <MissionFxToggle />
      </section>

      <section className="appearance-group">
        <div className="micro-label">{t("settings.appearance.modes")}</div>
        <div className="mode-row">
          <Button size="sm" className={focusMode ? "is-on" : undefined} onClick={() => useUi.getState().setFocusMode(!focusMode)}>
            {focusMode ? t("settings.appearance.focusModeExit") : t("settings.appearance.focusMode")}
          </Button>
          <Button size="sm" onClick={() => useUi.getState().setPresentation(!presentation)}>
            {presentation ? t("settings.appearance.presentationModeExit") : t("settings.appearance.presentationMode")}
          </Button>
        </div>
        <p className="explain">{t("settings.appearance.modesExplain")}</p>
      </section>
    </div>
  );
}

function TerminalSection() {
  const t = useT();
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
      <Field label={t("settings.terminal.renderer")} hint={renderer === "dom" ? t("settings.terminal.rendererHintDom") : t("settings.terminal.rendererHintWebgl")}>
        <Segmented<RendererPref>
          ariaLabel={t("settings.terminal.renderer")}
          value={renderer}
          onChange={setRenderer}
          options={[
            { value: "auto", label: t("settings.terminal.rendererAuto") },
            { value: "webgl", label: t("settings.terminal.rendererWebgl") },
            { value: "dom", label: t("settings.terminal.rendererDom") },
          ]}
        />
      </Field>
      <Field label={t("settings.terminal.fontFamily")} htmlFor="st-font">
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
        <Field label={t("settings.terminal.fontSize")} htmlFor="st-fs">
          <NumberInput id="st-fs" value={fontSize} min={8} max={32} onCommit={setFontSize} width={80} />
        </Field>
        <Field label={t("settings.terminal.lineHeight")} htmlFor="st-lh">
          <NumberInput id="st-lh" value={lineHeight} min={1} max={2} step={0.05} onCommit={(v) => setLineHeight(Math.round(v * 100) / 100)} width={80} />
        </Field>
      </div>
      <div className="field-pair">
        <Field label={t("settings.terminal.scrollback")} htmlFor="st-sb" hint={t("settings.terminal.scrollbackHint")}>
          <NumberInput id="st-sb" value={scrollback} min={500} max={100000} onCommit={setScrollback} />
        </Field>
        <Field label={t("settings.terminal.outputBuffer")} htmlFor="st-buf" hint={t("settings.terminal.outputBufferHint")}>
          <NumberInput id="st-buf" value={buffer} min={256} max={65536} onCommit={setBuffer} />
        </Field>
      </div>
      <Field label={t("settings.terminal.defaultLayout")}>
        <Segmented<LayoutPreset>
          ariaLabel={t("settings.terminal.defaultLayout")}
          value={layout}
          onChange={setLayout}
          options={[
            { value: "grid", label: t("settings.terminal.layoutGrid") },
            { value: "columns", label: t("settings.terminal.layoutColumns") },
            { value: "rows", label: t("settings.terminal.layoutRows") },
          ]}
        />
      </Field>
      <Field label={t("settings.terminal.rightClick")} hint={rightClick === "paste" ? t("settings.terminal.rightClickHintPaste") : t("settings.terminal.rightClickHintMenu")}>
        <Segmented<RightClickAction>
          ariaLabel={t("settings.terminal.rightClickAction")}
          value={rightClick === "paste" ? "paste" : "menu"}
          onChange={setRightClick}
          options={[
            { value: "menu", label: t("settings.terminal.rightClickMenu") },
            { value: "paste", label: t("settings.terminal.rightClickPaste") },
          ]}
        />
      </Field>
      <Toggle checked={blink} onChange={setBlink} label={t("settings.terminal.cursorBlink")} />
      <Toggle checked={pasteWarning} onChange={setPasteWarning} label={t("settings.terminal.pasteWarning")} hint={t("settings.terminal.pasteWarningHint")} />
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
          {t("settings.terminal.reset")}
        </Button>
      </div>
    </div>
  );
}

// Product names (Claude Code, Codex, PowerShell) are not translated; the hints are.
const AGENT_ROWS: { key: keyof AgentPaths; label: () => string; hint: MessageKey }[] =
  OS === "windows"
    ? [
        { key: "claude", label: () => "Claude Code", hint: "settings.agents.hintClaudeWindows" },
        { key: "codex", label: () => "Codex", hint: "settings.agents.hintCodexWindows" },
        { key: "powershell", label: () => "PowerShell", hint: "settings.agents.hintPowershellWindows" },
      ]
    : [
        { key: "claude", label: () => "Claude Code", hint: "settings.agents.hintClaudeUnix" },
        { key: "codex", label: () => "Codex", hint: "settings.agents.hintCodexUnix" },
        { key: "powershell", label: () => shellLabel(), hint: "settings.agents.hintShellUnix" },
      ];

function AgentsSection() {
  const t = useT();
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
      notify("info", t("settings.agents.detected", { found: found.filter((a) => a.path).length, total: found.length }));
    } catch (e) {
      notify("error", t("settings.agents.detectFailed", { error: errorMessage(e) }));
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="form">
      <div className="section-head-row">
        <p className="explain">{t("settings.agents.explain")}</p>
        <Button size="sm" onClick={() => void detect()} disabled={detecting}>
          {detecting ? t("settings.agents.detecting") : t("settings.agents.detect")}
        </Button>
      </div>
      {AGENT_ROWS.map((row) => {
        const label = row.label();
        const a = agents.find((x) => x.kind === row.key);
        const status = a
          ? a.path
            ? a.version
              ? t("settings.agents.statusDetectedVersion", { path: a.path, version: a.version })
              : t("settings.agents.statusDetected", { path: a.path })
            : a.error
              ? t("settings.agents.statusNotFoundError", { error: a.error })
              : t("settings.agents.statusNotFound")
          : t("settings.agents.statusNotDetected");
        return (
          <Field key={row.key} label={label} hint={<span title={t(row.hint)}>{status}</span>}>
            <div className="input-group">
              <Input
                mono
                key={paths[row.key] ?? ""}
                defaultValue={paths[row.key] ?? ""}
                placeholder={t("settings.agents.autoDetect")}
                aria-label={t("settings.agents.pathAria", { agent: label })}
                onBlur={(e) => {
                  const v = e.currentTarget.value.trim();
                  if ((v || null) !== paths[row.key]) setPath(row.key, v);
                }}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
              <Button
                icon={<IconFolder size={13} />}
                onClick={async () => {
                  const p = await pickExecutable(t("settings.agents.chooseExecutable", { agent: label }), paths[row.key]);
                  if (p) setPath(row.key, p);
                }}
              >
                {t("common.browse")}
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
  const t = useT();
  const [on, setOn] = useSetting("costMeter");
  return (
    <div className="cost-meter-setting">
      <div className="micro-label">{t("settings.agents.costMeter")}</div>
      <Toggle
        checked={on ?? false}
        onChange={(v) => {
          setOn(v);
          if (v) useApp.getState().updateSettings({ costMeterHintDismissed: true });
        }}
        label={t("settings.agents.costMeterLabel")}
        hint={t.rich("settings.agents.costMeterHint", { code: (c) => <code>{c}</code> })}
      />
    </div>
  );
}

function LanguageSetting() {
  const t = useT();
  const pref = useI18n((s) => s.pref);
  const locale = useI18n((s) => s.locale);
  const [busy, setBusy] = useState(false);
  const system = localeInfo(resolveLanguage("system"));
  return (
    <Field label={t("settings.interface.language")} htmlFor="st-lang" hint={t("settings.interface.languageHint")}>
      <Select
        id="st-lang"
        value={pref}
        disabled={busy}
        onChange={async (e) => {
          const next = e.currentTarget.value as LanguagePref;
          setBusy(true);
          try {
            await setLanguage(next);
          } finally {
            setBusy(false);
          }
        }}
      >
        <option value="system">{t("settings.interface.languageSystem", { language: system.nativeName })}</option>
        {LOCALES.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>
            {l.code === locale ? l.nativeName : `${l.nativeName} — ${languageName(l.code)}`}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function InterfaceSection() {
  const t = useT();
  const [diag, setDiag] = useSetting("statusBarDiagnostics");
  const [collapsed, setCollapsed] = useSetting("sidebarCollapsed");
  const [inspector, setInspector] = useSetting("inspectorOpen");
  const flightLog = useFlightLog((s) => s.data.enabled);
  return (
    <div className="form">
      <LanguageSetting />
      <Toggle checked={diag} onChange={setDiag} label={t("settings.interface.statusBarDiagnostics")} hint={t("settings.interface.statusBarDiagnosticsHint")} />
      <Toggle checked={collapsed} onChange={setCollapsed} label={t("settings.interface.sidebarRail")} />
      <Toggle checked={inspector} onChange={setInspector} label={t("settings.interface.inspector")} />
      <BrowserSettings />
      <Toggle checked={flightLog} onChange={setFlightLogEnabled} label={t("settings.interface.flightLog")} hint={t("settings.interface.flightLogHint")} />
      <div className="mode-row">
        <Button
          size="sm"
          onClick={async () => {
            const ok = await confirmDialog({
              title: t("settings.interface.flightLogResetTitle"),
              message: t("settings.interface.flightLogResetMessage"),
              confirmLabel: t("common.reset"),
              danger: true,
            });
            if (ok) {
              resetFlightLog();
              notify("info", t("settings.interface.flightLogResetDone"));
            }
          }}
        >
          {t("settings.interface.flightLogReset")}
        </Button>
      </div>
    </div>
  );
}

// ---- keybindings --------------------------------------------------------------

function KeysSection() {
  const t = useT();
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
    setMessage(owner ? { id, text: t("settings.keys.removedFrom", { command: titles[owner] ?? owner }), tone: "info" } : null);
  };

  const reset = (id: string) => {
    const next = { ...useApp.getState().persisted.settings.keybindings };
    delete next[id];
    useApp.getState().updateSettings({ keybindings: next });
    setMessage(null);
  };

  return (
    <div className="keys">
      <p className="explain explain-top">{OS === "macos" ? t("settings.keys.explainMac") : t("settings.keys.explain")}</p>
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
              if (reason) setMessage({ id, text: t("settings.keys.forbidden", { combo: displayCombo(combo), reason }), tone: "err" });
              else apply(id, combo);
            }}
            onUnbind={() => apply(id, "")}
            onReset={() => reset(id)}
          />
        ))}
      </div>
      <div className="row-end">
        <Button variant="ghost" size="sm" onClick={() => useApp.getState().updateSettings({ keybindings: {} })} disabled={Object.keys(overrides).length === 0}>
          {t("settings.keys.resetAll")}
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
  const t = useT();
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
        <button type="button" className={`key-combo${recording ? " is-recording" : ""}${combo ? "" : " is-unbound"}`} onClick={onRecord} title={t("settings.keys.recordTitle")}>
          {recording ? t("settings.keys.recording") : combo ? displayCombo(combo) : t("settings.keys.unbound")}
        </button>
        {message && <span className={`key-msg is-${message.tone}`}>{message.text}</span>}
      </span>
      <span role="cell" className="key-actions">
        {combo && (
          <button type="button" className="link-btn" onClick={onUnbind}>
            {t("settings.keys.unbind")}
          </button>
        )}
        {overridden && (
          <button type="button" className="link-btn" onClick={onReset}>
            {t("common.reset")}
          </button>
        )}
      </span>
    </div>
  );
});
