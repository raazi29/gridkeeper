// Role tag (pane header, Mission Control cards) and a small role picker (New Session, Inspector).

import { memo, useState, type CSSProperties } from "react";
import { useT } from "../../i18n";
import { BUILTIN_ROLES, normalizeRole, roleInfo, roleTag } from "../../lib/roles";
import "../../styles/mission.css";

export const RoleTag = memo(function RoleTag({ role, bare, glyphOnly }: { role: string | null | undefined; bare?: boolean; glyphOnly?: boolean }) {
  const t = useT();
  const info = roleInfo(role);
  if (!info) return null;
  return (
    <span className={`role-tag${bare ? " is-bare" : ""}`} style={{ "--rc": info.color } as CSSProperties} title={t("roles.tagTitle", { label: info.label, hint: info.hint })}>
      <span className="role-tag-glyph" aria-hidden="true">
        {info.glyph}
      </span>
      {!glyphOnly && roleTag(role)}
    </span>
  );
});

/** CSS custom property object for a role colour (`--rc`). */
export function roleStyle(role: string | null | undefined): CSSProperties {
  return { "--rc": roleInfo(role)?.color ?? "var(--role-custom)" } as CSSProperties;
}

const CUSTOM = "__custom";

/** Select with none / built-in roles / custom text. */
export function RolePicker({ value, onChange, id }: { value: string | null; onChange: (role: string | null) => void; id?: string }) {
  const t = useT();
  const builtin = !value || (BUILTIN_ROLES as readonly string[]).includes(value);
  const [customPicked, setCustom] = useState(!builtin);
  // A custom role set elsewhere (e.g. formations) shows as custom; a built-in set elsewhere wins too.
  const custom = !builtin || (customPicked && !value);
  const [text, setText] = useState(builtin ? "" : (value ?? ""));
  return (
    <div className="role-picker">
      <select
        id={id}
        className="select"
        aria-label={t("roles.picker.aria")}
        value={custom ? CUSTOM : (value ?? "")}
        onChange={(e) => {
          const v = e.target.value;
          if (v === CUSTOM) {
            setCustom(true);
            onChange(normalizeRole(text));
          } else {
            setCustom(false);
            onChange(v || null);
          }
        }}
      >
        <option value="">{t("roles.none")}</option>
        {BUILTIN_ROLES.map((r) => {
          const info = roleInfo(r)!;
          return (
            <option key={r} value={r}>
              {t("roles.picker.option", { glyph: info.glyph, label: info.label, hint: info.hint })}
            </option>
          );
        })}
        <option value={CUSTOM}>{t("roles.picker.custom")}</option>
      </select>
      {custom && (
        <input
          className="input mono"
          value={text}
          maxLength={24}
          spellCheck={false}
          placeholder={t("roles.picker.customPlaceholder")}
          aria-label={t("roles.picker.customAria")}
          onChange={(e) => {
            setText(e.target.value);
            onChange(normalizeRole(e.target.value));
          }}
        />
      )}
    </div>
  );
}
