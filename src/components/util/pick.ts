// Native pickers / shell helpers. Every call is guarded: the plugin may be unavailable or reject.

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { notify } from "../../actions/notify";
import { errorMessage } from "../../lib/ipc";
import { isWindows } from "../../lib/platform";
import { t } from "../../i18n";

export async function pickFolder(title: string, defaultPath?: string | null): Promise<string | null> {
  try {
    const r = await open({ directory: true, multiple: false, title, defaultPath: defaultPath || undefined });
    return typeof r === "string" ? r : null;
  } catch (e) {
    notify("error", t("pick.folderUnavailable", { error: errorMessage(e) }));
    return null;
  }
}

export async function pickExecutable(title: string, defaultPath?: string | null): Promise<string | null> {
  try {
    const r = await open({
      directory: false,
      multiple: false,
      title,
      defaultPath: defaultPath || undefined,
      // macOS / Linux executables usually have no extension: no filter there.
      filters: isWindows
        ? [
            { name: t("pick.executables"), extensions: ["exe", "cmd", "bat", "ps1"] },
            { name: t("pick.allFiles"), extensions: ["*"] },
          ]
        : undefined,
    });
    return typeof r === "string" ? r : null;
  } catch (e) {
    notify("error", t("pick.fileUnavailable", { error: errorMessage(e) }));
    return null;
  }
}

export async function copyText(text: string, what = t("pick.copied")) {
  try {
    await writeText(text);
    notify("info", what);
  } catch (e) {
    notify("error", t("pick.clipboardUnavailable", { error: errorMessage(e) }));
  }
}

export async function revealPath(path: string) {
  try {
    await revealItemInDir(path);
  } catch (e) {
    notify("error", t("pick.revealFailed", { error: errorMessage(e) }));
  }
}
