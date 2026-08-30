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
 * Dots are legal in git branches but NOT in agent names, so they are rejected here: a
 * slug like `my.app` would produce a valid branch and an invalid agent name, failing
 * only at spawn time after the worktree already exists.
 */
export const PROJECT_SLUG_RE = /^[a-z][a-z0-9-]{0,19}$/;

export function validateProjectSlug(slug: string): { ok: true } | { ok: false; message: string } {
  if (!PROJECT_SLUG_RE.test(slug)) {
    return {
      ok: false,
      message:
        "must be 1-20 chars, start with a lowercase letter, and contain only a-z, 0-9 or '-' " +
        "(dots are legal in branches but not in Herdr agent names)",
    };
  }
  return { ok: true };
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

/** A turn ended. Only meaningful once `working` has been observed (§4.1). */
export const isSettled = (status: string) => status === "idle" || status === "done";
