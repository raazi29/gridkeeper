// Settings row for browser panes: engine (native view / embedded frame) and where new-window links go.

import { Field, Segmented } from "../components/ui/Field";
import type { BrowserEngineSetting, BrowserNewWindow } from "../lib/types";
import { useApp } from "../store/appStore";
import { nativeSupported, useBrowserEngine, useEngineState } from "./engine";

export function BrowserSettings() {
  const setting = useApp((s) => s.persisted.settings.browserEngine);
  const newWindow = useApp((s) => s.persisted.settings.browserNewWindow);
  const failed = useEngineState((s) => s.failed);
  const engine = useBrowserEngine();
  const supported = nativeSupported();
  const update = useApp((s) => s.updateSettings);
  const value: BrowserEngineSetting = setting === "frame" || !supported ? "frame" : "native";
  const hint = !supported
    ? "Native browser panes are only available on Windows for now; pages use the embedded frame."
    : failed
      ? `Native views failed this run (${failed}); embedded frames are used until restart.`
      : engine === "native"
        ? "Each pane is a real WebView2 view: every site works (sign-ins, GitHub, Google), with real back / forward and page titles. Menus and dialogs hide it while they are open."
        : "Pages run in a sandboxed frame inside the app: sites that refuse framing open in a pop-out window, and links that open a new window do nothing.";
  return (
    <>
      <Field label="Browser engine" hint={hint}>
        <Segmented<BrowserEngineSetting>
          ariaLabel="Browser engine"
          value={value}
          onChange={(v) => update({ browserEngine: v })}
          options={[
            { value: "native", label: "Native (recommended)", disabled: !supported },
            { value: "frame", label: "Embedded frame (legacy)" },
          ]}
        />
      </Field>
      {engine === "native" && (
        <Field label="Links that open a new window">
          <Segmented<BrowserNewWindow>
            ariaLabel="Links that open a new window"
            value={newWindow === "same" ? "same" : "pane"}
            onChange={(v) => update({ browserNewWindow: v })}
            options={[
              { value: "pane", label: "New browser pane" },
              { value: "same", label: "Same pane" },
            ]}
          />
        </Field>
      )}
    </>
  );
}
