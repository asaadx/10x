/**
 * Pure functions for project identity: the slug rule and its derivation from a repo name.
 *
 * Everything that interpreted Herdr's lifecycle (agent names, event normalisation, readiness)
 * went with Herdr; what is left is the part that shapes ids stored in the database, which is
 * why it stays pure and directly testable.
 */
/**
 * Project slugs are the first half of every ticket id (`<slug>-<number>`), and a ticket id
 * ends up in a branch name (`claude/10x-<id>`), a directory name (the Preview checkout) and a
 * SQL literal an agent types by hand. So the rule is deliberately tight: lowercase letters,
 * digits and `-`, at most 20 characters.
 *
 * The limit and the character set predate cloud sessions — they were set by Herdr's agent-name
 * rules — and are kept rather than relaxed because every existing project id already satisfies
 * them, and loosening a rule is free later while tightening one strands existing rows.
 *
 * A LEADING DIGIT IS ALLOWED: `10x`, this project's own name, must be a valid slug.
 * Dots and underscores are excluded to keep `-` the one separator, so an id never needs quoting.
 */
export const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;

export function validateProjectSlug(slug: string): { ok: true } | { ok: false; message: string } {
  if (!PROJECT_SLUG_RE.test(slug)) {
    return {
      ok: false,
      message:
        "must be 1-20 chars, start with a lowercase letter or digit, and contain only " +
        "a-z, 0-9 or '-'",
    };
  }
  return { ok: true };
}

/** The character ceiling `PROJECT_SLUG_RE` enforces, named so the derivation can do arithmetic on it. */
const PROJECT_SLUG_MAX = 20;

/**
 * A default slug for a repository name. Only a suggestion: the user edits it in the dialog
 * before it is frozen into every branch and agent name the project will ever create, and the
 * caller still runs it through `validateProjectSlug`.
 *
 * AN OVER-LONG NAME LOSES WHOLE WORDS, NOT CHARACTERS. Slicing `hearth-home-automation` at
 * the cap gives `hearth-home-automati`, which reads like a typo — so the user hand-corrects
 * it on every single project, which defeats deriving it at all. `hearth-home` is a name
 * somebody would have picked themselves. Cutting at the last separator inside the budget is
 * the same thing as dropping trailing words until it fits: a word boundary *is* a separator
 * position, so the longest prefix of whole words that fits ends at the last one of those.
 *
 * No separator in the budget means the first word alone overruns it and there is nothing to
 * cut on, so that case takes the hard slice — which cannot land on a `-`, because having no
 * separator in the first `PROJECT_SLUG_MAX` characters is exactly the condition that got here.
 *
 * A name with no `[a-z0-9]` in it at all (`...`, `!!`) derives the empty string rather than a
 * placeholder. There is nothing to derive from, and an empty field the user must fill is
 * clearer than a plausible-looking name they have to notice is wrong; `validateProjectSlug`
 * rejects it either way.
 */
export function deriveProjectSlug(repoName: string): string {
  const full = repoName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (full.length <= PROJECT_SLUG_MAX) return full;

  const boundary = full.lastIndexOf("-", PROJECT_SLUG_MAX);
  return boundary > 0 ? full.slice(0, boundary) : full.slice(0, PROJECT_SLUG_MAX);
}
