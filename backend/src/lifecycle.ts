/**
 * Pure functions for ticket identity and Herdr lifecycle interpretation.
 *
 * These live apart from runner.ts because they are the parts that have actually broken,
 * and being pure they are directly testable. Each carries the bug it exists to prevent.
 */

/** Herdr agent names must match this, and are unique across the WHOLE Herdr session. */
export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Project slugs feed both the branch and the agent name, so they are the tightest
 * constraint in the system. `ticket-` costs 7 characters and the separator 1, leaving 24
 * for slug + number — about 20 characters of slug beside a 4-digit ticket number.
 *
 * A LEADING DIGIT IS ALLOWED. Herdr agent names must start with a letter, but
 * `agentNameFor` always prefixes `ticket-`, so the letter is already guaranteed and the
 * slug itself is unconstrained in that respect. Requiring a leading letter here would
 * reject `10x` — this project's own name — for no reason. Verified: branch `ticket/10x/1`
 * passes `git check-ref-format`, `ticket-10x-7` matches Herdr's agent-name regex, and a
 * real worktree was created on that branch.
 *
 * Dots and underscores are excluded deliberately. Dots are legal in git branches but NOT
 * in agent names, so a slug like `my.app` would yield a valid branch and an invalid agent
 * name — failing only at spawn time, after the worktree already exists. Underscores are
 * legal in both but excluded to keep one canonical separator.
 */
export const PROJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,19}$/;

export function validateProjectSlug(slug: string): { ok: true } | { ok: false; message: string } {
  if (!PROJECT_SLUG_RE.test(slug)) {
    return {
      ok: false,
      message:
        "must be 1-20 chars, start with a lowercase letter or digit, and contain only " +
        "a-z, 0-9 or '-' (dots are legal in branches but not in Herdr agent names)",
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

/**
 * Branch name. Slashes mirror `agentNameFor` on purpose: Herdr derives the worktree
 * directory from the branch by lowercasing and replacing `/` with `-`, so
 * `ticket/10x/7` lands in `ticket-10x-7`, identical to the agent name.
 */
export const branchFor = (projectId: string, number: number) => `ticket/${projectId}/${number}`;

/** Agent name. The `ticket-` prefix guarantees a leading letter for any project or number. */
export const agentNameFor = (projectId: string, number: number) => `ticket-${projectId}-${number}`;

/**
 * A planning agent's name: the ticket's agent name plus a suffix, derived from
 * `agentNameFor` rather than rebuilt so the two can never drift apart.
 *
 * THE SUFFIX IS LOAD-BEARING — do not "simplify" it away. `runner.ts` catches
 * `agent_name_taken` from `agent.start` and silently re-attaches, treating whatever it finds
 * as the implementation agent and deliberately sending it no ticket text. If a planner held
 * the plain ticket name, Start would adopt the planner and leave a ticket reading In Progress
 * with no worktree, no branch and no instruction — and no error anywhere.
 *
 * It costs 5 of the 32-character budget, so a plan name fits only while
 * `len(slug) + len(number) <= 19` — `agentNameFor` alone allows 24. `startPlanning` checks
 * the result against `AGENT_NAME_RE` rather than assuming, because the slug regex is laxer.
 */
const PLAN_SUFFIX = "-plan";

export const planAgentNameFor = (projectId: string, number: number) =>
  `${agentNameFor(projectId, number)}${PLAN_SUFFIX}`;

/**
 * Does this Herdr label name a planning agent? The sweep in `reconcile.ts` has nothing else
 * to go on: a planner has no worktree and no branch, so the branch-based identity every other
 * lookup uses cannot see it (memory/naming.md).
 *
 * Anchored on the whole shape `planAgentNameFor` produces, not just the suffix: a workspace a
 * human labelled `refactor-plan` is not ours, and the sweep closes what it matches.
 */
const PLAN_AGENT_NAME_RE = new RegExp(`^ticket-[a-z0-9][a-z0-9-]*-\\d+${PLAN_SUFFIX}$`);

export const isPlanAgentName = (label: string) => PLAN_AGENT_NAME_RE.test(label);

/**
 * Herdr's emitted event names are inconsistently separated: `pane.agent_status_changed`
 * arrives dotted while `pane_closed` arrives underscored, and the schema declares both
 * with underscores. Matching either form literally silently drops half the events — a
 * failure with no error attached, which cost this project a working status pipeline once.
 */
export const normalizeEvent = (event: string) => event.replaceAll(".", "_");

export type AgentLike = { agent_status?: string; interactive_ready?: boolean };

/**
 * `idle` and `done` are the SAME underlying ready state: `done` merely means the agent
 * settled while its tab was unseen. Accepting only `idle` hangs for the full timeout on
 * any agent that finished a turn unobserved — which is every re-attached agent.
 */
export const isAgentReady = (a: AgentLike | undefined) =>
  (a?.agent_status === "idle" || a?.agent_status === "done") && a?.interactive_ready === true;

/** A turn ended. Only meaningful once `working` has been observed (memory/agent-status.md). */
export const isSettled = (status: string) => status === "idle" || status === "done";
