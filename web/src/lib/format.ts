/** How metrics and times read on the page. */

export const percent = (bp: number | undefined) => (bp === undefined ? "–" : `${(bp / 100).toFixed(1)}%`);
export const microDollars = (uusd: number | undefined) => (uusd === undefined ? "–" : `${uusd} µ$`);
export const seconds = (ms: number | undefined) => (ms === undefined ? "–" : `${(ms / 1000).toFixed(1)} s`);
export const shortHash = (hash: string) => `${hash.slice(0, 8)}…`;

export function utc(date: Date | null): string {
  if (!date) return "–";
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
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
