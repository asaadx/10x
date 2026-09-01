/**
 * Spawn and teardown for one ticket.
 *
 * The point of this file is the readiness guard in `startAgentAndWait`. See
 * memory/herdr-omp-lifecycle.md memory/spawn.md: the raw `agent.start` socket method returns
 * BEFORE the agent is usable, and the `herdr` CLI is what does the waiting
 * (strace shows agent.start x2 then agent.get x24). A socket client that trusts
 * the return value loses the prompt.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { HerdrError, request, subscribe } from "./herdr.ts";
import { agentNameFor, branchFor, isAgentReady, normalizeEvent } from "./lifecycle.ts";
import type { Diagnostics } from "./types.ts";
import { ENV_FILE, envFileFor, type PortBlock } from "./ports.ts";

/**
 * Everything a run needs, passed explicitly so this module never touches the store.
 * `repoPath` and `base` come from the ticket's project, not the ticket.
 */
export type RunSpec = {
  projectId: string;
  number: number;
  title: string;
  description: string;
  repoPath: string;
  base: string;
};

/** Mutable per-run state the caller owns and persists. */
export type RunState = {
  diagnostics: Diagnostics;
  sessionDir: string | null;
  stream?: { close: () => void };
  // Cache of the worktree path spawn() resolved, for the dev-server reaper
  // (memory/architecture.md, port pool). NOT persisted: Herdr derives the path from the
  // branch on demand, so a restart simply forgets it and the reaper skips with a warning.
  worktreePath?: string;
};

const run = promisify(execFile);
const STATE_DIR = process.env.STATE_DIR ?? join(homedir(), ".10x");

/** How long a fresh pane may take to become an available shell before we give up. */
const PANE_WAIT_MS = 15_000;
/** How long the agent may take to become interactive after start. Normally ~3s. */
const READY_WAIT_MS = 60_000;
/** Backoff for reopening a dropped event stream. Bounded: give up loudly rather than spin. */
const STREAM_REOPEN_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const;

/**
 * `block` is interpolated because the range is per-ticket. The port rules are a CONVENTION,
 * not a sandbox: nothing stops the agent binding elsewhere, so the prompt has to say plainly
 * what the range is and that straying out of it breaks another ticket.
 */
