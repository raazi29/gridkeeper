// Team roles for sessions (Mission Control, formations, pane header tag). Pure, node-safe.
// Colours are CSS variables defined in src/styles/mission.css (--role-lead, …, --role-custom).
// Role ids (lead, builder, …) are never translated: they go into briefs, team.md and the outbox protocol. Only the
// display label and hint are (getters over the message catalog, so they follow the UI language).

import { t, type MessageKey } from "../i18n";

export const BUILTIN_ROLES = ["lead", "scout", "builder", "reviewer", "verifier"] as const;
export type BuiltinRole = (typeof BUILTIN_ROLES)[number];

export const ROLE_MAX_LEN = 24;

export interface RoleInfo {
  id: string;
  /** Display name in the current UI language (custom roles: the id). */
  readonly label: string;
  glyph: string;
  /** CSS colour expression, e.g. "var(--role-lead)". */
  color: string;
  builtin: boolean;
  /** One-line description in the current UI language. */
  readonly hint: string;
}

const INFO: Record<BuiltinRole, { glyph: string; label: MessageKey; hint: MessageKey }> = {
  lead: { glyph: "◆", label: "roles.label.lead", hint: "roles.hint.lead" },
  scout: { glyph: "◎", label: "roles.label.scout", hint: "roles.hint.scout" },
  builder: { glyph: "▲", label: "roles.label.builder", hint: "roles.hint.builder" },
  reviewer: { glyph: "◉", label: "roles.label.reviewer", hint: "roles.hint.reviewer" },
  verifier: { glyph: "✓", label: "roles.label.verifier", hint: "roles.hint.verifier" },
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
  if (isBuiltinRole(id)) {
    const info = INFO[id];
    return {
      id,
      glyph: info.glyph,
      get label() {
        return t(info.label);
      },
      get hint() {
        return t(info.hint);
      },
      color: `var(--role-${id})`,
      builtin: true,
    };
  }
  return {
    id,
    label: id,
    glyph: "●",
    get hint() {
      return t("roles.hint.custom");
    },
    color: "var(--role-custom)",
    builtin: false,
  };
}

/** Short uppercase tag, e.g. "LEAD", "BUILDER", custom ids truncated to 10 chars. */
export function roleTag(role: string | null | undefined): string {
  const info = roleInfo(role);
  if (!info) return "";
  return (info.builtin ? info.id : info.id.slice(0, 10)).toUpperCase();
}
