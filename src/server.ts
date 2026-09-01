/**
 * HTTP surface. This module owns routing and the per-run state that is deliberately not
 * persisted; every other concern lives in its own module.
 *
 * Two things keep the board honest:
 *
 *  - Ticket status transitions go through `claimTicket`, a conditional UPDATE. The status
 *    IS the lock (memory/operations.md): claim first, work second, and a concurrent request loses rather
 *    than queueing, so a double-click cannot start two spawns.
 *
 *  - Anything Herdr owns — agent status, worktree existence, pane ids — is read live per
 *    request and never stored (memory/reconciliation.md, memory/naming.md). The board therefore cannot drift from reality;
 *    at worst it is a second stale.
 */
import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { request, HerdrError } from "./herdr.ts";
import { extname, join, sep } from "node:path";
import { freshDiagnostics, type Diagnostics } from "./diagnostics.ts";
import { agentNameFor, branchFor, isSettled } from "./lifecycle.ts";
import { focusAgent } from "./panes.ts";
import { createProject, deleteProject, listProjects, getProject, updateProject } from "./projects.ts";
import { findOrphans, listWorktrees, reconcileTickets } from "./reconcile.ts";
import { retireAgent, spawn, teardown, type RunSpec, type RunState } from "./runner.ts";
import {
  createTicket,
  deleteTicket,
  getTicket,
  listTickets,
  setRunFields,
  updateTicket,
} from "./ticket-store.ts";
import {
  claimTicket,
  reclaimStalePortSlots,
  releasePortSlot,
  reservePortSlot,
  setPullRequest,
  setPullRequestState,
  type Project,
  type Ticket,
} from "./db.ts";
import { openPullRequest, pullRequestUpdate, pushTicketBranch } from "./github.ts";
import { blockFor } from "./ports.ts";

const PORT = Number(process.env.PORT ?? 4010);
const PUBLIC_DIR = join(import.meta.dirname, "..", "public");

/**
 * Extension → content type, and the whole allow-list of what may be served. An extension
 * that is not in here is refused rather than guessed: guessing is how an unintended file
 * becomes readable, and `application/octet-stream` would hide the mistake behind a
 * download prompt instead of a 404.
 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * Per-run state: diagnostics and the live event-subscription handle. Not persisted, so a
 * restart forgets them — which is why `spawn` can re-attach to an agent that is still
 * running (memory/teardown.md re-dispatch).
 */
const runs = new Map<string, RunState>();

/** Tickets with an operation in flight. Rejecting beats queueing: the conflict stays visible. */
const inFlight = new Set<string>();

const runStateFor = (t: Ticket): RunState => {
  const existing = runs.get(t.id);
  if (existing) return existing;
  const fresh: RunState = { diagnostics: freshDiagnostics(), sessionDir: t.sessionDir };
  runs.set(t.id, fresh);
  return fresh;
};

const specFor = (t: Ticket, p: Project): RunSpec => ({
  projectId: t.projectId,
  number: t.number,
  title: t.title,
  description: t.description,
  repoPath: p.repoPath,
  base: p.baseBranch,
});

type Reply = { status: number; body: string };
const json = (body: unknown, status = 200): Reply => ({
  status,
  body: JSON.stringify(body),
});

/** Resolve a ticket and its project together — every run needs both. */
function resolve(id: string): { ticket: Ticket; project: Project } | Reply {
  const ticket = getTicket(id);
  if (!ticket) return json({ error: "no_such_ticket", id }, 404);
  const project = getProject(ticket.projectId);
  if (!project) return json({ error: "no_such_project", id: ticket.projectId }, 404);
  return { ticket, project };
}

const isReply = (x: object): x is Reply => "status" in x && "body" in x;

type LiveAgent = { name?: string | null; agent_status?: string; pane_id?: string; workspace_id?: string };

/**
 * Everything Herdr owns, fetched in TWO calls total rather than per ticket: one
 * `agent.list` for the whole session, and one `worktree.list` per distinct repo. Joined
 * on branch and agent name — never on a path (memory/naming.md).
 */
