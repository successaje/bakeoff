/** How metrics and times read on the page. */

export const percent = (bp: number | undefined) => (bp === undefined ? "–" : `${(bp / 100).toFixed(1)}%`);
export const microDollars = (uusd: number | undefined) => (uusd === undefined ? "–" : `${uusd} µ$`);
export const seconds = (ms: number | undefined) => (ms === undefined ? "–" : `${(ms / 1000).toFixed(1)} s`);
export const shortHash = (hash: string) => `${hash.slice(0, 8)}…`;

export function utc(date: Date | null): string {
  if (!date) return "–";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "2d ago", "5h ago": the short form cards and tables use. */
export function ago(date: Date | null, now = Date.now()): string {
  if (!date) return "";
  const s = Math.max(0, (now - date.getTime()) / 1000);
  if (s < 60) return "just now";
  const units: [number, string][] = [[31_536_000, "y"], [2_592_000, "mo"], [86_400, "d"], [3_600, "h"], [60, "m"]];
  const [size, unit] = units.find(([n]) => s >= n)!;
  return `${Math.floor(s / size)}${unit} ago`;
}

/** "21d to go", "5h to go", or null once the time has passed. */
export function toGo(date: Date | null, now = Date.now()): string | null {
  if (!date || date.getTime() <= now) return null;
  const s = (date.getTime() - now) / 1000;
  const units: [number, string][] = [[2_592_000, "mo"], [86_400, "d"], [3_600, "h"], [60, "m"]];
  const found = units.find(([n]) => s >= n);
  return found ? `${Math.floor(s / found[0])}${found[1]} to go` : "under a minute to go";
}

/** "in 2 days", "3 hours ago". */
export function relative(date: Date | null, now = Date.now()): string {
  if (!date) return "";
  const delta = date.getTime() - now;
  const units: [number, string][] = [[86_400_000, "day"], [3_600_000, "hour"], [60_000, "minute"]];
  for (const [ms, unit] of units) {
    const n = Math.round(Math.abs(delta) / ms);
    if (n >= 1) return delta > 0 ? `in ${n} ${unit}${n > 1 ? "s" : ""}` : `${n} ${unit}${n > 1 ? "s" : ""} ago`;
  }
  return delta > 0 ? "in under a minute" : "just now";
}