const systemPrompt = (block: PortBlock) =>
  `You are an autonomous ticket-executing agent working inside a dedicated git worktree.

Rules:
- You are on a dedicated branch for this ticket. Do all work here.
- Implement the ticket fully, then commit with a clear message.
- Do not push. Do not merge. Do not switch or delete branches.
- Never ask clarifying questions. A question ends your turn and is indistinguishable
  from success to the system watching you. If something is ambiguous, choose the most
  reasonable interpretation, implement it, and note the assumption in the commit message.
- This worktree owns TCP ports ${block.start}-${block.end} and no others. A .env file in the
  worktree root holds PORT=${block.start} plus PORT_RANGE_START and PORT_RANGE_END; read the
  port from there rather than hardcoding one, and take further ports from inside the range if
  you need more than one service.
- Never bind a port outside ${block.start}-${block.end}. Every other port belongs to another
  ticket's agent or to the board itself, and nothing enforces this but you.
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
  pane_id?: string;
  workspace_id?: string;
};
type AgentEnvelope = { agent?: AgentRecord };


/**
 * Mirror of the CLI's readiness loop. Returns once the agent is genuinely
 * interactive, or throws. Records what happened so the UI can show whether the
 * race fired on this run.
 */
async function startAgentAndWait(
  spec: RunSpec,
  block: PortBlock,
  state: RunState,
  paneId: string,
  diag: Diagnostics,
) {
  const name = agentNameFor(spec.projectId, spec.number);
  const promptFile = join(STATE_DIR, "prompts", `${spec.projectId}-${spec.number}.md`);
  await mkdir(dirname(promptFile), { recursive: true });
  await writeFile(promptFile, systemPrompt(block), "utf8");

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
      // The agent for this ticket is already live — the usual cause is a 10x backend
      // restart, since Herdr keeps panes and agents running while our in-memory ticket
      // store resets. Reuse it: killing a working agent would throw away its context.
      if (err instanceof HerdrError && err.code === "agent_name_taken") {
        diag.startAttempts = attempt;
        diag.reusedExistingAgent = true;
        const existing = await request<AgentEnvelope>("agent.get", { target: name });
        record = existing.agent;
        diag.startReturnedStatus = record?.agent_status ?? null;
        diag.startReturnedReady = record?.interactive_ready ?? null;
        diag.startReturnedAfterMs = Date.now() - started;
        break;
      }
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

  // Phase 2 — agent.start returning is NOT readiness (memory/spawn.md). Poll until the record actually
  // reports ready. 125ms mirrors the cadence the herdr CLI itself uses, and the whole wait
  // is normally ~3s, so this is short-lived.
  //
  // `idle` and `done` are the SAME underlying ready state (memory/agent-status.md): `done` just means it
  // settled while the tab was unseen. Accepting only `idle` hangs for the full timeout on
  // any agent that finished a turn unobserved — which is every reused agent.

  diag.neededReadinessPoll = !isAgentReady(record);

  const readyDeadline = Date.now() + READY_WAIT_MS;
  while (!isAgentReady(record)) {
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

  // The loop only exits when isReady() passed, so a record exists — but express that for
  // the type system rather than asserting it.
  if (!record) throw new HerdrError("agent_not_ready", `agent ${name} disappeared while starting`);

  diag.readyAfterMs = Date.now() - started;
  // Canonical location, not a diagnostic: teardown needs it and diagnostics get reset.
  state.sessionDir = record.agent_session?.value ? dirname(record.agent_session.value) : null;

  // A reused agent may live in a different pane than the one we resolved from the
  // worktree, so report the authoritative pane back for the subscription to follow.
  return { reused: diag.reusedExistingAgent, paneId: record.pane_id ?? paneId };
}

/**
 * Put the ticket's port block in its worktree, and keep git from seeing the file.
 *
 * The worktree is a REAL git worktree that the agent commits in, so an untracked `.env`
 * showing up in `git status` is one `git add -A` away from being committed. The project's
 * tracked `.gitignore` belongs to the project and is not ours to edit, so the entry goes in
 * the exclude file instead: same effect on `git status`, nothing tracked touched.
 *
 * `rev-parse --git-path`, never `join(worktreePath, ".git", …)`. In a linked worktree `.git`
 * is a FILE, and git resolves `info/exclude` against the COMMON git directory — the source
 * repo's `.git/info/exclude`, shared by every ticket worktree of that repo. Verified: after
 * appending the entry there, `git status` inside the worktree is clean and `git check-ignore`
 * names that file. Being shared is why the append is conditional.
 */
async function injectPortBlock(worktreePath: string, block: PortBlock, ticket: string) {
  await writeFile(join(worktreePath, ENV_FILE), envFileFor(block, ticket), "utf8");

  const resolved = await run("git", [
    "-C",
    worktreePath,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/exclude",
  ]);
  const excludeFile = resolved.stdout.trim();
  // Absent on a repo cloned without the template, so create the directory rather than assume.
  await mkdir(dirname(excludeFile), { recursive: true });
  const current = await readFile(excludeFile, "utf8").catch(() => "");
  if (current.split("\n").includes(ENV_FILE)) return;
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  await writeFile(excludeFile, `${current}${separator}${ENV_FILE}\n`, "utf8");
}

export type SpawnResult = {
  workspaceId: string;
  paneId: string;
  worktreePath: string;
  branch: string;
};

/**
 * Backlog -> In Progress. The caller must already have claimed the ticket (CAS) and reserved
 * `block`: the port has to exist before the agent starts, because it is written into the
 * worktree the agent boots in.
 */
export async function spawn(
  spec: RunSpec,
  block: PortBlock,
  state: RunState,
  onStatus: (status: string) => void,
  onPaneExit: () => void,
): Promise<SpawnResult> {
  const branch = branchFor(spec.projectId, spec.number);

  // 1. Worktree + branch + workspace + tab + root pane in one call. Reuse by BRANCH,
  //    never a predicted path (memory/naming.md); create is not idempotent (memory/naming.md), so open first.
  let workspaceId: string;
  let paneId: string;
  let worktreePath: string;
  try {
    const opened = await request<WorktreeOpened>("worktree.open", {
      cwd: spec.repoPath,
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
      cwd: spec.repoPath,
      branch,
      base: spec.base,
      focus: false,
    });
    workspaceId = created.workspace.workspace_id;
    paneId = created.root_pane.pane_id;
    worktreePath = created.worktree.path;
  }

  // Cached for the dev-server reaper (memory/architecture.md, port pool): the settled-status
  // callback in server.ts needs the worktree path to prove containment before it kills
  // anything, and this is the only place that path is resolved.
  state.worktreePath = worktreePath;

  // 2. Inject the port block before anything can start a server in there.
  await injectPortBlock(worktreePath, block, branch);

  const agentName = agentNameFor(spec.projectId, spec.number);

  // 3. Subscribe BEFORE starting the agent, or the first `working` transition is missed (memory/spawn.md).
  //
  // `pane.exited` and `pane.closed` are DIFFERENT events and we need both: `pane_exited`
  // fires when the process in the pane dies (agent crash, someone typing `exit`), while
  // `pane_closed` fires when the pane itself goes away (user closes the tab, or the
  // workspace is closed). Subscribing only to `pane.exited` misses a closed tab entirely.
  //
  // Herdr's event names on the wire are INCONSISTENTLY separated — verified in a single
  // capture: `pane.agent_status_changed` arrives dotted while `pane_closed` arrives
  // underscored. Normalise before comparing; matching either form literally silently drops
  // half the events, which is a failure with no error attached to it.
  const watch = (watched: string) => {
    state.stream?.close();
    state.stream = subscribe(
      [
        { type: "pane.agent_status_changed", pane_id: watched },
        { type: "pane.exited" },
        { type: "pane.closed" },
      ],
      (event, data) => {
        if (typeof data !== "object" || data === null) return;
        const kind = normalizeEvent(event);
        if (kind === "pane_agent_status_changed") {
          if ("agent_status" in data && typeof data.agent_status === "string") {
            onStatus(data.agent_status);
          }
          return;
        }
        if (kind === "pane_exited" || kind === "pane_closed") {
          // Both are global subscriptions, so filter to the pane we care about.
          if ("pane_id" in data && data.pane_id === watched) onPaneExit();
        }
      },
      () => void reopenStream(),
    );
  };

  const reopenStream = async (): Promise<void> => {
    for (const wait of STREAM_REOPEN_DELAYS_MS) {
      await delay(wait);
      // Teardown/retire set this to undefined, and both close the stream first, so a close
      // we caused never reaches here. An undefined stream means the run is over: stop.
      if (!state.stream) return;
      let live: AgentEnvelope;
      try {
        live = await request<AgentEnvelope>("agent.get", { target: agentName });
      } catch (err) {
        // The one code that unambiguously means the agent is gone. A pane exit during the
        // gap is invisible (pane.exited is a global subscription we were not listening to),
        // so this probe IS the dead-pane detection for that window.
        if (err instanceof HerdrError && err.code === "agent_not_found") return onPaneExit();
        continue;
      }
      const pane = live.agent?.pane_id;
      if (!pane) continue;
      watch(pane);
      return;
    }
    console.warn(`[${agentName}] event stream closed and could not be reopened; statuses will stop updating`);
  };
  watch(paneId);

  // 4. Start, with the readiness guard.
  const { reused, paneId: actualPane } = await startAgentAndWait(
    spec,
    block,
    state,
    paneId,
    state.diagnostics,
  );

  // A reused agent can sit in a different pane than the worktree's first pane, so follow it.
  if (actualPane !== paneId) {
    paneId = actualPane;
    watch(paneId);
  }

  // 5. Prompt — but ONLY for a fresh start.
  //
  // Reuse means we re-attached to an agent that is already running this ticket (memory/teardown.md
  // re-dispatch). Re-sending the ticket text would make it redo work it may have already
  // done, so re-attaching is silent. A deliberate "work on this again" is a separate
  // action. No such action exists yet — see memory/parking-lot.md.
  if (reused) return { workspaceId, paneId, worktreePath, branch };

  const text = [
    `TICKET ${spec.projectId.toUpperCase()}-${spec.number}: ${spec.title}`,
    "",
    spec.description,
  ].join("\n");

  for (let attempt = 1; attempt <= 40; attempt++) {
    try {
      await request("agent.prompt", { target: agentNameFor(spec.projectId, spec.number), text });
      state.diagnostics.promptAttempts = attempt;
      break;
    } catch (err) {
      if (err instanceof HerdrError && err.code === "agent_not_ready" && attempt < 40) {
        state.diagnostics.promptNotReadyRetries++;
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
 * open, was closed behind our back, or is already gone (memory/teardown.md).
 *
 * `force: true` is correct here because this only ever runs for an explicit user
 * action. Reconciliation must never call this.
 */
export async function teardown(spec: RunSpec, state: RunState, deleteBranch: boolean) {
  state.stream?.close();
  state.stream = undefined;

  const branch = branchFor(spec.projectId, spec.number);
  const name = agentNameFor(spec.projectId, spec.number);

  // Resolve the session directory BEFORE killing the pane, while the agent can still
  // be asked. `state.sessionDir` is a fallback for when the agent is already gone
  // (crash, Herdr restart, backend restart). Never derive the path — the slug is a
  // mangled form of the worktree path and is not ours to reconstruct (memory/reconciliation.md).
  let sessionDir = state.sessionDir;
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
      cwd: spec.repoPath,
      branch,
      focus: false,
    });
    await request("worktree.remove", { workspace_id: opened.workspace.workspace_id, force: true });
  } catch (err) {
    // worktree_not_found => nothing on disk, already clean.
    if (!(err instanceof HerdrError) || err.code !== "worktree_not_found") throw err;
  }

  // The OMP transcript lives outside the worktree and survives removal (memory/reconciliation.md).
  if (sessionDir) {
    await rm(sessionDir, { recursive: true, force: true });
    state.sessionDir = null;
  }

  if (deleteBranch) {
    try {
      await run("git", ["-C", spec.repoPath, "branch", "-D", branch]);
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

/**
 * Retire the agent for an accepted ticket. Deliberately NOT `teardown`: Accept never merges
 * (the user merges on GitHub), so the worktree holds the only copy of the reviewed commits
 * until then and must survive — reclaiming it here would destroy work the PR still points at.
 * This closes the pane (and, per Herdr, the workspace that pane belongs to) and deletes the
 * OMP transcript, and touches nothing on disk: no `worktree.remove`, no branch delete.
 */
export async function retireAgent(spec: RunSpec, state: RunState): Promise<void> {
  state.stream?.close();
  state.stream = undefined;

  const name = agentNameFor(spec.projectId, spec.number);

  // Resolve the session directory AND the pane id BEFORE closing the pane, while the agent
  // can still be asked — exactly teardown's ordering, for exactly its reason: once the pane
  // is gone, agent.get can no longer find either, and the transcript path is not ours to
  // derive by hand (memory/teardown.md).
  let sessionDir = state.sessionDir;
  let paneId: string | undefined;
  try {
    const live = await request<AgentEnvelope>("agent.get", { target: name });
    const value = live.agent?.agent_session?.value;
    if (value) sessionDir = dirname(value);
    paneId = live.agent?.pane_id;
  } catch (err) {
    // Agent already gone (crash, hand-closed tab, prior retire) — nothing left to close.
    if (!sessionDir) {
      console.warn(
        `[${name}] no session directory known and agent is gone; ` +
          `its OMP transcript will be left behind:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (paneId) {
    await request("pane.close", { pane_id: paneId });
  }

  // The OMP transcript lives outside the worktree and survives pane closure (memory/reconciliation.md).
  if (sessionDir) {
    await rm(sessionDir, { recursive: true, force: true });
    state.sessionDir = null;
  }
}
