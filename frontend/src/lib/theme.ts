export type Theme = "light" | "dark";

const KEY = "10x.theme";

/**
 * The stored choice wins over the OS preference — the board has an explicit toggle, so an OS
 * that flips at sunset must not override a deliberate decision. No stored choice falls back to
 * the OS.
 */
export function initialTheme(): Theme {
  const stored = localStorage.getItem(KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Tailwind v4's dark variant is keyed off this class; see the `@custom-variant` in index.css. */
export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  localStorage.setItem(KEY, theme);
}
