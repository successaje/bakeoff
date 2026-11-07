/** A small line-icon set, drawn on a 24px grid with a 1.6px stroke. */

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export const ArrowRight = (p: IconProps) => <Icon {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Icon>;
export const ArrowUpRight = (p: IconProps) => <Icon {...p}><path d="M7 17 17 7M8 7h9v9" /></Icon>;
export const Sun = (p: IconProps) => <Icon {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Icon>;
export const Moon = (p: IconProps) => <Icon {...p}><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" /></Icon>;
export const Monitor = (p: IconProps) => <Icon {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Icon>;
export const Menu = (p: IconProps) => <Icon {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Icon>;
export const Close = (p: IconProps) => <Icon {...p}><path d="M6 6l12 12M18 6 6 18" /></Icon>;
export const Copy = (p: IconProps) => <Icon {...p}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></Icon>;
export const Check = (p: IconProps) => <Icon {...p}><path d="m5 12.5 4.5 4.5L19 7.5" /></Icon>;
export const Shield = (p: IconProps) => <Icon {...p}><path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3z" /><path d="m9 12 2 2 4-4" /></Icon>;
export const Lock = (p: IconProps) => <Icon {...p}><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /></Icon>;
export const Cube = (p: IconProps) => <Icon {...p}><path d="M12 2.8 20 7.3v9.4l-8 4.5-8-4.5V7.3l8-4.5z" /><path d="M4 7.3l8 4.5 8-4.5M12 11.8v9.4" /></Icon>;
export const Coins = (p: IconProps) => <Icon {...p}><ellipse cx="9" cy="7" rx="5.5" ry="2.5" /><path d="M3.5 7v4c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V7" /><path d="M9.5 16.4c.9.1 1.9.1 2.8 0 2.9-.3 5.2-1.4 5.2-2.7v-2.4" /><path d="M14.5 11.5c1.9.3 3.8 1.2 4 2.2v4c0 1.4-2.5 2.5-5.5 2.5-2.1 0-3.9-.5-4.8-1.3" /></Icon>;
export const Bot = (p: IconProps) => <Icon {...p}><rect x="4" y="8" width="16" height="11" rx="3" /><path d="M12 4v4M9 13h.01M15 13h.01M9.5 16h5" /></Icon>;
export const Building = (p: IconProps) => <Icon {...p}><path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16M15 9h4a1 1 0 0 1 1 1v11M3 21h18M8 8h3M8 12h3M8 16h3" /></Icon>;
export const Timer = (p: IconProps) => <Icon {...p}><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2.5M9.5 2.5h5" /></Icon>;
export const External = (p: IconProps) => <Icon {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></Icon>;
export const Chevron = (p: IconProps) => <Icon {...p}><path d="m6 9 6 6 6-6" /></Icon>;
export const Wallet = (p: IconProps) => <Icon {...p}><path d="M19 7V5.5A1.5 1.5 0 0 0 17.5 4h-12A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" /><path d="M20 9h-5a3 3 0 0 0 0 6h5a1 1 0 0 0 1-1v-4a1 1 0 0 0-1-1z" /></Icon>;
export const LogOut = (p: IconProps) => <Icon {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11" /></Icon>;
export const Hash = (p: IconProps) => <Icon {...p}><path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16" /></Icon>;
export const Gauge = (p: IconProps) => <Icon {...p}><path d="M4.5 17a8.5 8.5 0 1 1 15 0" /><path d="m12 13 4-4" /></Icon>;
export const Github = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}>
    <path d="M12 2C6.5 2 2 6.6 2 12.2c0 4.5 2.9 8.3 6.8 9.7.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.4-3.4-1.4-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1.1 1.5 1.1.9 1.6 2.4 1.1 2.9.8.1-.7.4-1.1.6-1.4-2.2-.3-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.8 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.8-1 2.8-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.9-2.3 4.7-4.6 5 .4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5 4-1.4 6.8-5.2 6.8-9.7C22 6.6 17.5 2 12 2z" />
  </svg>
);

/** The Bakeoff mark: a bar, and an arc that clears it and lands. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="9" fill="var(--text)" />
      <path d="M7 21.5h18" stroke="var(--bg)" strokeWidth="2.2" strokeLinecap="round" opacity="0.55" />
      <path d="M8.5 21c2.2-9.5 12.8-9.5 15 0" fill="none" stroke="var(--bg)" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="23.5" cy="21" r="2.6" fill="var(--accent)" />
    </svg>
  );
}
