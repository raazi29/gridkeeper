# Phone alerts through ntfy: research notes (2026-10-19)

Legend: VERIFIED = confirmed in the official ntfy documentation (URL given) or on this machine. HYPOTHESIS = from
secondary sources or memory, not confirmed. Implementation: `src-tauri/src/phone.rs`, `src/lib/phoneAlerts.ts`,
`src/components/settings/PhoneAlerts.tsx`, ADR-020.

## 1. Why ntfy

- Open source (Apache 2.0 / GPLv2), self-hostable single binary, a free public server at https://ntfy.sh, Android
  (Google Play, F-Droid) and iOS apps. Publishing is one HTTP request with no account and no SDK, so the system
  curl that Gridkeeper already uses for the browser-pane probe and the Skills panel is enough: no new crate, no new
  npm package.
- The user picks the server. Nothing in Gridkeeper is tied to ntfy.sh beyond the default value of a text field.

## 2. Publish API (VERIFIED: https://docs.ntfy.sh/publish/)

- `PUT` or `POST` the message body to `<server>/<topic>`; title, priority, tags and so on go in headers:
  `X-Title` (aliases `Title`, `ti`, `t`), `X-Priority` (`Priority`, `prio`, `p`), `X-Tags` (`Tags`, `tag`, `ta`,
  comma separated, emoji short codes such as `warning` render as icons), `X-Click` (`Click`, a URL opened on tap),
  `X-Actions` (`Actions`, up to three action buttons, `view, <label>, <url>[, clear=true]`), `X-Markdown`.
- **JSON publishing:** `POST` a JSON object to the server root with the topic inside:
  `{"topic": "...", "title": "...", "message": "...", "priority": 4, "tags": ["warning"]}`. **Gridkeeper uses this
  form:** the whole message is UTF-8 in the body, so non-ASCII pane names never have to be squeezed into HTTP
  headers, and the body reaches curl on stdin, never on a command line.
- Priorities: 1 `min`, 2 `low`, 3 `default`, 4 `high`, 5 `max`/`urgent`. Gridkeeper: needs input / error / lead
  proposal 4, mission done / finished 3; the user sets a minimum.
- Limits: a message body over 4,096 bytes becomes an attachment; titles are limited to 1 KB and all tags together to
  512 bytes (larger requests are rejected with HTTP 400). Gridkeeper caps the title at 120 and the message at 240
  characters.
- `X-Cache: no` stops the server from keeping the message (default: 12 hours), and `X-Firebase: no` stops ntfy.sh
  forwarding it to Firebase. **Not used:** the iOS app polls the server for the message after an APNs wake-up, so a
  message that is not cached never shows on iPhones, and without Firebase the Android Play build may deliver up to
  15 minutes late. The text is generic precisely because of this (section 5).

## 3. Authentication (VERIFIED: https://docs.ntfy.sh/publish/ "Authentication", https://docs.ntfy.sh/config/)

- Access token: `Authorization: Bearer tk_...`. Tokens start with `tk_` and are 32 characters long; at most 60 per
  user (`ntfy token add <user>`).
- Basic auth (`Authorization: Basic base64(user:password)`); an empty user name with a token as password also works;
  `?auth=` query parameter (the whole header value, raw base64) for clients that cannot set headers.
- The docs warn that base64 is not encryption and that self-hosted servers should use HTTPS.
- Server side, `auth-default-access` can be `read-write` (default), `read-only`, `write-only` or `deny-all`; private
  instances are recommended to use `deny-all` plus users / tokens.
- Gridkeeper supports the access token only (validated `^tk_[A-Za-z0-9]{8,64}$`), sent as a Bearer header through
  the curl config on stdin, never over plain http to a public host (http is refused except for local-network hosts).

## 4. Rate limits

