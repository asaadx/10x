/**
 * Spawn and teardown for one ticket.
 *
 * The point of this file is the readiness guard in `startAgentAndWait`. See
 * memory/herdr-omp-lifecycle.md §1: the raw `agent.start` socket method returns
 * BEFORE the agent is usable, and the `herdr` CLI is what does the waiting
 * (strace shows agent.start x2 then agent.get x24). A socket client that trusts
 * the return value loses the prompt.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { HerdrError, request, subscribe } from "./herdr.ts";
import type { Diagnostics, Ticket } from "./tickets.ts";

const run = promisify(execFile);
const STATE_DIR = process.env.STATE_DIR ?? join(homedir(), ".10x");

/** How long a fresh pane may take to become an available shell before we give up. */
const PANE_WAIT_MS = 15_000;
/** How long the agent may take to become interactive after start. Normally ~3s. */
const READY_WAIT_MS = 60_000;

const SYSTEM_PROMPT = `You are an autonomous ticket-executing agent working inside a dedicated git worktree.

Rules:
- You are on a dedicated branch for this ticket. Do all work here.
- Implement the ticket fully, then commit with a clear message.
- Do not push. Do not merge. Do not switch or delete branches.
- Never ask clarifying questions. A question ends your turn and is indistinguishable
  from success to the system watching you. If something is ambiguous, choose the most
  reasonable interpretation, implement it, and note the assumption in the commit message.
- When finished, stop and summarise what you changed.
`;

type PaneInfo = { pane_id: string };
type WorktreeInfo = { path: string; branch: string | null };
type WorktreeCreated = {
  workspace: { workspace_id: string };
  root_pane: PaneInfo;
  worktree: WorktreeInfo;
};
type WorktreeOpened = { workspace: { workspace_id: string }; worktree: WorktreeInfo };
type AgentRecord = {
  name?: string;
  agent_status?: string;
  interactive_ready?: boolean;
  agent_session?: { value?: string };
};
type AgentEnvelope = { agent?: AgentRecord };

/**
 * Namespaced so reconciliation can tell our worktrees from a hand-made one (§5.2).
 *
 * The slashes deliberately mirror `agentNameFor`: Herdr derives the worktree directory
 * from the branch by lowercasing and replacing `/` with `-`, so `ticket/target/1` lands
 * in `ticket-target-1` — identical to the agent name. Verified against 0.8.2.
 *
 * `project` MUST NOT contain a slash, or the ref gains an extra path segment.
 */
export const branchFor = (t: Ticket) => `ticket/${t.project}/${t.number}`;
/** Must start with a letter, <=32 chars, unique across the whole Herdr session (§6.7). */
export const agentNameFor = (t: Ticket) => `ticket-${t.project}-${t.number}`;

/**
 * Mirror of the CLI's readiness loop. Returns once the agent is genuinely
 * interactive, or throws. Records what happened so the UI can show whether the
 * race fired on this run.
 */
