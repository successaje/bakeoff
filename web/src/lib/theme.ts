/** Light, dark, or the system's choice; stored per browser. */

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "bakeoff:theme";

export function storedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

/**
 * Applies a theme; `crossfade` animates the change where the browser supports
 * view transitions. The colours themselves never transition: a transition that
 * stalls (in a page the browser is not painting) would leave text inheriting
 * the old theme's colour, unreadable on the new one's surfaces.
 */
export function applyTheme(choice: ThemeChoice, crossfade = false): void {
  const root = document.documentElement;
  const set = () => {
    if (choice === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", choice);
    window.dispatchEvent(new Event("bakeoff:theme"));
  };
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // The choice still applies for this visit.
  }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!crossfade || reduced || !("startViewTransition" in document)) {
    set();
    return;
  }
  // The transition runs `set` on its first frame. A page the browser is not
  // painting may not get one soon, so skip the animation (which still runs
  // `set`) rather than leave the old theme in place.
  const transition = document.startViewTransition(set);
  setTimeout(() => transition.skipTransition(), 300);
}

/** The theme in effect, resolving "system". */
export function effectiveTheme(): "light" | "dark" {
  const set = document.documentElement.getAttribute("data-theme");
  if (set === "light" || set === "dark") return set;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
