// Mission Control icon: a lead node fanning out to three lanes.

export const IconMission = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5.5" y="1.5" width="5" height="3.5" rx="0.8" />
    <path d="M8 5v2M3 9V7.5h10V9M8 7v2" />
    <rect x="1" y="9.5" width="4" height="4.5" rx="0.8" />
    <rect x="6" y="9.5" width="4" height="4.5" rx="0.8" />
    <rect x="11" y="9.5" width="4" height="4.5" rx="0.8" />
  </svg>
);