- VERIFIED (https://docs.ntfy.sh/config/, defaults of a self-hosted server): `visitor-request-limit-burst` 60,
  `visitor-request-limit-replenish` one request per 5 s; e-mail 16 then one per hour; 30 open subscriptions per
  visitor. A visitor is an IP address (`behind-proxy` uses `X-Forwarded-For`).
- VERIFIED (https://docs.ntfy.sh/publish/ "Limitations"): on ntfy.sh free use is capped at **250 messages per
  visitor per day**, 5 e-mails per day, 200 MB of daily bandwidth, 2 MB attachments; repeated abuse can lead to a
  temporary IP ban (https://am-i-banned.ntfy.sh).
- HYPOTHESIS (secondary sources, a GitHub issue log line): an exceeded limit answers **HTTP 429** with a JSON body
  `{"code":42901,"http":429,"error":"limit reached: too many requests ..."}`.
- Gridkeeper's own limits stay far below that: one alert per pane (or project folder) per 2 minutes, at most 10 per
  rolling hour (≤ 240 per day even if every hour hits the cap), suppressed alerts counted into the next one
  ("+3 more since the last alert"). A failed request pauses sending for one minute, an HTTP 429 for ten minutes.
  Nothing is ever retried, so a broken network can never turn into a request storm.

## 5. Topic naming and secrecy

- VERIFIED (https://docs.ntfy.sh/publish/): topic names are `[-_A-Za-z0-9]{1,64}`. "The topic is essentially a
  password", so pick something not easily guessable; on a public server anyone who knows the topic can subscribe to
  it and read every message (and publish to it).
- VERIFIED (https://docs.ntfy.sh/config/ `upstream-base-url`): a self-hosted server forwards poll requests to an
  upstream (default ntfy.sh) so the iOS app gets instant notifications. HYPOTHESIS: the upstream only receives a
  poll request identified by a hash of the topic URL; the message itself stays on the self-hosted server.
- Messages are **not end-to-end encrypted** (HYPOTHESIS: E2E encryption is a long-standing open feature request
  upstream). They pass through the ntfy server and, for ntfy.sh, Firebase / APNs, and are cached for 12 hours.
- Gridkeeper therefore: generates `gk-` + 24 random base62 characters (≈ 143 bits, from the OS random source via
  uuid v4); warns about short or dictionary-like topics; recommends a self-hosted server or an access token; keeps
  the topic out of `workspaces.json`, diagnostics bundles and logs; hides the QR code until asked; and sends only
  generic text ("builder-1 needs you · OAuth demo", "Mission done (8/8)"), with names behind a switch and task names
  / the mission goal behind a second switch that is off by default. Everything is re-scrubbed in Rust (paths, URLs,
  e-mail addresses, `redact.rs`).

## 6. Subscribing on the phone (VERIFIED: https://docs.ntfy.sh/subscribe/phone/)

- Install the app, add the topic (and the server, for a self-hosted one).
- `ntfy://<host>/<topic>` deep links subscribe directly in the Android app ("Subscribes to the topic if not already
  subscribed"); `?secure=false` for an http server. Android deep linking of http(s) links is "very brittle", so a web
  link (`https://ntfy.sh/<topic>`) opens the ntfy web app in the browser instead. The settings page offers both as a
  QR code.
- The QR code is drawn offline by `src/lib/qrcode.ts` (byte mode, ECC M, versions 1-40, mask by penalty score; no
  dependency). VERIFIED locally: matrices for 9 inputs (versions 1 to 23, UTF-8 text, ntfy:// and http links)
  decoded back to the exact input with OpenCV's `QRCodeDetector`; unit tests pin the standard's capacity tables,
  the format bits and the Reed-Solomon worked example (HELLO WORLD, 1-M).
- Android Play build: instant delivery for ntfy.sh through Firebase; for other servers the app keeps a connection
  (foreground service). F-Droid build: always instant, no Firebase.

## 7. Token storage options considered

| Option | Verdict |
|---|---|
| `keyring` crate | Rejected for now: a new dependency tree; on Linux it pulls in the Secret Service over D-Bus (system libraries in CI, a running keyring daemon at runtime). |
| Windows Credential Manager via `CredWriteW` / `CredReadW` | **Chosen on Windows.** One extra feature (`Win32_Security_Credentials`) on the `windows-sys` crate the app already uses; per-user, protected by DPAPI, visible to the user in Control Panel › Credential Manager as `Gridkeeper/phone-alerts/ntfy-token`. |
| macOS `security` CLI / Linux `secret-tool` | Not yet: `security add-generic-password -w <secret>` puts the secret on a command line; `secret-tool` needs a running Secret Service. Candidates for a follow-up. |
| A file next to the settings | **macOS / Linux for now:** `phone-alerts.token`, mode 0600, never inside `workspaces.json`. The UI says it is not the keychain. |
| `workspaces.json` | Rejected: it is copied into diagnostics bundles (settings section) and is the file users share when reporting bugs. |

## 8. Delivery details

- `curl -q -sS -i --max-redirs 0 --connect-timeout 6 --max-time 12 --proto =https -K -` (`=http,https` only for a
  local-network http server). `-q` first (ignore `.curlrc`); `-K -` reads a config from stdin with `url`, `header`
  (Content-Type, User-Agent, Authorization) and `data-raw` (never `@file`). Values are double-quoted with curl's
  escapes; tests parse the config back and prove no extra lines can be injected by a title, message or URL.
- No redirects: a redirect could carry the Authorization header to another host.
- The response is parsed with the same `parse_curl_output` as the Skills panel; 2xx = delivered; 401 / 403, 413, 429
  and 5xx get specific messages; the server's `error` field is sanitized and appended.
- Windows ships `curl.exe` in System32 since Windows 10 1803; macOS has `/usr/bin/curl`; Linux distributions almost
  always do (falls back to PATH).
