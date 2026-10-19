// URL rules for browser panes (pure; mirrors src-tauri/src/browser.rs validate_url / is_app_origin).
// Browser panes may show http / https (with a host) and file URLs, at most 2048 characters.

import { OS, type Os } from "./platform";

export const MAX_URL_LEN = 2048;

/** Hosts Tauri serves its own protocols on (Windows form http://<protocol>.localhost). */
const APP_PROTOCOL_HOSTS = new Set(["tauri.localhost", "ipc.localhost", "asset.localhost"]);

/**
 * iframe sandbox for in-pane pages. No allow-top-navigation (a page can never navigate the app), no
 * allow-popups (target=_blank does nothing; use "Open in browser"). allow-same-origin is safe ONLY
 * because pages on the app's own origins are never framed (see frameMode): the page keeps its own
 * origin (e.g. http://localhost:5173), which cannot reach the parent document, and Tauri's IPC
 * scripts are injected into the main frame only.
 */
export const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-pointer-lock";

/** Parse + validate; returns the normalized href or null. */
export function validateUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > MAX_URL_LEN || /[\s\u0000-\u001f\u007f]/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol === "http:" || u.protocol === "https:") {
    if (!u.hostname) return null;
  } else if (u.protocol !== "file:") return null;
  if (u.password) return null;
  return u.href.length <= MAX_URL_LEN ? u.href : null;
}

const LOCAL_HOST_RE = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1?\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.localhost)$/i;

/**
 * Turn what the user typed into a URL: "localhost:5173", ":5173" and "5173" become http://localhost…,
 * "example.com/x" becomes https://…, "C:\docs\a.html" becomes file:///C:/docs/a.html (on macOS / Linux,
 * "/home/me/a.html" becomes file:///home/me/a.html). Null if not usable.
 */
export function normalizeUrlInput(input: string, os: Os = OS): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^:?\d{2,5}(\/.*)?$/.test(s)) {
    const m = /^:?(\d{2,5})(\/.*)?$/.exec(s)!;
    const port = Number(m[1]);
    return port > 0 && port < 65536 ? validateUrl(`http://localhost:${port}${m[2] ?? "/"}`) : null;
  }
  if (/^[a-z]:[\\/]/i.test(s)) {
    try {
      // URL() percent-encodes spaces etc. before validation.
      return validateUrl(new URL(`file:///${s.replace(/\\/g, "/")}`).href);
    } catch {
      return null;
    }
  }
  if (os !== "windows" && /^\/(?!\/)/.test(s)) {
    try {
      return validateUrl(new URL(`file://${s}`).href);
    } catch {
      return null;
    }
  }
  if (/^https?:\/\//i.test(s) || /^file:\/\//i.test(s)) return validateUrl(s);
  const hostPart = s.split(/[/?#]/)[0];
  const host = hostPart.replace(/:\d+$/, "");
  if (LOCAL_HOST_RE.test(host)) return validateUrl(`http://${s}`);
  // LAN dev servers (192.168.1.20:5173, devbox:8080) have no certificate: http, not https.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || /:\d+$/.test(hostPart)) return validateUrl(`http://${s}`);
  // Any other scheme (javascript:, data:, ftp:, …) is refused.
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return null;
  if (/^[^\s.]+(\.[^\s.]+)+$/.test(host)) return validateUrl(`https://${s}`);
  return null;
}

function hostOf(href: string): string {
  try {
    return new URL(href).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** A dev server on this machine (localhost, 127.x, ::1, 0.0.0.0, *.localhost) — never the app itself. */
export function isLocalDevUrl(href: string): boolean {
  const h = hostOf(href);
  return !!h && LOCAL_HOST_RE.test(h) && !APP_PROTOCOL_HOSTS.has(h);
}

/** True for the app's own origins, which must never be framed or opened in a browser pane. */
export function isAppOrigin(href: string, ownOrigin: string): boolean {
  try {
    const u = new URL(href);
    if (u.protocol === "tauri:" || u.protocol === "ipc:" || u.protocol === "asset:") return true;
    if (APP_PROTOCOL_HOSTS.has(u.hostname.toLowerCase().replace(/\.$/, ""))) return true;
    return !!ownOrigin && ownOrigin !== "null" && u.origin === ownOrigin;
  } catch {
    return true;
  }
}

/**
 * How a browser pane shows `href`:
 * - "frame": in-pane sandboxed iframe (http/https)
 * - "window": file: URLs (Chromium refuses file: frames inside an http page) — pop-out window
 * - "blocked": the app's own origin
 * - "invalid": not an allowed URL
 */
export type FrameMode = "frame" | "window" | "blocked" | "invalid";

export function frameMode(href: string | null | undefined, ownOrigin: string): FrameMode {
  const v = href ? validateUrl(href) : null;
  if (!v) return "invalid";
  if (isAppOrigin(v, ownOrigin)) return "blocked";
  return v.startsWith("file:") ? "window" : "frame";
}

/** Port of a local dev-server URL (default 80/443 applied), else null. */
export function localPortOf(href: string | null | undefined): number | null {
  if (!href || !isLocalDevUrl(href)) return null;
  try {
    const u = new URL(href);
    return u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

export function urlForPort(port: number): string {
  return `http://localhost:${port}/`;
}

/** Compact display: drop "http://" and a lone trailing slash. */
export function displayUrl(href: string | null | undefined): string {
  if (!href) return "";
  return href.replace(/^https?:\/\//, "").replace(/^([^/]+)\/$/, "$1");
}
