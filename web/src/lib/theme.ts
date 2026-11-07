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

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", choice);
  try {
    if (choice === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // The choice still applies for this visit.
  }
  window.dispatchEvent(new Event("bakeoff:theme"));
}

/** The theme in effect, resolving "system". */
export function effectiveTheme(): "light" | "dark" {
  const set = document.documentElement.getAttribute("data-theme");
  if (set === "light" || set === "dark") return set;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