async function startAgentAndWait(ticket: Ticket, paneId: string, diag: Diagnostics) {
  const name = agentNameFor(ticket);
  const promptFile = join(STATE_DIR, "prompts", `${ticket.project}-${ticket.number}.md`);
  await mkdir(dirname(promptFile), { recursive: true });
  await writeFile(promptFile, SYSTEM_PROMPT, "utf8");

  const started = Date.now();
  let record: AgentRecord | undefined;

  // Phase 1 — get agent.start to accept the pane at all.
  //
  // `agent_pane_busy` is the ONLY transient failure: it means the pane's shell has not
  // reached its interactive prompt yet. Every other error is a real fault (bad name,
  // missing pane, agent kind not installed) and must surface immediately rather than
  // being retried for 10 seconds — a fatal error retried is just a slower error.
  //
  // Bound by a deadline, not an attempt count, and back off so a slow shell does not
  // get hammered: 250ms doubling to a 2s ceiling.
  const startDeadline = Date.now() + PANE_WAIT_MS;
  let backoff = 250;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await request<AgentEnvelope>("agent.start", {
        name,
        kind: "omp",
        pane_id: paneId,
        timeout_ms: 60_000,
        args: ["--append-system-prompt", promptFile, "--auto-approve"],
      });
      diag.startAttempts = attempt;
      record = res.agent;
      diag.startReturnedStatus = record?.agent_status ?? null;
      diag.startReturnedReady = record?.interactive_ready ?? null;
      diag.startReturnedAfterMs = Date.now() - started;
      break;
    } catch (err) {
      const transient = err instanceof HerdrError && err.code === "agent_pane_busy";
      if (!transient) {
        diag.startAttempts = attempt;
        throw err; // e.g. agent_pane_not_found, invalid_agent_name — unrecoverable
      }
      if (Date.now() + backoff > startDeadline) {
        diag.startAttempts = attempt;
        throw new HerdrError(
          "agent_pane_busy",
          `pane ${paneId} never became an available shell within ${PANE_WAIT_MS}ms ` +
            `(${diag.paneBusyRetries} retries)`,
        );
      }
      diag.paneBusyRetries++;
      await delay(backoff);
      backoff = Math.min(backoff * 2, 2_000);
    }
  }

  // Phase 2 — agent.start returning is NOT readiness (§1). Poll until the record
  // actually reports idle + interactive_ready. 125ms mirrors the cadence the herdr
  // CLI itself uses, and the whole wait is normally ~3s, so this is short-lived.
  diag.neededReadinessPoll = !(
    record?.agent_status === "idle" && record?.interactive_ready === true
  );

  const readyDeadline = Date.now() + READY_WAIT_MS;
  while (!(record?.agent_status === "idle" && record?.interactive_ready === true)) {
    if (Date.now() > readyDeadline) {
      throw new HerdrError(
        "agent_not_ready",
        `agent ${name} never became interactive within ${READY_WAIT_MS}ms ` +
          `(last status: ${record?.agent_status ?? "unknown"})`,
      );
    }
    await delay(125);
    diag.readinessPolls++;
    try {
      const got = await request<AgentEnvelope>("agent.get", { target: name });
      record = got.agent;
    } catch (err) {
      // Expected while the agent is still registering; only worth noting if it persists.
      if (diag.readinessPolls % 20 === 0) {
        console.warn(`[${name}] agent.get still failing after ${diag.readinessPolls} polls:`, err);
      }
    }
  }

  diag.readyAfterMs = Date.now() - started;
  // Canonical location, not a diagnostic: teardown needs it and diagnostics get reset.
  ticket.sessionDir = record.agent_session?.value ? dirname(record.agent_session.value) : null;
}

export type SpawnResult = {
  workspaceId: string;
  paneId: string;
  worktreePath: string;
  branch: string;
};

