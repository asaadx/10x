/**
 * Reconciliation read model (memory/herdr-omp-lifecycle.md memory/reconciliation.md).
 *
 * Herdr owns worktrees, panes and agents; our store only remembers what we chose. A Herdr
 * restart, a backend crash or the user closing a tab all diverge the two behind our back,
 * so the board reads reality on every render instead of trusting the store.
 *
 * **This file reports. It never deletes.** Removing a worktree can destroy uncommitted work
 * and is unrecoverable, so it is only ever an explicit user action (memory/teardown.md rows 1-4). Hence no
 * `worktree.remove`, no `force: true` and no branch deletion appears here, and none may be
 * added. `reconcileTickets` returns findings only — the caller decides what to act on.
 */
import { request } from "./herdr.ts";
import { agentNameFor, branchFor } from "./lifecycle.ts";
import type { Ticket } from "./db.ts";

/** Ticket branches are namespaced, and that namespace is the whole ownership test (memory/reconciliation.md). */
const TICKET_BRANCH_PREFIX = "ticket/";

/**
 * A `worktree.list` row. Optionality mirrors Herdr's schema exactly (`WorktreeInfo`):
 * `branch` and `open_workspace_id` are absent for a detached or bare checkout.
 */
export type WorktreeEntry = {
  path: string;
  label: string;
  branch?: string | null;
  is_linked_worktree: boolean;
  is_prunable: boolean;
  open_workspace_id?: string | null;
};

/** A ticket-namespaced worktree no live ticket claims. Reported, never reclaimed. */
export type Orphan = { branch: string; path: string };

export type Divergence = {
  ticketId: string;
  ticketStatus: string;
  reality: "agent_alive" | "worktree_no_agent" | "nothing";
  note: string;
};

/** An `agent.list` row, narrowed to the fields this module reads (`AgentInfo`). */
type AgentEntry = {
  name?: string | null;
  agent_status: string;
  pane_id: string;
  workspace_id: string;
};

/**
 * Wraps `worktree.list`. A Herdr that is down, restarting or slow must degrade the board to
 * "we don't know", never break it — every caller here is a page render.
 */
export async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
  try {
    const result = await request<{ worktrees?: WorktreeEntry[] }>("worktree.list", {
      cwd: repoPath,
    });
    return result.worktrees ?? [];
  } catch (err) {
    console.warn(`reconcile: worktree.list failed for ${repoPath}:`, err);
    return [];
  }
}

/** Wraps `agent.list`, which is session-wide and takes no params. Same degradation rule. */
async function listAgents(): Promise<AgentEntry[]> {
  try {
    const result = await request<{ agents?: AgentEntry[] }>("agent.list", {});
    return result.agents ?? [];
  } catch (err) {
    console.warn("reconcile: agent.list failed:", err);
    return [];
  }
}

/**
 * Linked worktrees on a `ticket/` branch that no ticket claims.
 *
 * Two exclusions decide membership, and both are structural rather than heuristic (memory/reconciliation.md):
 * a non-`ticket/` branch is a human's worktree and never enters the candidate set at all,
 * and `is_linked_worktree: false` is the repo's implicit source workspace (memory/reconciliation.md), which is
 * shared and must never be touched.
 */
export async function findOrphans(
  repoPath: string,
  claimedBranches: Set<string>,
): Promise<Orphan[]> {
  const orphans: Orphan[] = [];
  for (const entry of await listWorktrees(repoPath)) {
    if (entry.is_linked_worktree === false) continue;
    const branch = entry.branch;
    if (typeof branch !== "string") continue;
    if (!branch.startsWith(TICKET_BRANCH_PREFIX)) continue;
    if (claimedBranches.has(branch)) continue;
    orphans.push({ branch, path: entry.path });
  }
  return orphans;
}

/**
 * Compares every ticket the store believes is `in_progress` against Herdr, and returns the
 * memory/reconciliation.md divergence rows. Matching is by **branch and agent name**, never by path — a worktree
 * path is derived from the branch by a lowercasing slug rule, so a predicted path never
 * reliably matches the real one (memory/naming.md).
 *
 * Purely observational: no database write, no Herdr mutation. Row 3 of the memory/reconciliation.md table
 * ("nothing exists" -> reset to backlog) is the caller's decision, not ours.
 */
export async function reconcileTickets(
  tickets: readonly Ticket[],
  repoPath: string,
): Promise<Divergence[]> {
  const claimed = tickets.filter((t) => t.status === "in_progress");
  if (claimed.length === 0) return [];

  const [worktrees, agents] = await Promise.all([listWorktrees(repoPath), listAgents()]);

  const worktreeByBranch = new Map<string, WorktreeEntry>();
  for (const entry of worktrees) {
    if (entry.is_linked_worktree === false) continue;
    if (typeof entry.branch === "string") worktreeByBranch.set(entry.branch, entry);
  }

  const agentByName = new Map<string, AgentEntry>();
  for (const agent of agents) {
    if (typeof agent.name === "string" && agent.name.length > 0) agentByName.set(agent.name, agent);
  }

  return claimed.map((ticket) => {
    // Persisted values win over recomputed ones: a ticket created under an older naming
    // scheme still points at the branch and agent that actually exist (db.ts rule 1).
    const branch = ticket.branch ?? branchFor(ticket.projectId, ticket.number);
    const agentName = ticket.agentName ?? agentNameFor(ticket.projectId, ticket.number);
    const agent = agentByName.get(agentName);
    const worktree = worktreeByBranch.get(branch);

    if (agent) {
      const missing = worktree ? "" : `; no worktree on ${branch} — inspect before acting`;
      return {
        ticketId: ticket.id,
        ticketStatus: ticket.status,
        reality: "agent_alive",
        note: `agent ${agentName} is ${agent.agent_status} on pane ${agent.pane_id} (workspace ${agent.workspace_id})${missing}`,
      };
    }

    if (worktree) {
      // The genuinely ambiguous row: an absent agent cannot distinguish "finished while the
      // backend was down" from "crashed", so it is surfaced rather than guessed at (memory/reconciliation.md).
      return {
        ticketId: ticket.id,
        ticketStatus: ticket.status,
        reality: "worktree_no_agent",
        note: `worktree on ${branch} at ${worktree.path} has no agent ${agentName} — needs attention, a human decides`,
      };
    }

    return {
      ticketId: ticket.id,
      ticketStatus: ticket.status,
      reality: "nothing",
      note: `neither a worktree on ${branch} nor an agent ${agentName} exists — status is false, nothing to destroy`,
    };
  });
}
