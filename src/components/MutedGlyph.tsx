// Bell-with-slash glyph: shown on muted panes, the Comms bell under Do not disturb and muted feed rows.

import { useT } from "../i18n";

export const IconBellOff = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M5.2 3.6A3.6 3.6 0 0 1 11.6 6v2.6l1.2 2.2H6.9M4.4 6.9v1.7L3.2 10.8h1.6" />
    <path d="M6.6 12.6a1.5 1.5 0 0 0 2.8 0" />
    <path d="M2.5 2.5l11 11" />
  </svg>
);

export function MutedGlyph({ title }: { title?: string }) {
  const t = useT();
  title ??= t("ui.notificationsMuted");
  return (
    <span className="muted-glyph" title={title} aria-label={title} role="img">
      <IconBellOff size={11} />
    </span>
  );
}
