// Settings row for browser panes: engine (native view / embedded frame) and where new-window links go.

import { Field, Segmented } from "../components/ui/Field";
import { useT } from "../i18n";
import type { BrowserEngineSetting, BrowserNewWindow } from "../lib/types";
import { useApp } from "../store/appStore";
import { nativeSupported, useBrowserEngine, useEngineState } from "./engine";

export function BrowserSettings() {
  const t = useT();
  const setting = useApp((s) => s.persisted.settings.browserEngine);
  const newWindow = useApp((s) => s.persisted.settings.browserNewWindow);
  const failed = useEngineState((s) => s.failed);
  const engine = useBrowserEngine();
  const supported = nativeSupported();
  const update = useApp((s) => s.updateSettings);
  const value: BrowserEngineSetting = setting === "frame" || !supported ? "frame" : "native";
  const hint = !supported
    ? t("browser.settings.hintUnsupported")
    : failed
      ? t("browser.settings.hintFailed", { reason: failed })
      : engine === "native"
        ? t("browser.settings.hintNative")
        : t("browser.settings.hintFrame");
  return (
    <>
      <Field label={t("browser.settings.engine")} hint={hint}>
        <Segmented<BrowserEngineSetting>
          ariaLabel={t("browser.settings.engine")}
          value={value}
          onChange={(v) => update({ browserEngine: v })}
          options={[
            { value: "native", label: t("browser.settings.engineNative"), disabled: !supported },
            { value: "frame", label: t("browser.settings.engineFrame") },
          ]}
        />
      </Field>
      {engine === "native" && (
        <Field label={t("browser.settings.newWindow")}>
          <Segmented<BrowserNewWindow>
            ariaLabel={t("browser.settings.newWindow")}
            value={newWindow === "same" ? "same" : "pane"}
            onChange={(v) => update({ browserNewWindow: v })}
            options={[
              { value: "pane", label: t("browser.settings.newWindowPane") },
              { value: "same", label: t("browser.settings.newWindowSame") },
            ]}
          />
        </Field>
      )}
    </>
  );
}
