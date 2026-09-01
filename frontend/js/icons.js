/**
 * Every icon the board renders, in one place.
 *
 * Swapping an icon set is meant to be edits inside this object and nothing else:
 * no call site names a glyph, and no glyph appears twice. Values are inserted as
 * HTML, so an SVG is fine and anything from outside this file is not.
 *
 * Two icons are NOT here because JS never renders them: the diagnostics
 * disclosure triangles are CSS `content`, held as `--icon-disclosure-*` in
 * styles.css for the same one-edit reason.
 */
export const icons = {
  /**
   * Ship's wheel — attach to the agent's pane and steer it. Sized by
   * `button.icon-btn svg`, coloured by `currentColor`, so it inherits the
   * button's theme rather than carrying its own.
   */
  steer: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
      <circle cx="12" cy="12" r="7.2"/>
      <circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/>
      <path d="M12 4.8V2 M12 22v-2.8 M19.2 12H22 M2 12h2.8
                M17.1 6.9l1.6-1.6 M5.3 18.7l1.6-1.6 M6.9 6.9L5.3 5.3 M18.7 18.7l-1.6-1.6"/>
    </svg>`,

  /** The turn ended after `working` was observed. */
  finished: "✓",
  /** The pane exited without the turn ever finishing — not a completion. */
  died: "✗",
  /** A worktree exists on disk for this ticket. */
  worktree: "⌂",
  /** An operation is in flight, so the card's actions are disabled. */
  busy: "⏳",

  /** PR merged — GitHub Octicon `git-merge`, 16px. See memory/frontend.md for the state model. */
  prMerged: `
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
      <path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z"/>
    </svg>`,
  /** PR closed without merging — Octicon `git-pull-request-closed`, 16px. */
  prClosed: `
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
      <path d="M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>
    </svg>`,
  /** PR open, unmerged — Octicon `git-pull-request`, 16px. */
  prOpen: `
    <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">
      <path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"/>
    </svg>`,
};
