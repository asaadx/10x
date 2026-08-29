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
const STATE_DIR = join(homedir(), ".10x");

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

/** Namespaced so reconciliation can tell our worktrees from a hand-made one (§5.2). */
export const branchFor = (t: Ticket) => `tkt/${t.project}-${t.number}`;
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

  // Phase 1 — get agent.start to accept the pane at all. `agent_pane_busy` means the
  // pane's shell has not reached its prompt yet: retry, never fail the ticket.
  for (let attempt = 1; attempt <= 100; attempt++) {
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
      if (err instanceof HerdrError && err.code === "agent_pane_busy") {
        diag.paneBusyRetries++;
        await delay(100);
        continue;
      }
      throw err;
    }
  }
  if (!record) throw new HerdrError("agent_start_failed", "pane never became available");

  // Phase 2 — agent.start returning is NOT readiness. Poll until the record actually
  // reports idle + interactive_ready, exactly as the CLI does.
  diag.neededReadinessPoll = !(
    record.agent_status === "idle" && record.interactive_ready === true
  );

  const deadline = Date.now() + 60_000;
  while (!(record?.agent_status === "idle" && record?.interactive_ready === true)) {
    if (Date.now() > deadline) {
      throw new HerdrError("agent_not_ready", `agent ${name} never became interactive`);
    }
    await delay(125);
    diag.readinessPolls++;
    try {
      const got = await request<AgentEnvelope>("agent.get", { target: name });
      record = got.agent;
    } catch {
      /* agent.get can fail while the agent is still registering — keep polling */
    }
  }

  diag.readyAfterMs = Date.now() - started;
  diag.sessionDir = record.agent_session?.value ? dirname(record.agent_session.value) : null;
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
  ticket.stream?.close();
  ticket.stream = subscribe(
    [{ type: "pane.agent_status_changed", pane_id: paneId }, { type: "pane.exited" }],
    (event, data) => {
      if (typeof data !== "object" || data === null) return;
      if (event.includes("agent_status_changed")) {
        if ("agent_status" in data && typeof data.agent_status === "string") {
          onStatus(data.agent_status);
        }
      } else if (event.includes("pane_exited") || event.includes("pane.exited")) {
        if ("pane_id" in data && data.pane_id === paneId) onStatus("pane_exited");
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

  // The OMP session transcript lives outside the worktree and survives removal (§5.3).
  if (ticket.diagnostics.sessionDir) {
    await rm(ticket.diagnostics.sessionDir, { recursive: true, force: true });
  }

  if (deleteBranch) {
    try {
      await run("git", ["-C", repoPath, "branch", "-D", branch]);
    } catch {
      /* branch may not exist, or may hold no commits — not an error here */
    }
  }
}
