export type SteerMode = "local" | "remote";

const KEY = "10x.steer-mode";

/**
 * Stored-or-default, with no third state: unlike `useTheme`, there is no OS preference to
 * consult, so there is nothing to keep following after the first read and nothing to subscribe
 * to. Nothing stored means the plain default, "local".
 */
export function initialSteerMode(): SteerMode {
  const stored = localStorage.getItem(KEY);
  if (stored === "local" || stored === "remote") return stored;
  return "local";
}

export function storeSteerMode(mode: SteerMode): void {
  localStorage.setItem(KEY, mode);
}

// Vite inlines VITE_-prefixed variables at build time, which is correct here because the board
// is built on the same machine that runs Herdr.
export const REMOTE_TARGET = import.meta.env.VITE_HERDR_REMOTE_TARGET ?? "";

// The flag form is `herdr --remote <ssh-target>`, verified against `herdr --help` — a top-level
// flag on the binary, not a subcommand (`herdr remote <target>` does not exist).
export const remoteCommand = () => `herdr --remote ${REMOTE_TARGET}`;
