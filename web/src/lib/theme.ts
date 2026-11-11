/** Light, dark, or the system's choice; light unless the visitor picks another. */

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "bakeoff:theme";

export function storedTheme(): ThemeChoice {
  try {
    const value = localStorage.getItem(KEY);
    return value === "dark" || value === "system" ? value : "light";
  } catch {
    return "light";
  }
}

/**
 * Applies a theme, and remembers it when the visitor picked it; `crossfade`
 * animates the change where the browser supports view transitions. The
 * colours themselves never transition: a transition that stalls (in a page
 * the browser is not painting) would leave text inheriting the old theme's
 * colour, unreadable on the new one's surfaces.
 */
export function applyTheme(choice: ThemeChoice, picked = false): void {
  const root = document.documentElement;
  const set = () => {
    if (choice === "light") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", choice);
    window.dispatchEvent(new Event("bakeoff:theme"));
  };
  if (picked) {
    try {
      if (choice === "light") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {
      // The choice still applies for this visit.
    }
  }
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!picked || reduced || !("startViewTransition" in document)) {
    set();
    return;
  }
  // The transition runs `set` on its first frame. A page the browser is not
  // painting may not get one soon, so skip the animation (which still runs
  // `set`) rather than leave the old theme in place.
  const transition = document.startViewTransition(set);
  // A skipped transition rejects `ready`; the theme is applied either way.
  transition.ready.catch(() => undefined);
  setTimeout(() => transition.skipTransition(), 300);
}

/** The theme in effect, resolving "system". */
export function effectiveTheme(): "light" | "dark" {
  const set = document.documentElement.getAttribute("data-theme");
  if (set === "dark") return "dark";
  if (set === "system") return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return "light";
}
