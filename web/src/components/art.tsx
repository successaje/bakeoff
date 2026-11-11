/**
 * Generated artwork: a cover for each challenge, and avatars for accounts and
 * hosts. Each is drawn from a hash of its name, so it is stable across visits
 * and needs no uploads. The cover reuses the mark's motif: a grid of hidden
 * tickets, a bar, and an arc that clears it and lands.
 */

/** 32-bit FNV-1a: small, fast and well spread for short strings. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A seeded generator (mulberry32), so the same seed draws the same picture. */
export function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Palette { bg: string; glow: string; tile: string; line: string; dot: string }

/** Fixed colours, like a printed cover: they read the same in light and dark. */
const PALETTES: Palette[] = [
  { bg: "#0f3d2e", glow: "#00ec97", tile: "#00ec97", line: "#f6f3ea", dot: "#ffb547" },
  { bg: "#f3e7c9", glow: "#ffb547", tile: "#d38b1c", line: "#202124", dot: "#00995f" },
  { bg: "#dce9fb", glow: "#7ab8ff", tile: "#2463c7", line: "#0c1210", dot: "#00995f" },
  { bg: "#e9e3fb", glow: "#a996ff", tile: "#6b4fd8", line: "#202124", dot: "#ffb547" },
  { bg: "#14181a", glow: "#ffb547", tile: "#ffb547", line: "#eef2f0", dot: "#00ec97" },
  { bg: "#dff3ea", glow: "#00ec97", tile: "#00995f", line: "#202124", dot: "#2463c7" },
];

export function paletteFor(name: string): Palette {
  return PALETTES[hashString(name) % PALETTES.length]!;
}

/** A challenge's cover. `lit` is the share of tickets drawn as answered right. */
export function Cover({ id, lit = 0.42, className = "" }: { id: string; lit?: number; className?: string }) {
  const random = seeded(hashString(id));
  const p = paletteFor(id);
  const key = `c${hashString(id).toString(36)}`;
  const cols = 14;
  const rows = 6;
  const size = 13;
  const gap = 6;
  const gridX = 150 + Math.round(random() * 40);
  const gridY = 22 + Math.round(random() * 14);
  const tiles = Array.from({ length: cols * rows }, (_, i) => ({ x: gridX + (i % cols) * (size + gap), y: gridY + Math.floor(i / cols) * (size + gap), on: random() < lit }));
  const from = 26 + random() * 40;
  const to = from + 130 + random() * 70;
  const barY = 168;
  const height = 70 + random() * 40;
  const glowX = 60 + random() * 280;
  return (
    <svg className={`cover ${className}`} viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <radialGradient id={`${key}-glow`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={p.glow} stopOpacity="0.55" />
          <stop offset="1" stopColor={p.glow} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="400" height="200" fill={p.bg} />
      <circle cx={glowX} cy="40" r="150" fill={`url(#${key}-glow)`} />
      {tiles.map((t, i) => (
        <rect key={i} x={t.x} y={t.y} width={size} height={size} rx="3" fill={t.on ? p.tile : "none"} stroke={p.tile} strokeOpacity={t.on ? 0 : 0.35} fillOpacity={t.on ? 0.9 : 0} />
      ))}
      <path d={`M${from - 14} ${barY + 6}H${to + 30}`} stroke={p.line} strokeWidth="5" strokeLinecap="round" opacity="0.4" />
      <path d={`M${from} ${barY}C${from + 20} ${barY - height} ${to - 20} ${barY - height} ${to} ${barY}`} fill="none" stroke={p.line} strokeWidth="6" strokeLinecap="round" />
      <circle cx={to} cy={barY} r="10" fill={p.dot} />
    </svg>
  );
}

function initials(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : words[0]!.slice(0, 2)).toUpperCase();
}

/** A NEAR account's avatar: a gradient from its name, with its first letter. */
export function Avatar({ id, size = 28, className = "" }: { id: string; size?: number; className?: string }) {
  const hue = hashString(id) % 360;
  return (
    <span
      className={`avatar ${className}`}
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), background: `linear-gradient(135deg, hsl(${hue} 70% 52%), hsl(${(hue + 48) % 360} 72% 40%))` }}
    >
      {id.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** A host's mark: their initials on a tile in their cover's colours. */
export function HostMark({ name, size = 32 }: { name: string; size?: number }) {
  const p = paletteFor(name);
  return (
    <span className="host-mark" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.36), background: p.bg, color: p.line }}>
      {initials(name)}
    </span>
  );
}
