// Native pickers / shell helpers. Every call is guarded: the plugin may be unavailable or reject.

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { notify } from "../../actions/notify";
import { errorMessage } from "../../lib/ipc";
import { isWindows } from "../../lib/platform";

export async function pickFolder(title: string, defaultPath?: string | null): Promise<string | null> {
  try {
    const r = await open({ directory: true, multiple: false, title, defaultPath: defaultPath || undefined });
    return typeof r === "string" ? r : null;
  } catch (e) {
    notify("error", `Folder picker unavailable: ${errorMessage(e)}`);
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
            { name: "Executables", extensions: ["exe", "cmd", "bat", "ps1"] },
            { name: "All files", extensions: ["*"] },
          ]
        : undefined,
    });
    return typeof r === "string" ? r : null;
  } catch (e) {
    notify("error", `File picker unavailable: ${errorMessage(e)}`);
    return null;
  }
}

export async function copyText(text: string, what = "Copied") {
  try {
    await writeText(text);
    notify("info", what);
  } catch (e) {
    notify("error", `Clipboard unavailable: ${errorMessage(e)}`);
  }
}

export async function revealPath(path: string) {
  try {
    await revealItemInDir(path);
  } catch (e) {
    notify("error", `Could not open folder: ${errorMessage(e)}`);
  }
}