async function board(projectFilter: string | undefined): Promise<Reply> {
  const tickets = listTickets(projectFilter);
  const byId = new Map(listProjects().map((p) => [p.id, p]));

  const repos = [
    ...new Set(
      tickets.flatMap((t) => {
        const repo = byId.get(t.projectId)?.repoPath;
        return repo ? [repo] : [];
      }),
    ),
  ];
  const claimed = new Set(tickets.map((t) => t.branch ?? branchFor(t.projectId, t.number)));

  const [agents, worktreeLists, orphanLists] = await Promise.all([
    request<{ agents: LiveAgent[] }>("agent.list", {}).catch((err: unknown) => {
      console.warn("agent.list failed; statuses will read as unknown:", err);
      return { agents: [] };
    }),
    Promise.all(repos.map((repo) => listWorktrees(repo))),
    Promise.all(repos.map((repo) => findOrphans(repo, claimed))),
  ]);

  // An agent.list row may omit `name` entirely (an unnamed pane, e.g. this session's own),
  // so guard on it or an unnamed pane could match a ticket.
  const byAgentName = new Map(
    agents.agents.flatMap((a) => (typeof a.name === "string" && a.name ? [[a.name, a]] : [])),
  );
  const byBranch = new Map(
    worktreeLists.flat().flatMap((w) => (w.branch ? [[w.branch, w]] : [])),
  );

  const live = tickets.map((t) => {
    const branch = t.branch ?? branchFor(t.projectId, t.number);
    const agentName = t.agentName ?? agentNameFor(t.projectId, t.number);
    const agent = byAgentName.get(agentName);
    const worktree = byBranch.get(branch);
    return {
      ...t,
      branch,
      agentName,
      agentStatus: agent?.agent_status ?? null,
      hasWorktree: worktree !== undefined,
      worktreePath: worktree?.path ?? null,
      paneId: agent?.pane_id ?? null,
      workspaceId: agent?.workspace_id ?? worktree?.open_workspace_id ?? null,
      busy: inFlight.has(t.id),
      diagnostics: runs.get(t.id)?.diagnostics ?? freshDiagnostics(),
    };
  });

  return json({ tickets: live, unowned: orphanLists.flat() });
}

async function readBody(req: { on: (e: string, f: (c?: unknown) => void) => void }) {
  const { promise, resolve: done } = Promise.withResolvers<unknown>();
  let raw = "";
  req.on("data", (c) => {
    raw += String(c);
  });
  req.on("end", () => {
    if (raw.trim() === "") return done(undefined);
    try {
      done(JSON.parse(raw));
    } catch {
      done(undefined);
    }
  });
  return promise;
}

