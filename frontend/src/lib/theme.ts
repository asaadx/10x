import { useEffect, useState, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const KEY = "10x.theme";
const DARK = "(prefers-color-scheme: dark)";

/** The recorded decision, or null while the user has never touched the toggle. */
function storedChoice(): Theme | null {
  const stored = localStorage.getItem(KEY);
  return stored === "light" || stored === "dark" ? stored : null;
}

function osTheme(): Theme {
  return window.matchMedia(DARK).matches ? "dark" : "light";
}

function subscribeToOs(onChange: () => void): () => void {
  const query = window.matchMedia(DARK);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Swapped in once a choice is stored, which unsubscribes the listener above. */
function ignoreOs(): () => void {
  return () => {};
}

/**
 * The stored choice wins over the OS preference — the board has an explicit toggle, so an OS
 * that flips at sunset must not override a deliberate decision. With no stored choice the board
 * follows the OS for as long as that stays true, not just for the first render: it is subscribed
 * to `prefers-color-scheme`, so changing the system theme repaints the board without a reload.
 *
 * What keeps the two apart is that `toggleTheme` is the only writer. Mounting writes nothing, so
 * a value merely inferred from the OS never becomes a recorded decision, and the subscription
 * lives exactly as long as there is no such decision to respect.
 */
export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [choice, setChoice] = useState<Theme | null>(storedChoice);
  // Read through the store rather than into state, so the OS cannot flip in the gap between an
  // initial read and a later subscribe.
  const os = useSyncExternalStore(choice === null ? subscribeToOs : ignoreOs, osTheme);
  const theme = choice ?? os;

  // Tailwind v4's dark variant is keyed off this class; see the `@custom-variant` in index.css.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  return {
    theme,
    toggleTheme: () => {
      const next: Theme = theme === "dark" ? "light" : "dark";
      localStorage.setItem(KEY, next);
      setChoice(next);
    },
  };
}
