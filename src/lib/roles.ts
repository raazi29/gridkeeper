// Team roles for sessions (Mission Control, formations, pane header tag). Pure, node-safe.
// Colours are CSS variables defined in src/styles/mission.css (--role-lead, …, --role-custom).

export const BUILTIN_ROLES = ["lead", "scout", "builder", "reviewer", "verifier"] as const;
export type BuiltinRole = (typeof BUILTIN_ROLES)[number];

export const ROLE_MAX_LEN = 24;

export interface RoleInfo {
  id: string;
  label: string;
  glyph: string;
  /** CSS colour expression, e.g. "var(--role-lead)". */
  color: string;
  builtin: boolean;
  hint: string;
}

const INFO: Record<BuiltinRole, Omit<RoleInfo, "id" | "color" | "builtin">> = {
  lead: { label: "Lead", glyph: "◆", hint: "Plans, splits work, signs off" },
  scout: { label: "Scout", glyph: "◎", hint: "Explores and reports, changes nothing" },
  builder: { label: "Builder", glyph: "▲", hint: "Implements changes" },
  reviewer: { label: "Reviewer", glyph: "◉", hint: "Reviews diffs and PRs" },
  verifier: { label: "Verifier", glyph: "✓", hint: "Runs tests, lint and checks" },
};

export function isBuiltinRole(r: string | null | undefined): r is BuiltinRole {
  return !!r && (BUILTIN_ROLES as readonly string[]).includes(r);
}

/**
 * Normalize free text into a role id: lower-case `[a-z0-9-]`, spaces/underscores become dashes,
 * at most 24 chars, leading/trailing dashes trimmed. Empty -> null. Mirrors `normalize_role` in
 * src-tauri/src/persistence.rs.
 */
export function normalizeRole(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let out = "";
  for (const ch of raw.trim().toLowerCase()) {
    if (out.length >= ROLE_MAX_LEN) break;
    if (/[a-z0-9-]/.test(ch)) out += ch;
    else if (ch === " " || ch === "_") out += "-";
  }
  out = out.replace(/^-+|-+$/g, "");
  return out || null;
}

export function roleInfo(role: string | null | undefined): RoleInfo | null {
  const id = normalizeRole(role);
  if (!id) return null;
  if (isBuiltinRole(id)) return { id, ...INFO[id], color: `var(--role-${id})`, builtin: true };
  return { id, label: id, glyph: "●", hint: "Custom role", color: "var(--role-custom)", builtin: false };
}

/** Short uppercase tag, e.g. "LEAD", "BUILDER", custom ids truncated to 10 chars. */
export function roleTag(role: string | null | undefined): string {
  const info = roleInfo(role);
  if (!info) return "";
  return (info.builtin ? info.id : info.id.slice(0, 10)).toUpperCase();
}
