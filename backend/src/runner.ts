/**
 * Spawn and teardown for one ticket.
 *
 * The agent boot — `agent.start`, the readiness guard, the opening prompt — is not here: it
 * is `agent-boot.ts`, shared with the planner, and its header is where the reason that
 * sequence has the shape it has is written down. Read it before touching anything below that
 * talks to `agent.start`.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  bootAgent,
  reattachAgent,
  type AgentEnvelope,
  type BootedAgent,
} from "./agent-boot.ts";
import { excludeFromGit } from "./git.ts";
import { HerdrError, request, subscribe } from "./herdr.ts";
import { agentNameFor, branchFor, normalizeEvent } from "./lifecycle.ts";
import { ENV_FILE, envFileFor, type PortBlock } from "./ports.ts";
import { loadPrompt } from "./prompts.ts";
import { listWorktrees } from "./reconcile.ts";
import { provisionSkill } from "./skills.ts";
import type { ChecklistItem, Diagnostics } from "./types.ts";

/**
 * Everything a run needs, passed explicitly so this module never touches the store.
 * `repoPath` and `base` come from the ticket's project, not the ticket.
 */
export type RunSpec = {
  projectId: string;
  number: number;
  title: string;
  description: string;
  taskBreakdown: ChecklistItem[];
  acceptanceCriteria: ChecklistItem[];
  repoPath: string;
  /**
   * The BARE upstream branch name. `spawn` prefixes it with `origin/` when it creates the
   * worktree so the agent starts from the current upstream tip rather than a stale local
   * branch (memory/gotchas.md G7); the unprefixed name is what a pull request needs as its base.
   */
  base: string;
  /** Where THIS 10x server answers, so visual-diff knows where to upload and ticket-api knows where to read/PATCH. */
  apiUrl: string;
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

/** Backoff for reopening a dropped event stream. Bounded: give up loudly rather than spin. */
const STREAM_REOPEN_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const;

type PaneInfo = { pane_id: string };
type WorktreeInfo = { path: string; branch: string | null };
type WorktreeCreated = {
  workspace: { workspace_id: string };
  root_pane: PaneInfo;
  worktree: WorktreeInfo;
};
type WorktreeOpened = { workspace: { workspace_id: string }; worktree: WorktreeInfo };

/**
 * The opening turn: the ticket, and nothing about how to work on it — that is the system
 * prompt's job, and saying it twice would make two places to change. Same shape as
 * `planner.ts`'s `openingMessage`: the checklists are why the ticket sheet collects them, and
 * an agent that never sees them cannot act on them.
 *
 * The project's own description is deliberately NOT here. It is the user's note about what the
 * project is, kept for the board; putting it in front of every agent makes an editable field
 * silently part of every prompt, which is a bigger commitment than a description box implies.
 */
function openingMessage(spec: RunSpec): string {
  const checked = (item: ChecklistItem) => `- [${item.done ? "x" : " "}] ${item.text}`;

  return [
    `TICKET ${spec.projectId.toUpperCase()}-${spec.number}: ${spec.title}`,
    "",
    spec.description,
    "",
    "Task breakdown:",
    spec.taskBreakdown.map(checked).join("\n") || "(empty)",
    "",
    "Acceptance criteria:",
    spec.acceptanceCriteria.map(checked).join("\n") || "(empty)",
  ].join("\n");
}

/**
 * Boot the ticket's implementation agent: write its system prompt, run the shared boot
 * (`agent-boot.ts` — start, readiness guard, opening turn), then keep what the rest of the run
 * needs off the agent record. Returns the pane the agent is actually in.
 */
async function bootTicketAgent(
  spec: RunSpec,
  block: PortBlock,
  state: RunState,
  paneId: string,
): Promise<string> {
  const name = agentNameFor(spec.projectId, spec.number);
  const promptFile = join(STATE_DIR, "prompts", `${spec.projectId}-${spec.number}.md`);
  await mkdir(dirname(promptFile), { recursive: true });
  /*
   * The port range is interpolated because it is per-ticket, and the rules around it are a
   * CONVENTION, not a sandbox: nothing stops the agent binding elsewhere, so the prompt has
   * to say plainly what the range is and that straying out of it breaks another ticket.
   *
   * `prompts/implementation.md` deliberately does NOT name build or test commands. A project
   * is any repo (`Project.repoPath`), so the checks belong to the repo — its `AGENTS.md`
   * states them, and OMP loads that itself. Naming them in the prompt would be a second,
   * staler copy.
   */
  const prompt = await loadPrompt("implementation", {
    portStart: block.start,
    portEnd: block.end,
    apiUrl: spec.apiUrl,
    ticketId: `${spec.projectId}-${spec.number}`,
  });
  await writeFile(promptFile, prompt, "utf8");

  // The opening turn: the ticket, and nothing about how to work on it — that is the system
  // prompt's job, and saying it twice would make two places to change.
  const text = openingMessage(spec);

  let booted: BootedAgent;
  try {
    booted = await bootAgent({
      name,
      paneId,
      args: ["--append-system-prompt", promptFile, "--auto-approve"],
      prompt: text,
      diagnostics: state.diagnostics,
    });
  } catch (err) {
    // The agent for this ticket is already live — the usual cause is a 10x backend restart,
    // since Herdr keeps panes and agents running while our in-memory ticket store resets.
    // Reuse it: killing a working agent would throw away its context.
    //
    // Re-attaching is SILENT, which is why it cannot go through `bootAgent`. The agent is
    // already running this ticket (memory/teardown.md re-dispatch), so re-sending the ticket
    // text would make it redo work it may already have done. A deliberate "work on this
    // again" is a separate action, and no such action exists yet — see memory/parking-lot.md.
    if (!(err instanceof HerdrError) || err.code !== "agent_name_taken") throw err;
    booted = await reattachAgent({ name, paneId, diagnostics: state.diagnostics });
  }

  // Canonical location, not a diagnostic: teardown needs it and diagnostics get reset.
  state.sessionDir = booted.record.agent_session?.value
    ? dirname(booted.record.agent_session.value)
    : null;

  // A reused agent may live in a different pane than the one we resolved from the
  // worktree, so report the authoritative pane back for the subscription to follow.
  return booted.paneId;
}

/**
 * Put the ticket's port block in its worktree, and keep git from seeing the file — the
 * worktree is a REAL git worktree the agent commits in, so an untracked `.env` showing up in
 * `git status` is one `git add -A` away from being committed. See git.ts for why the exclude
 * goes through `info/exclude` rather than the project's own `.gitignore`.
 */
async function injectPortBlock(worktreePath: string, block: PortBlock, ticket: string) {
  await writeFile(join(worktreePath, ENV_FILE), envFileFor(block, ticket), "utf8");
  await excludeFromGit(worktreePath, ENV_FILE);
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

    // 10x owns this clone, so nobody ever pulls it: without this fetch every ticket for the
    // life of the project branches off whatever commit existed when the repo was cloned
    // (memory/gotchas.md G7). It throws on failure, like every refused Herdr call in this
    // function — a remote we cannot reach means we cannot know what the base is, and a
    // silently stale worktree is worse than a Start that visibly did not happen. `server.ts`
    // rolls the claim and the port slot back and answers 500 with this message.
    await run("git", ["-C", spec.repoPath, "fetch", "--prune", "origin"]);

    const created = await request<WorktreeCreated>("worktree.create", {
      cwd: spec.repoPath,
      branch,
      // The remote-tracking ref, not the local branch. Fast-forwarding the local one is not
      // an option: it is checked out in a normal clone, so `git fetch origin main:main` is
      // refused outright (`refusing to fetch into branch 'refs/heads/main' checked out at`).
      // Branching off `origin/<base>` needs no local update at all — Herdr hands `base` to
      // git verbatim, verified live: `base: "main"` landed on the stale commit while
      // `base: "origin/main"` landed on the upstream tip. The prefix belongs HERE and nowhere
      // else: the stored `base_branch` is a real branch name, which is what a PR base must be.
      base: `origin/${spec.base}`,
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

  // 2. Inject the port block, and provision the skills this run needs, before the agent
  //    boots — OMP discovers `.agents/skills/*` at `agent.start`, so both must land in the
  //    worktree before step 4, and before anything could start a server in there.
  await injectPortBlock(worktreePath, block, branch);
  await provisionSkill(worktreePath, "visual-diff");
  await provisionSkill(worktreePath, "ticket-api");

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

  // 4. Start, with the readiness guard, and send the ticket — the shared boot in
  //    `agent-boot.ts`, whose header is the authority on why that order is not negotiable.
  const actualPane = await bootTicketAgent(spec, block, state, paneId);

  // A reused agent can sit in a different pane than the worktree's first pane, so follow it.
  // Only reuse can move it: a fresh start happens in the pane we handed `agent.start`.
  if (actualPane !== paneId) {
    paneId = actualPane;
    watch(paneId);
  }

  return { workspaceId, paneId, worktreePath, branch };
}

/**
 * The Herdr workspace id backing THIS ticket's own worktree, resolved by (repoPath, branch)
 * rather than by the ticket's agent name. A Herdr agent name is unique only within the WHOLE
 * Herdr session, never per 10x backend instance (memory/naming.md): a second backend process
 * sharing the same Herdr daemon can legitimately compute this exact name for an unrelated ticket
 * of its own, and `agent.get` would hand back that ticket's live pane with no error at all
 * (memory/reconciliation.md). `listWorktrees` degrades to `[]` on any Herdr trouble rather than
 * throwing, so on a hiccup this reads as "cannot confirm ownership" — abstain, don't guess.
 */
async function ownWorkspaceId(repoPath: string, branch: string): Promise<string | undefined> {
  const worktrees = await listWorktrees(repoPath);
  return worktrees.find((w) => w.branch === branch)?.open_workspace_id ?? undefined;
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

  // A Herdr agent name collides across backend instances sharing a Herdr daemon
  // (memory/naming.md), so resolve THIS ticket's own workspace by (repoPath, branch) — the
  // pair a collision cannot forge — before trusting anything `agent.get` hands back under
  // `name`.
  const ownWorkspace = await ownWorkspaceId(spec.repoPath, branch);

  // Resolve the session directory BEFORE killing the pane, while the agent can still
  // be asked. `state.sessionDir` is a fallback for when the agent is already gone
  // (crash, Herdr restart, backend restart). Never derive the path — the slug is a
  // mangled form of the worktree path and is not ours to reconstruct (memory/reconciliation.md).
  let sessionDir = state.sessionDir;
  try {
    const live = await request<AgentEnvelope>("agent.get", { target: name });
    if (ownWorkspace !== undefined && live.agent?.workspace_id === ownWorkspace) {
      const value = live.agent?.agent_session?.value;
      if (value) sessionDir = dirname(value);
    } else if (live.agent !== undefined) {
      console.warn(
        `[${name}] agent.get resolved to workspace ${live.agent.workspace_id ?? "unknown"}, but ` +
          `this ticket's own worktree is workspace ${ownWorkspace ?? "none"} — leaving its ` +
          "session directory alone; likely a Herdr agent-name collision with another 10x " +
          "backend instance (memory/reconciliation.md)",
      );
    }
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

  const branch = branchFor(spec.projectId, spec.number);
  const name = agentNameFor(spec.projectId, spec.number);

  // A Herdr agent name collides across backend instances sharing a Herdr daemon
  // (memory/naming.md): a second backend process can legitimately compute this exact name for
  // an unrelated ticket of its own, and `agent.get` would hand back that ticket's live pane
  // with no error at all. Resolve THIS ticket's own workspace by (repoPath, branch) — the pair
  // a collision cannot forge — before trusting anything `agent.get` hands back under `name`.
  const ownWorkspace = await ownWorkspaceId(spec.repoPath, branch);

  // Resolve the session directory AND the pane id BEFORE closing the pane, while the agent
  // can still be asked — exactly teardown's ordering, for exactly its reason: once the pane
  // is gone, agent.get can no longer find either, and the transcript path is not ours to
  // derive by hand (memory/teardown.md).
  let sessionDir = state.sessionDir;
  let paneId: string | undefined;
  try {
    const live = await request<AgentEnvelope>("agent.get", { target: name });
    if (ownWorkspace !== undefined && live.agent?.workspace_id === ownWorkspace) {
      const value = live.agent?.agent_session?.value;
      if (value) sessionDir = dirname(value);
      paneId = live.agent?.pane_id;
    } else if (live.agent !== undefined) {
      console.warn(
        `[${name}] agent.get resolved to workspace ${live.agent.workspace_id ?? "unknown"}, but ` +
          `this ticket's own worktree is workspace ${ownWorkspace ?? "none"} — refusing to ` +
          "close a pane that is not this ticket's own; likely a Herdr agent-name collision " +
          "with another 10x backend instance (memory/reconciliation.md)",
      );
    }
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