/** Backlog -> In Progress. The caller must already have claimed the ticket (CAS). */
export async function spawn(
  ticket: Ticket,
  repoPath: string,
  onStatus: (status: string) => void,
  onPaneExit: () => void,
): Promise<SpawnResult> {
  const branch = branchFor(ticket);

  // 1. Worktree + branch + workspace + tab + root pane in one call. Reuse by BRANCH,
  //    never a predicted path (§6.2); create is not idempotent (§6.6), so open first.
  let workspaceId: string;
  let paneId: string;
  let worktreePath: string;
  try {
    const opened = await request<WorktreeOpened>("worktree.open", {
      cwd: repoPath,
      branch,
      focus: false,
    });
    workspaceId = opened.workspace.workspace_id;
    worktreePath = opened.worktree.path;
    const listed = await request<{ panes: PaneInfo[] }>("pane.list", {
      workspace_id: workspaceId,
    });
    const first = listed.panes[0];
    if (!first) throw new HerdrError("no_pane", `workspace ${workspaceId} has no pane`);
    paneId = first.pane_id;
  } catch (err) {
    if (!(err instanceof HerdrError) || err.code !== "worktree_not_found") throw err;
    const created = await request<WorktreeCreated>("worktree.create", {
      cwd: repoPath,
      branch,
      base: ticket.base,
      focus: false,
    });
    workspaceId = created.workspace.workspace_id;
    paneId = created.root_pane.pane_id;
    worktreePath = created.worktree.path;
  }

  // 2. Subscribe BEFORE starting the agent, or the first `working` transition is missed (§1).
  //
  // `pane.exited` and `pane.closed` are DIFFERENT events and we need both: `pane_exited`
  // fires when the process in the pane dies (agent crash, someone typing `exit`), while
  // `pane_closed` fires when the pane itself goes away (user closes the tab, or the
  // workspace is closed). Subscribing only to `pane.exited` misses a closed tab entirely.
  //
  // Event names arrive on the wire in UNDERSCORE form (`pane_agent_status_changed`),
  // even though subscription types are dotted (`pane.agent_status_changed`). Verified.
  ticket.stream?.close();
  ticket.stream = subscribe(
    [
      { type: "pane.agent_status_changed", pane_id: paneId },
      { type: "pane.exited" },
      { type: "pane.closed" },
    ],
    (event, data) => {
      if (typeof data !== "object" || data === null) return;
      if (event === "pane_agent_status_changed") {
        if ("agent_status" in data && typeof data.agent_status === "string") {
          onStatus(data.agent_status);
        }
        return;
      }
      if (event === "pane_exited" || event === "pane_closed") {
        // Both are global subscriptions, so filter to our own pane.
        if ("pane_id" in data && data.pane_id === paneId) onPaneExit();
      }
    },
  );

  // 3. Start, with the readiness guard.
  await startAgentAndWait(ticket, paneId, ticket.diagnostics);

  // 4. Prompt. `agent_not_ready` here means still registering — retry (§1).
  const text = [
    `TICKET ${ticket.project.toUpperCase()}-${ticket.number}: ${ticket.title}`,
    "",
    ticket.body,
  ].join("\n");

  for (let attempt = 1; attempt <= 40; attempt++) {
    try {
      await request("agent.prompt", { target: agentNameFor(ticket), text });
      ticket.diagnostics.promptAttempts = attempt;
      break;
    } catch (err) {
      if (err instanceof HerdrError && err.code === "agent_not_ready" && attempt < 40) {
        ticket.diagnostics.promptNotReadyRetries++;
        await delay(250);
        continue;
      }
      throw err;
    }
  }

  return { workspaceId, paneId, worktreePath, branch };
}

/**
 * Teardown. One path, resolved by branch, so it works whether the workspace is
 * open, was closed behind our back, or is already gone (§5).
 *
 * `force: true` is correct here because this only ever runs for an explicit user
 * action. Reconciliation must never call this.
 */
export async function teardown(ticket: Ticket, repoPath: string, deleteBranch: boolean) {
  ticket.stream?.close();
  ticket.stream = undefined;

  const branch = branchFor(ticket);
  const name = agentNameFor(ticket);

  // Resolve the session directory BEFORE killing the pane, while the agent can still
  // be asked. `ticket.sessionDir` is a fallback for when the agent is already gone
  // (crash, Herdr restart, backend restart). Never derive the path — the slug is a
  // mangled form of the worktree path and is not ours to reconstruct (§5.3).
  let sessionDir = ticket.sessionDir;
  try {
    const live = await request<AgentEnvelope>("agent.get", { target: name });
    const value = live.agent?.agent_session?.value;
    if (value) sessionDir = dirname(value);
  } catch (err) {
    if (!sessionDir) {
      console.warn(
        `[${name}] no session directory known and agent is gone; ` +
          `its OMP transcript will be left behind:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  try {
    const opened = await request<WorktreeOpened>("worktree.open", {
      cwd: repoPath,
      branch,
      focus: false,
    });
    await request("worktree.remove", { workspace_id: opened.workspace.workspace_id, force: true });
  } catch (err) {
    // worktree_not_found => nothing on disk, already clean.
    if (!(err instanceof HerdrError) || err.code !== "worktree_not_found") throw err;
  }

  // The OMP transcript lives outside the worktree and survives removal (§5.3).
  if (sessionDir) {
    await rm(sessionDir, { recursive: true, force: true });
    ticket.sessionDir = null;
  }

  if (deleteBranch) {
    try {
      await run("git", ["-C", repoPath, "branch", "-D", branch]);
    } catch (err) {
      // Expected when the branch was never created or already removed. Anything else
      // means the branch is still there, so say so rather than swallowing it.
      const message = err instanceof Error ? err.message : String(err);
      if (!/not found|no branch|nomatch/i.test(message)) {
        console.warn(`[${name}] could not delete branch ${branch}: ${message}`);
      }
    }
  }
}