async function handle(method: string, path: string, body: unknown): Promise<Reply> {
  if (method === "GET" && path === "/projects") return json(listProjects());
  if (method === "POST" && path === "/projects") {
    const r = createProject(body);
    return r.ok ? json(r.project, 201) : json(r.body, r.status);
  }

  const projectMatch = /^\/projects\/([^/]+)$/.exec(path);
  if (projectMatch?.[1]) {
    const id = projectMatch[1];
    if (method === "PATCH") {
      const r = updateProject(id, body);
      return r.ok ? json(r.project) : json(r.body, r.status);
    }
    if (method === "DELETE") return json(deleteProject(id));
  }

  if (method === "GET" && path.startsWith("/tickets")) {
    const q = path.includes("?") ? new URLSearchParams(path.split("?")[1]) : undefined;
    return board(q?.get("project") ?? undefined);
  }
  if (method === "POST" && path === "/tickets") {
    const r = createTicket(body);
    return r.ok ? json(r.ticket, 201) : json(r.body, r.status);
  }

  // Always answers 2xx: GitHub retries a non-2xx, and a retry cannot fix a body we do not
  // recognise or a PR no ticket owns, so a 4xx would just buy repeated deliveries of the
  // same useless event. No signature check — see memory/github.md.
  if (method === "POST" && path === "/webhooks/github") {
    const update = pullRequestUpdate(body);
    if (!update) return json({ ok: true, ignored: true });
    const matched = setPullRequestState(update.url, update.state, update.additions, update.deletions);
    return json({ ok: true, matched });
  }

  const m = /^\/tickets\/([^/]+)(\/spawn|\/cancel|\/worktree|\/focus|\/accept|\/reject)?$/.exec(path);
  if (!m?.[1]) return json({ error: "not_found", path }, 404);
  const id = decodeURIComponent(m[1]);
  const action = m[2];

  if (!action && method === "PATCH") {
    const r = updateTicket(id, body);
    return r.ok ? json(r.ticket) : json(r.body, r.status);
  }

  const found = resolve(id);
  if (isReply(found)) return found;
  const { ticket, project } = found;

  if (inFlight.has(id)) return json({ error: "operation_in_flight", id }, 409);

  if (!action && method === "DELETE") {
    // memory/teardown.md: deleting a ticket is an explicit user action, so a full destructive teardown
    // is correct — worktree forced, branch deleted, transcript removed.
    inFlight.add(id);
    try {
      const state = runStateFor(ticket);
      await teardown(specFor(ticket, project), state, true);
      runs.delete(id);
      return json(deleteTicket(id));
    } finally {
      // Deleting the row frees the slot with it, but only if teardown got that far. A
      // failed Herdr call must not strand a tenth of the pool until the next boot.
      releasePortSlot(id);
      inFlight.delete(id);
    }
  }

  if (action === "/focus" && method === "POST") {
    return json(await focusAgent(ticket.agentName ?? agentNameFor(ticket.projectId, ticket.number)));
  }

  if (action === "/spawn" && method === "POST") {
    // Claim first, work second. No `await` between the check and the write (memory/operations.md).
    if (!claimTicket(id, "backlog", "in_progress")) {
      return json({ error: "not_in_backlog", status: ticket.status }, 409);
    }

    // Reserved BEFORE the agent starts, because the block is written into the worktree the
    // agent boots in — there is no later point at which it could be injected. The accepted
    // consequence is that the cap is also a cap on concurrent in-progress tickets.
    const reserved = reservePortSlot(id);
    if (!reserved.ok) {
      claimTicket(id, "in_progress", "backlog");
      return json(
        {
          error: "port_pool_exhausted",
          cap: reserved.cap,
          message:
            `all ${reserved.cap} port slots are in use; cancel a ticket or raise ` +
            "MAX_PORT_SLOTS",
        },
        409,
      );
    }
    inFlight.add(id);
    const state: RunState = { diagnostics: freshDiagnostics(), sessionDir: ticket.sessionDir };
    runs.set(id, state);

    /*
     * `sawWorking` gates the completion signal (memory/agent-status.md: the first `idle` arrives
     * BEFORE the prompt, so a settled status alone never proves completion). The persisted
     * `finished`/`died` columns are what the board renders, and a respawn reuses this same row,
     * so stale flags left by a previous attempt are cleared here — once, before the run, and
     * never again from the status callback. A `working` transition arriving AFTER a turn
     * settled belongs to a human steering the agent, on a ticket that is already in review, so
     * clearing `finished` there would erase the completion that put it there.
     */
    let sawWorking = false;
    setRunFields(id, { finished: false, died: false });

    try {
      const res = await spawn(
        specFor(ticket, project),
        blockFor(reserved.slot),
        state,
        (status) => {
          // memory/agent-status.md: the FIRST `idle` arrives before the prompt, so it is not completion.
          if (status === "working") {
            sawWorking = true;
          } else if (sawWorking && isSettled(status)) {
            /*
             * The turn completed. `finished` records that and STAYS set — it is what the
             * checkmark and, later, the Done card read — and this same moment is the column
             * transition.
             *
             * The claim is a conditional UPDATE, so it is the lock, not a read-then-write. A
             * turn can settle more than once: a human steering the agent in Herdr afterwards
             * produces `working` → settled all over again, and that second claim matches no
             * row because the ticket is already `in_review`. Nothing is re-transitioned and
             * nothing is reset. A failed claim means the ticket is no longer `in_progress`
             * (a cancel got there first), and then doing nothing is the correct action:
             * forcing it would drag a ticket back out of the column its owner just chose.
             */
            setRunFields(id, { finished: true });
            claimTicket(id, "in_progress", "in_review");
          }
        },
        () => {
          /*
           * A dead pane is not a finished ticket (memory/teardown.md rule 3), so record `died`
           * and nothing else. `finished` is deliberately left alone: the status callback above is
           * its only writer and already knows whether the turn completed, so touching it here
           * could only erase a completion that really happened. The worktree and transcript are
           * kept for inspection either way.
           */
          setRunFields(id, { died: true });
          console.warn(`[${id}] pane exited — run is dead, worktree kept for inspection`);
        },
      );
      setRunFields(id, {
        branch: res.branch,
        agentName: agentNameFor(ticket.projectId, ticket.number),
        sessionDir: state.sessionDir,
      });
      return json({ ok: true, ...res, diagnostics: state.diagnostics });
    } catch (err) {
      // Release the claim AND the block. Any worktree left behind surfaces via `unowned`
      // (memory/reconciliation.md); a slot left behind would just silently shrink the pool.
      claimTicket(id, "in_progress", "backlog");
      releasePortSlot(id);
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message, diagnostics: state.diagnostics }, 500);
    } finally {
      inFlight.delete(id);
    }
  }

  if (action === "/cancel" && method === "POST") {
    if (!claimTicket(id, "in_progress", "backlog")) {
      return json({ error: "not_in_progress", status: ticket.status }, 409);
    }
    inFlight.add(id);
    try {
      // Cancel means "discard this attempt" (memory/teardown.md): force the worktree away and delete
      // the branch. Commits survive as unreachable objects for gc.pruneExpire.
      const state = runStateFor(ticket);
      await teardown(specFor(ticket, project), state, true);
      runs.delete(id);
      setRunFields(id, { branch: null, agentName: null, sessionDir: null, finished: false, died: false });
      return json({ ok: true });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    } finally {
      releasePortSlot(id);
      inFlight.delete(id);
    }
  }

  if (action === "/worktree" && method === "DELETE") {
    // The escape hatch (memory/teardown.md): reclaim the disk, KEEP the branch, so commits are not lost.
    inFlight.add(id);
    try {
      const state = runStateFor(ticket);
      await teardown(specFor(ticket, project), state, false);
      runs.delete(id);
      claimTicket(id, "in_progress", "backlog");
      setRunFields(id, { sessionDir: null, finished: false, died: false });
      return json({ ok: true, branchKept: ticket.branch });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    } finally {
      releasePortSlot(id);
      inFlight.delete(id);
    }
  }

  if (action === "/accept" && method === "POST") {
    // A ticket that never spawned (or was force-cleaned) has no branch to publish.
    // Reject before touching the claim, same as every other precondition here.
    if (!ticket.branch) {
      return json({ error: "no_branch", id }, 409);
    }

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return json({ error: "missing_github_token", message: "GITHUB_TOKEN is not set" }, 500);
    }

    // Claim first, work second (memory/operations.md): the status IS the lock, and this
    // claim is what makes the publish-then-retire sequence below safe to run unguarded.
    if (!claimTicket(id, "in_review", "done")) {
      return json({ error: "not_in_review", status: ticket.status }, 409);
    }

    inFlight.add(id);
    try {
      let pr: { number: number; url: string };
      try {
        await pushTicketBranch(project.repoPath, ticket.branch, token);
        pr = await openPullRequest(
          project.repoPath,
          {
            branch: ticket.branch,
            base: project.baseBranch,
            title: ticket.title,
            description: ticket.description,
            ticketId: ticket.id,
          },
          token,
        );
        setPullRequest(id, pr.number, pr.url);
      } catch (err) {
        // Hand the claim back: a ticket sitting in Done with no PR is worse than a visible
        // failure. The message is already redacted by github.ts — do not log the raw error
        // separately or that redaction is undone.
        claimTicket(id, "done", "in_review");
        return json({ error: err instanceof Error ? err.message : String(err) }, 502);
      }

      // The publish is the irreversible part and it already succeeded. Retiring the agent
      // is cleanup, not part of the contract with the user: its failure must not fail the
      // request or revert the status the PR now depends on.
      try {
        const state = runStateFor(ticket);
        await retireAgent(specFor(ticket, project), state);
        runs.delete(id);
        releasePortSlot(id);
      } catch (err) {
        console.warn(`[${id}] accepted with PR #${pr.number} but retiring the agent failed:`, err);
      }

      return json(getTicket(id));
    } finally {
      inFlight.delete(id);
    }
  }

  if (action === "/reject" && method === "POST") {
    const reasonInput = (body as { reason?: unknown } | undefined)?.reason;
    if (typeof reasonInput !== "string" || reasonInput.trim() === "") {
      return json({ error: "reason_required" }, 400);
    }
    const reason = reasonInput.trim();

    // A rejection re-prompts the ticket's still-living agent, so it needs both the
    // branch and the agent name on record — without them there is nothing to re-prompt
    // and no worktree to have produced the rejected work in the first place.
    if (!ticket.branch || !ticket.agentName) {
      return json({ error: "no_agent", id }, 409);
    }

    // Claim first, work second (memory/operations.md): the status IS the lock.
    if (!claimTicket(id, "in_review", "in_progress")) {
      return json({ error: "not_in_review", status: ticket.status }, 409);
    }

    inFlight.add(id);
    try {
      const text = [
        `TICKET REJECTED: this work was sent back from review. The text below is the reason —`,
        "address it and continue.",
        "",
        reason,
      ].join("\n");
      try {
        await request("agent.prompt", { target: ticket.agentName, text });
      } catch (err) {
        // Hand the claim back: a ticket left in In Progress whose agent never heard the
        // rejection is a silent dead end (memory/operations.md).
        claimTicket(id, "in_progress", "in_review");
        // `agent_not_found` is the one Herdr code that unambiguously means the agent is
        // gone (verified against a live socket, not guessed) rather than some other
        // prompt failure such as `agent_blocked`.
        const agentGone = err instanceof HerdrError && err.code === "agent_not_found";
        return json(
          {
            error: agentGone ? "agent_not_alive" : "prompt_failed",
            message: err instanceof Error ? err.message : String(err),
          },
          409,
        );
      }

      // The ticket is working again; a stale `finished` would show a completion
      // checkmark on a card whose agent is mid-turn. `died` is left alone.
      setRunFields(id, { finished: false });
      return json(getTicket(id));
    } finally {
      inFlight.delete(id);
    }
  }

  return json({ error: "not_found", path, method }, 404);
}

