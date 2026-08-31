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
};