/**
 * Resolve a request path to a readable file inside `public/`, or `null`.
 *
 * Containment is checked on the REAL path, after `realpath` has followed every symlink.
 * A string comparison against the requested path would happily serve a symlink that lives
 * inside `public/` and points at `/etc/shadow`; resolving first is what makes that a 404.
 * The URL is never trusted after decoding: a bad escape, a NUL byte, an extension outside
 * the allow-list and anything that is not a regular file all fail closed.
 */
async function resolvePublicAsset(bare: string): Promise<{ file: string; type: string } | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    return null; // a malformed %-escape is not a path
  }
  if (decoded.includes("\0")) return null;

  const wanted = decoded === "/" ? "/index.html" : decoded;
  const type = CONTENT_TYPES[extname(wanted).toLowerCase()];
  if (type === undefined) return null;

  let root: string;
  let file: string;
  try {
    root = await realpath(PUBLIC_DIR);
    // The leading "." keeps `join` from treating an absolute `wanted` as the whole path.
    file = await realpath(join(root, `.${wanted}`));
  } catch {
    return null; // missing file, broken symlink, or an unreadable directory on the way
  }
  if (file !== root && !file.startsWith(root + sep)) return null; // escaped public/

  // Directories, fifos and devices are all refused: there are no listings here.
  if (!(await stat(file)).isFile()) return null;
  return { file, type };
}

createServer(async (req, res) => {
  const url = req.url ?? "/";
  const path = url.split("#")[0] ?? "/";
  const bare = path.split("?")[0] ?? "/";

  // Static resolution is deliberately LAST: every API route answers with its own JSON
  // envelope first, so a wrong path under `/tickets` stays a JSON 404 instead of becoming a
  // probe of the filesystem. Only a GET that no route claimed may look at `public/`.

  try {
    const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readBody(req);
    const out = await handle(req.method ?? "GET", path, body);

    if (out.status === 404 && req.method === "GET") {
      const asset = await resolvePublicAsset(bare);
      if (asset) {
        res.writeHead(200, { "content-type": asset.type });
        res.end(await readFile(asset.file));
        return;
      }
    }

    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(out.body);
  } catch (err) {
    console.error(`${req.method} ${path} failed:`, err);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  }
}).listen(PORT, async () => {
  console.log(`10x → http://localhost:${PORT}`);

  /*
   * Reclaim port blocks held by tickets that are no longer in progress — the residue of a
   * process killed between reserving one and releasing it. Before the projects check,
   * because a stale slot outlives the project that produced it only in the sense that it
   * would still be counted against the cap.
   *
   * This one reconciliation DOES change state, and that is not a breach of "reconciliation
   * reports, it never destroys" (memory/reconciliation.md): that rule protects the user's
   * work — worktrees, branches, transcripts, none of them recreatable. A port slot is our
   * own bookkeeping, so reclaiming one cannot lose anything.
   */
  const reclaimed = reclaimStalePortSlots();
  if (reclaimed > 0) console.log(`  reclaimed ${reclaimed} stale port slot(s)`);
  const projects = listProjects();
  if (projects.length === 0) {
    console.log("no projects yet — POST /projects { id, name, repoPath } to add one");
    return;
  }
  for (const p of projects) console.log(`  ${p.id} → ${p.repoPath}`);

  // Boot reconciliation (memory/reconciliation.md). Herdr keeps panes and agents running across a restart of
  // this process, so the store can believe a ticket is in progress when its agent is gone,
  // or vice versa. This REPORTS the divergence and changes nothing: the only safe automatic
  // repair would be resetting a status with no resources behind it, and even that is better
  // surfaced than silently applied.
  for (const p of projects) {
    const mine = listTickets(p.id).filter((t) => t.status === "in_progress");
    if (mine.length === 0) continue;
    const divergences = await reconcileTickets(mine, p.repoPath);
    for (const d of divergences) {
      console.warn(`  reconcile ${d.ticketId}: ${d.reality} — ${d.note}`);
    }
  }
});
