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
// FIRST IMPORT, AND THE POSITION IS LOAD-BEARING. This one loads the repo-root `.env`, and
// ESM evaluates imports in order: `db.ts` below reads `STATE_DIR` and `DB_PATH` at module
// load and opens the database right there, so an `./env.ts` moved beneath it would read the
// defaults and silently open `~/.10x/10x.db` instead of the configured one — no error, just
// the wrong database. `env.test.ts` fails if this line stops being the first import.
import "./env.ts";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import { request, HerdrError } from "./herdr.ts";
import { extname, join, sep } from "node:path";
import { freshDiagnostics } from "./diagnostics.ts";
import { agentNameFor, branchFor, isSettled, planAgentNameFor } from "./lifecycle.ts";
import { focusAgent } from "./panes.ts";
import { startPlanning } from "./planner.ts";
import {
  createProject,
  deleteProject,
  listProjects,
  getProject,
  normalizeRemote,
  setProvisionState,
  updateProject,
} from "./projects.ts";
import { provisionProject, remoteHasCommits } from "./provision.ts";
import { findOrphans, listWorktrees, reconcileTickets, sweepPlanWorkspaces } from "./reconcile.ts";
import { retireAgent, spawn, teardown, type RunSpec, type RunState } from "./runner.ts";
import {
  archiveTicket,
  createTicket,
  deleteTicket,
  getTicket,
  listProjectTicketIds,
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
} from "./db.ts";
import { isTransitionStatus, planStatusMove, STATUSES } from "./transitions.ts";
import type {
  BoardResponse,
  BoardTicket,
  Diagnostics,
  Project,
  Ticket,
} from "./types.ts";
import {
  fetchPullRequestSnapshot,
  fetchRepoMetadata,
  needsLiveCheck,
  openPullRequest,
  parseRemote,
  pullRequestUpdate,
  pushTicketBranch,
  GitHubApiError,
  type PullRequest,
  type PullRequestSnapshot,
} from "./github.ts";
import { blockFor } from "./ports.ts";
import { deleteScreenshots, saveScreenshot, SCREENSHOTS_DIR } from "./screenshots.ts";
import { killDevServers } from "./dev-server.ts";

const PORT = Number(process.env.PORT ?? 4010);
/**
 * What the planning agent is told to PATCH the ticket at. `localhost` and not the Tailscale
 * host the board is reached from: the planner runs in a pane on THIS machine, beside this
 * process. Derived from `PORT` so a backend moved off 4010 does not hand out a dead URL.
 */
const API_URL = `http://localhost:${PORT}`;
// The frontend is its own workspace package and is served from its BUILD, not its source.
// In development you do not come here at all — `pnpm dev` runs Vite on :5173, which proxies
// the API back to this process. This path matters when the board is being used rather than
// worked on, and `dist` is gitignored, hence the boot check below.
const PUBLIC_DIR = join(import.meta.dirname, "..", "..", "frontend", "dist");

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
  // Vite emits self-hosted Geist as .woff2. Without this the fonts 404 and the board falls
  // back to a system sans — a failure that looks almost right, which is the worst kind.
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

/**
 * The client-side routes React Router owns (`frontend/src/App.tsx`'s `<Routes>`). A hard
 * refresh or a direct load of one of these hits the backend with no matching API route and
 * no file on disk, so the fallback below serves the app shell exactly as `/` already does —
 * the router then reads the URL client-side and renders the right page.
 *
 * A named allow-list, not "any GET with no file extension": the same reasoning as
 * `CONTENT_TYPES` above. `/js` (a directory, no extension) must keep 404ing rather than
 * silently becoming the app shell.
 */
const SPA_ROUTES: Record<string, true> = { "/board": true, "/dashboard": true, "/playbooks": true, "/list": true };

/**
 * Per-run state: diagnostics and the live event-subscription handle. Not persisted, so a
 * restart forgets them — which is why `spawn` can re-attach to an agent that is still
 * running (memory/teardown.md re-dispatch).
 */
const runs = new Map<string, RunState>();

/** Tickets with an operation in flight. Rejecting beats queueing: the conflict stays visible. */
const inFlight = new Set<string>();

/**
 * Projects whose clone is running. Same reason as `inFlight` above, different key space: a
 * second POST while a repo is still downloading must lose rather than start a second clone into
 * the same directory.
 */
const provisioning = new Set<string>();

/**
 * Runs the clone, in the background, and owns the `provision_state` column while it does.
 *
 * Deliberately not awaited by the route that starts it. A large repo is minutes of work, and
 * `POST /projects` has already done the part that can fail fast and informatively — parsing the
 * remote and proving the repo exists and is readable. Making the caller wait for the clone would
 * turn a stalled network into a hung dialog with nothing to show, so the row lands `pending` and
 * the board's existing one-second poll reports the rest.
 */
async function runProvisioning(projectId: string, seedInitialCommit: boolean): Promise<void> {
  if (provisioning.has(projectId)) return;
  provisioning.add(projectId);
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      setProvisionState(projectId, "failed", "GITHUB_TOKEN is not set, so the repo cannot be cloned");
      return;
    }
    const project = getProject(projectId);
    if (project === undefined) return;

    setProvisionState(projectId, "cloning");
    const outcome = await provisionProject(project, {
      token,
      seedInitialCommit,
      ...(await seedIdentity(token)),
    });
    setProvisionState(projectId, outcome.ok ? "ready" : "failed", outcome.ok ? "" : outcome.message);
  } catch (err) {
    // A throw here is a bug rather than an expected failure, but leaving the row on `cloning`
    // forever would be worse than reporting it: that state disables Start with no way out.
    setProvisionState(projectId, "failed", err instanceof Error ? err.message : String(err));
  } finally {
    provisioning.delete(projectId);
  }
}

/**
 * Who authors the initial commit on an empty repo. The token's own GitHub identity, so the
 * first commit in the user's new repo reads like theirs rather than a tool's — it sits at the
 * bottom of that history permanently. Falls back to a generic identity rather than failing the
 * whole provision over an author name.
 */
async function seedIdentity(token: string): Promise<{ authorName: string; authorEmail: string }> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`github /user answered ${res.status}`);
    const user = (await res.json()) as { login?: unknown; id?: unknown };
    if (typeof user.login !== "string" || typeof user.id !== "number") {
      throw new Error("github /user answered an unexpected shape");
    }
    return {
      authorName: user.login,
      authorEmail: `${user.id}+${user.login}@users.noreply.github.com`,
    };
  } catch {
    return { authorName: "10x", authorEmail: "10x@localhost" };
  }
}

/**
 * Reconcile-on-read cache for PR state: a ticket's PR is asked about live at most once per TTL
 * window rather than on every one-second board poll. Keyed by ticket id, not PR URL — every
 * other per-ticket map in this module (`runs`, `inFlight`) is keyed by id, and a URL does not
 * exist yet for a ticket that has never been accepted, so id needs no extra null-check to use
 * as a key. ~60s matches memory/github.md's own estimate for how fresh an open-PR read needs
 * to be.
 *
 * Tradeoff accepted here: a merge or close that happens between two live checks for the same
 * ticket is invisible until the next one — up to PR_CHECK_TTL_MS stale. A webhook receiver
 * would close that gap to near-real-time; memory/parking-lot.md records why it is parked
 * rather than built, now that this reconcile makes it a latency question, not a correctness one.
 */
const PR_CHECK_TTL_MS = 60_000;
const prLastChecked = new Map<string, number>();

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
  taskBreakdown: t.taskBreakdown,
  acceptanceCriteria: t.acceptanceCriteria,
  repoPath: p.repoPath,
  base: p.baseBranch,
  apiUrl: API_URL,
});

/**
 * Which agent this ticket's card and its Focus button are about.
 *
 * A backlog ticket's only possible agent is its PLANNER: `/spawn` claims from `todo`, and
 * every route back to `todo` tears the implementation agent down first, so no run can be live
 * under a backlog card. Resolving the plan name there is what lets a live planning
 * conversation show up through the existing agent chip and spinner instead of needing a second
 * status vocabulary — the two names are deliberately different (memory/naming.md), so a join
 * on the implementation name alone reports `null` for the whole planning run.
 *
 * Keyed on status rather than "whichever of the two names Herdr knows", on purpose: the boot
 * sweep is the only thing that collects a planner whose ticket was promoted
 * (memory/reconciliation.md), so until the next boot a `todo` ticket can still have a live
 * planner — and reporting that as the ticket's status would show work happening on a card that
 * nobody has started.
 *
 * The persisted name still wins everywhere else (db.ts rule 1): a ticket dispatched under an
 * older scheme keeps pointing at the agent that actually exists.
 */
const liveAgentNameFor = (t: Ticket) =>
  t.status === "backlog"
    ? planAgentNameFor(t.projectId, t.number)
    : (t.agentName ?? agentNameFor(t.projectId, t.number));

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
 * Fail-open, unlike the delete guard's live read: this is a display concern, not an
 * irreversible-action gate. A missing token or a failed fetch just leaves whatever the DB
 * already has (including `null`) in place — never thrown, never lets one bad ticket fail the
 * whole board response. Only tickets whose TTL window has elapsed are passed in, and every
 * check runs concurrently, the same `Promise.all` shape `board()` already uses per repo.
 *
 * Returns what it freshly read, keyed by ticket id, rather than relying on a caller re-query:
 * `board()`'s own `tickets` array was already fetched before this runs, so without handing the
 * fresh values back the write above would be invisible until the *next* poll — a needless
 * extra second of staleness on top of the TTL this function already accepts.
 */
async function reconcilePullRequests(
  due: Ticket[],
  byId: Map<string, Project>,
  now: number,
): Promise<Map<string, PullRequestSnapshot>> {
  const reconciled = new Map<string, PullRequestSnapshot>();
  const token = process.env.GITHUB_TOKEN;
  if (!token || due.length === 0) return reconciled;
  await Promise.all(
    due.map(async (t) => {
      prLastChecked.set(t.id, now);
      const project = byId.get(t.projectId);
      if (!project || t.prNumber === null || !t.prUrl) return;
      try {
        const snapshot = await fetchPullRequestSnapshot(project, t.prNumber, token);
        setPullRequestState(t.prUrl, snapshot.state, snapshot.additions, snapshot.deletions);
        reconciled.set(t.id, snapshot);
      } catch (err) {
        console.warn(`[${t.id}] PR state reconcile failed; board serves the stale stored value:`, err);
      }
    }),
  );
  return reconciled;
}

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

  // Reconcile-on-read: every ticket whose PR is non-terminal and has not been checked within
  // the TTL is worth a live read, backfilling `prState`/`prAdditions`/`prDeletions` for tickets
  // no webhook ever reached — the pre-existing case — without waiting on `gh webhook forward`.
  const now = Date.now();
  const dueForCheck = tickets.filter(
    (t) =>
      t.prNumber !== null &&
      needsLiveCheck(t.prState) &&
      (prLastChecked.get(t.id) ?? 0) + PR_CHECK_TTL_MS <= now,
  );

  const [agents, worktreeLists, orphanLists, reconciled] = await Promise.all([
    request<{ agents: LiveAgent[] }>("agent.list", {}).catch((err: unknown) => {
      console.warn("agent.list failed; statuses will read as unknown:", err);
      return { agents: [] };
    }),
    Promise.all(repos.map((repo) => listWorktrees(repo))),
    Promise.all(repos.map((repo) => findOrphans(repo, claimed))),
    reconcilePullRequests(dueForCheck, byId, now),
  ]);

  // An agent.list row may omit `name` entirely (an unnamed pane, e.g. this session's own),
  // so guard on it or an unnamed pane could match a ticket.
  const byAgentName = new Map(
    agents.agents.flatMap((a) => (typeof a.name === "string" && a.name ? [[a.name, a]] : [])),
  );
  const byBranch = new Map(
    worktreeLists.flat().flatMap((w) => (w.branch ? [[w.branch, w]] : [])),
  );

  // The `: BoardTicket` annotation is the point of types.ts: this object literal is the wire
  // format, and without it a field added or dropped here diverged from the frontend silently.
  const live = tickets.map((t): BoardTicket => {
    const branch = t.branch ?? branchFor(t.projectId, t.number);
    const agentName = liveAgentNameFor(t);
    const agent = byAgentName.get(agentName);
    const worktree = byBranch.get(branch);
    const snapshot = reconciled.get(t.id);
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
      ...(snapshot
        ? { prState: snapshot.state, prAdditions: snapshot.additions, prDeletions: snapshot.deletions }
        : {}),
    };
  });

  const payload: BoardResponse = { tickets: live, unowned: orphanLists.flat() };
  return json(payload);
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

/**
 * The admission test, and the reason a bad link fails in the dialog instead of at Accept three
 * days later: one GitHub read proves the URL parses, the repo exists and the token can see it,
 * and hands back the name, description and default branch so none of them has to be a field.
 *
 * Emptiness comes from `git ls-remote`, not from this response: `default_branch` is a setting
 * GitHub reports even for a repo with no commits, where that branch does not exist as a ref
 * (memory/gotchas.md G8). Answering `empty: true` there is what lets the dialog offer to make
 * the first commit rather than letting the first spawn fail.
 */
async function lookupRemote(remote: string | null): Promise<Reply> {
  if (remote === null || remote.trim() === "") {
    return json({ error: "invalid_remote", field: "remote", message: "remote is required" }, 400);
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return json(
      { error: "github_token_missing", message: "GITHUB_TOKEN is not set, so the repo cannot be verified" },
      409,
    );
  }

  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseRemote(normalizeRemote(remote)));
  } catch {
    return json(
      {
        error: "invalid_remote",
        field: "remote",
        message: `not a GitHub repository: "${remote}". Expected https://github.com/owner/repo.`,
      },
      400,
    );
  }

  try {
    const meta = await fetchRepoMetadata(owner, repo, token);
    const empty = !(await remoteHasCommits(meta.owner, meta.repo, token));
    return json({ ...meta, empty });
  } catch (err) {
    if (err instanceof GitHubApiError) {
      const status = err.code === "repo_not_found" ? 404 : err.code === "repo_not_accessible" ? 403 : 502;
      return json({ error: err.code, field: "remote", message: err.message }, status);
    }
    return json({ error: "github_unavailable", message: err instanceof Error ? err.message : String(err) }, 502);
  }
}

/**
 * Deleting a project destroys the work inside it, and says so first.
 *
 * This used to be one SQL statement. Tickets cascaded and nothing else moved, which left agents
 * running that no row pointed at any more — and worse, invisible: `board()` derives its orphan
 * scan set from surviving tickets, so once the cascade took the last one, that repo was never
 * handed to `findOrphans` at all. Agents burning tokens with no card to show it
 * (memory/teardown.md).
 *
 * So: refuse if any ticket still has an open pull request, then run the same destructive
 * teardown `DELETE /tickets/:id` runs, per ticket, and finally remove both directories. Two
 * directories, not one — Herdr keeps worktrees under its own root, not inside the repo, so
 * deleting only the clone would strand them with a `.git` link pointing at nothing.
 */
async function deleteProjectCompletely(id: string): Promise<Reply> {
  const project = getProject(id);
  if (project === undefined) {
    return json({ error: "project_not_found", field: "id", message: `no project with id "${id}"` }, 404);
  }
  // Archived tickets are deliberately excluded from the teardown loop: archiving already ran
  // the same destructive teardown, so they have no agent, worktree or branch left. Their rows
  // still go, via ON DELETE CASCADE, and their screenshots are swept below.
  const tickets = listTickets(id);
  if (tickets.some((t) => inFlight.has(t.id))) {
    return json({ error: "operation_in_flight", id }, 409);
  }

  // The same guard the per-ticket delete uses, and for the same reason: `prState` is null
  // whenever no webhook has arrived, so a check reading only the column would fail open exactly
  // when it matters. Live-read anything non-terminal, and fail closed if it cannot be read.
  const needsCheck = tickets.filter((t) => t.prNumber !== null && needsLiveCheck(t.prState));
  if (needsCheck.length > 0) {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return json(
        {
          error: "pr_state_unknown",
          message: "GITHUB_TOKEN is not set; open pull requests cannot be verified before deleting",
        },
        409,
      );
    }
    const open: { ticketId: string; prNumber: number; prUrl: string | null }[] = [];
    for (const ticket of needsCheck) {
      if (ticket.prNumber === null) continue;
      try {
        const live = await fetchPullRequestSnapshot(project, ticket.prNumber, token);
        if (live.state === "open") {
          open.push({ ticketId: ticket.id, prNumber: ticket.prNumber, prUrl: ticket.prUrl });
        } else if (ticket.prUrl) {
          setPullRequestState(ticket.prUrl, live.state, live.additions, live.deletions);
        }
      } catch (err) {
        return json(
          { error: "pr_state_unknown", message: err instanceof Error ? err.message : String(err) },
          409,
        );
      }
    }
    if (open.length > 0) {
      return json(
        {
          error: "pr_open",
          message:
            open.length === 1
              ? `PR #${open[0]?.prNumber} is still open — merge or close it on GitHub first`
              : `${open.length} pull requests are still open — merge or close them on GitHub first`,
          openPullRequests: open,
        },
        409,
      );
    }
  }

  // Past the point of refusal. Each ticket goes the same way a single DELETE /tickets/:id would
  // take it — agent retired, worktree forced, branch deleted, transcript removed. A failure on
  // one must not abandon the rest, so they are collected rather than thrown.
  const failures: string[] = [];
  for (const ticket of tickets) {
    inFlight.add(ticket.id);
    try {
      await teardown(specFor(ticket, project), runStateFor(ticket), true);
    } catch (err) {
      failures.push(`${ticket.id}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      runs.delete(ticket.id);
      releasePortSlot(ticket.id);
      inFlight.delete(ticket.id);
    }
  }

  // Screenshots are 10x's own bookkeeping rather than the user's work, so they follow the row
  // automatically — including for archived tickets, whose worktrees are long gone but whose
  // files are still on disk.
  for (const ticketId of listProjectTicketIds(id)) await deleteScreenshots(ticketId);

  deleteProject(id);

  // Last, and only now: the row is gone, so nothing can hand this path to a spawn mid-removal.
  //
  // Only if 10x actually owns that directory. Every project created under this feature has
  // `repoPath` derived as `$PROJECTS_ROOT/<id>` and can never repoint it (memory/plug-and-play
  // projects.md), but a project that predates this feature keeps whatever folder it was created
  // with, and the migration backfills its identity without moving that folder under
  // `PROJECTS_ROOT` (db.ts's `backfillProjectIdentity`). Deleting such a project must not
  // `rm -rf` a directory the user pointed 10x at themselves — the same "never touch a folder it
  // did not create" rule `provision.ts` already applies to cloning.
  if (project.ownsClone) {
    try {
      await rm(project.repoPath, { recursive: true, force: true });
    } catch (err) {
      failures.push(`clone: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    failures.push(
      `clone: ${project.repoPath} predates 10x's own clones and was left in place — remove it yourself if you want it gone`,
    );
  }

  return json(failures.length === 0 ? { ok: true } : { ok: true, warnings: failures });
}

async function handle(method: string, path: string, body: unknown): Promise<Reply> {
  if (method === "GET" && path === "/projects") return json(listProjects());

  // Before the /projects/:id match below, which would otherwise read "lookup" as a project id.
  if (method === "GET" && path.startsWith("/projects/lookup")) {
    const query = path.includes("?") ? new URLSearchParams(path.split("?")[1]) : undefined;
    return lookupRemote(query?.get("remote") ?? null);
  }

  if (method === "POST" && path === "/projects") {
    const r = createProject(body);
    if (!r.ok) return json(r.body, r.status);
    // Not awaited: the clone is the slow half and the row already carries `pending`, so the
    // dialog closes now and the board's poll reports the rest.
    const seed = (body as { seedInitialCommit?: unknown } | undefined)?.seedInitialCommit === true;
    void runProvisioning(r.project.id, seed);
    return json(r.project, 201);
  }

  const provisionMatch = /^\/projects\/([^/?]+)\/provision$/.exec(path);
  if (provisionMatch?.[1] && method === "POST") {
    const id = provisionMatch[1];
    const project = getProject(id);
    if (project === undefined) {
      return json({ error: "project_not_found", field: "id", message: `no project with id "${id}"` }, 404);
    }
    if (provisioning.has(id)) return json({ error: "operation_in_flight", id }, 409);
    const seed = (body as { seedInitialCommit?: unknown } | undefined)?.seedInitialCommit !== false;
    await runProvisioning(id, seed);
    return json(getProject(id) ?? project);
  }

  const projectMatch = /^\/projects\/([^/?]+)$/.exec(path);
  if (projectMatch?.[1]) {
    const id = projectMatch[1];
    if (method === "PATCH") {
      const r = updateProject(id, body);
      if (!r.ok) return json(r.body, r.status);
      // Re-linking a failed project resets it to `pending`; start the retry rather than
      // leaving it queued with nothing driving it.
      if (r.project.provisionState === "pending") void runProvisioning(id, true);
      return json(r.project);
    }
    if (method === "DELETE") return deleteProjectCompletely(id);
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

  const m = /^\/tickets\/([^/]+)(\/spawn|\/cancel|\/status|\/worktree|\/focus|\/accept|\/reject|\/plan|\/archive)?$/.exec(path);
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

  // Before any claim, so a refusal never moves the ticket. The two routes that boot an agent
  // need a repository on disk to create a worktree in; without one, `worktree.create` fails and
  // the card is left in `in_progress` with nothing running. Refusing here is what lets the
  // board disable Start with an explanation instead of offering an action that cannot work.
  if ((action === "/spawn" || action === "/plan") && method === "POST") {
    if (project.provisionState !== "ready") {
      return json(
        {
          error: "project_not_provisioned",
          projectId: project.id,
          provisionState: project.provisionState,
          message:
            project.provisionState === "failed"
              ? `project "${project.id}" could not be set up: ${project.provisionError}`
              : `project "${project.id}" is still downloading its repository`,
        },
        409,
      );
    }
  }

  if (!action && method === "DELETE") {
    // memory/teardown.md: deleting a ticket is an explicit user action, so a full destructive teardown
    // is correct — worktree forced, branch deleted, transcript removed.
    //
    // But a ticket with an open PR still points a live GitHub review at this branch, so the
    // teardown is refused rather than trusting `ticket.prState`: that column is null whenever no
    // webhook has arrived, which is the common case, so a guard reading only the column would
    // fail open exactly when it matters most. A live read is required for anything non-terminal.
    if (ticket.prNumber !== null && needsLiveCheck(ticket.prState)) {
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        return json(
          { error: "pr_state_unknown", message: "GITHUB_TOKEN is not set; the PR state cannot be verified before deleting" },
          409,
        );
      }
      let live: PullRequestSnapshot;
      try {
        live = await fetchPullRequestSnapshot(project, ticket.prNumber, token);
      } catch (err) {
        // Fail closed: we cannot verify the PR is safe to orphan, and the teardown is irreversible.
        const message = err instanceof Error ? err.message : String(err);
        return json({ error: "pr_state_unknown", message }, 409);
      }
      if (live.state === "open") {
        return json(
          {
            error: "pr_open",
            message: `PR #${ticket.prNumber} is still open — merge or close it on GitHub first`,
            prNumber: ticket.prNumber,
            prUrl: ticket.prUrl,
          },
          409,
        );
      }
      // Persist the freshly-read terminal state and LOC. This is also the recovery path for a
      // merge/close event missed while webhook forwarding was down (memory/teardown.md): the
      // next delete attempt catches up the row instead of needing a manual fix.
      if (ticket.prUrl) {
        setPullRequestState(ticket.prUrl, live.state, live.additions, live.deletions);
      }
    }

    inFlight.add(id);
    try {
      const state = runStateFor(ticket);
      await teardown(specFor(ticket, project), state, true);
      runs.delete(id);
      const result = deleteTicket(id);
      // 10x's own bookkeeping, not the user's work (memory/architecture.md, port pool) — the
      // same automatic-reclaim treatment a port slot gets, unlike the worktree and branch
      // teardown just decided above, which memory/teardown.md never removes automatically.
      await deleteScreenshots(id);
      return json(result);
    } finally {
      // Deleting the row frees the slot with it, but only if teardown got that far. A
      // failed Herdr call must not strand a tenth of the pool until the next boot.
      releasePortSlot(id);
      inFlight.delete(id);
    }
  }

  if (action === "/focus" && method === "POST") {
    // The same resolution the card was drawn from, or the Focus button on a planning card
    // would target an implementation agent that does not exist.
    return json(await focusAgent(liveAgentNameFor(ticket)));
  }

  if (action === "/plan" && method === "POST") {
    /*
     * Plan is the `backlog -> todo` conversation, so it belongs to backlog and nowhere else:
     * a planner told to shape a ticket that is already being implemented would be discussing
     * work an agent has half-finished, and `prompts/plan.md` tells it to overwrite the
     * ticket's fields as it goes. Refused in the style of the neighbouring handlers, naming
     * the status it found.
     *
     * It never claims the ticket. Plan writes NO status — promoting is a human clicking the
     * button that moves it — so there is nothing to CAS and nothing to hand back on failure.
     * `inFlight` (checked above, like every other action) is the whole concurrency guard:
     * without it two fast clicks race between `agent.get` finding nothing and `agent.start`
     * taking the name, and the loser leaves an orphan workspace behind.
     *
     * No port slot either. A planner starts no dev server, so reserving one would spend a
     * tenth of the pool on a conversation (memory/architecture.md, port pool).
     */
    if (ticket.status !== "backlog") {
      return json(
        {
          error: "not_in_backlog",
          message: `plan is the backlog conversation; this ticket is ${ticket.status}`,
          status: ticket.status,
        },
        409,
      );
    }

    inFlight.add(id);
    try {
      const plan = await startPlanning(
        {
          ticketId: ticket.id,
          projectId: ticket.projectId,
          number: ticket.number,
          // The card as it stands, for the planner's opening message: it is told to skip
          // anything already filled in, which it can only do if it is handed the fields.
          title: ticket.title,
          description: ticket.description,
          playbook: ticket.playbook,
          taskBreakdown: ticket.taskBreakdown,
          acceptanceCriteria: ticket.acceptanceCriteria,
          repoPath: project.repoPath,
        },
        API_URL,
      );
      return json({ ok: true, ...plan });
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    } finally {
      inFlight.delete(id);
    }
  }

  if (action === "/status" && method === "POST") {
    const to = (body as { to?: unknown } | undefined)?.to;
    if (!isTransitionStatus(to)) {
      return json(
        { error: "invalid_input", field: "to", message: `to must be one of ${STATUSES.join(", ")}` },
        400,
      );
    }

    // The table in transitions.ts is the whole guard, and it separates two different mistakes:
    // a pair the machine does not have at all, and a real move that belongs to a route because
    // it has side effects. Making the bare status write for the second kind would put a card in
    // In Progress with no worktree, no branch, no port block and no agent behind it, so the
    // refusal names the route that owns the move instead.
    const plan = planStatusMove(ticket.status, to);
    if (!plan.ok) {
      return json({ error: plan.error, message: plan.message, from: ticket.status, to, owner: plan.owner }, 409);
    }

    // There is no work to do after the claim — that is what makes the move pure — but the CAS
    // is still what resolves two concurrent moves to one winner (memory/operations.md), and
    // nothing may `await` between reading `ticket.status` and writing it.
    if (!claimTicket(id, ticket.status, to)) {
      return json({ error: "not_in_status", expected: ticket.status, status: getTicket(id)?.status ?? null }, 409);
    }
    return json(getTicket(id));
  }

  if (action === "/spawn" && method === "POST") {
    // Claim first, work second. No `await` between the check and the write (memory/operations.md).
    if (!claimTicket(id, "todo", "in_progress")) {
      return json({ error: "not_in_todo", status: ticket.status }, 409);
    }

    // Reserved BEFORE the agent starts, because the block is written into the worktree the
    // agent boots in — there is no later point at which it could be injected. The accepted
    // consequence is that the cap is also a cap on concurrent in-progress tickets.
    const reserved = reservePortSlot(id);
    if (!reserved.ok) {
      claimTicket(id, "in_progress", "todo");
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
            const claimed = claimTicket(id, "in_progress", "in_review");

            // Kill the agent's dev server now that the ticket is off the agent's hands —
            // the reserved block is the only handle 10x has on that process
            // (memory/architecture.md, port pool; see dev-server.ts for the containment proof).
            // Only when the claim actually landed: a lost claim means a cancel got there
            // first and the ports are somebody else's problem now. Fire-and-forget with an
            // attached catch — this callback is not async, and a kill failure must never
            // fail the column transition that already happened above.
            if (claimed) {
              if (state.worktreePath) {
                void killDevServers(blockFor(reserved.slot), state.worktreePath)
                  .then((result) => {
                    if (result.killed.length > 0 || result.skipped.length > 0) {
                      console.warn(`[${id}] dev-server reap: killed ${JSON.stringify(result.killed)}, skipped ${JSON.stringify(result.skipped)}`);
                    }
                  })
                  .catch((err) => console.warn(`[${id}] dev-server reap failed:`, err));
              } else {
                // Unreachable in practice, and kept only because `worktreePath` is optional on
                // `RunState`: `spawn` sets it before it subscribes, and this closure cannot
                // outlive the process that made that subscription, so any event able to reach
                // here was delivered to a state that already has the path. It is NOT the
                // restart case — after a restart no subscription exists at all, so this
                // callback never runs and the ticket stays In Progress (gotchas.md G2).
                console.warn(`[${id}] cannot reap dev server: worktree path unknown`);
              }
            }
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
      claimTicket(id, "in_progress", "todo");
      releasePortSlot(id);
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message, diagnostics: state.diagnostics }, 500);
    } finally {
      inFlight.delete(id);
    }
  }

  if (action === "/cancel" && method === "POST") {
    if (!claimTicket(id, "in_progress", "todo")) {
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
      claimTicket(id, "in_progress", "todo");
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
      let pr: PullRequest;
      try {
        await pushTicketBranch(project.repoPath, project, ticket.branch, token);
        pr = await openPullRequest(
          project,
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
        setPullRequestState(pr.url, pr.state, pr.additions, pr.deletions);
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

  if (action === "/archive" && method === "POST") {
    // Archive only ever fires from Done — refused here rather than trusting the frontend,
    // the same posture /plan already takes for backlog-only and /status takes for its table.
    if (ticket.status !== "done") {
      return json(
        { error: "not_done", message: `archive only applies to Done tickets; this one is ${ticket.status}`, status: ticket.status },
        409,
      );
    }

    // Same live-read guard DELETE /tickets/:id already runs, same reasoning: a stored
    // prState is null whenever no webhook arrived, which is the common case, so trusting
    // it would fail open exactly when it matters. Fail closed on anything unverifiable.
    if (ticket.prNumber === null || needsLiveCheck(ticket.prState)) {
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        return json(
          { error: "pr_state_unknown", message: "GITHUB_TOKEN is not set; the PR state cannot be verified before archiving" },
          409,
        );
      }
      if (ticket.prNumber === null) {
        return json(
          { error: "pr_state_unknown", message: "this ticket has no recorded pull request, so archiving cannot be verified safe" },
          409,
        );
      }
      let live: PullRequestSnapshot;
      try {
        live = await fetchPullRequestSnapshot(project, ticket.prNumber, token);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json({ error: "pr_state_unknown", message }, 409);
      }
      if (live.state === "open") {
        return json(
          { error: "pr_open", message: `PR #${ticket.prNumber} is still open — merge or close it on GitHub first`, prNumber: ticket.prNumber, prUrl: ticket.prUrl },
          409,
        );
      }
      if (ticket.prUrl) {
        setPullRequestState(ticket.prUrl, live.state, live.additions, live.deletions);
      }
    }

    inFlight.add(id);
    try {
      const state = runStateFor(ticket);
      await teardown(specFor(ticket, project), state, true);
      runs.delete(id);
      archiveTicket(id);
      return json(getTicket(id));
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 500);
    } finally {
      releasePortSlot(id);
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

/**
 * Resolve `/screenshots/<file>` to a readable file under `SCREENSHOTS_DIR`, or `null`. Same
 * shape and the same reasons as `resolvePublicAsset` above — realpath containment, a decode
 * failure or embedded NUL fails closed, only a regular file is served — narrowed to the one
 * extension `screenshots.ts` ever writes.
 */
async function resolveScreenshotAsset(bare: string): Promise<{ file: string; type: string } | null> {
  const m = /^\/screenshots\/([^/]+)$/.exec(bare);
  if (!m?.[1]) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || extname(decoded).toLowerCase() !== ".png") return null;

  let root: string;
  let file: string;
  try {
    root = await realpath(SCREENSHOTS_DIR);
    file = await realpath(join(root, decoded));
  } catch {
    return null;
  }
  if (file !== root && !file.startsWith(root + sep)) return null;
  if (!(await stat(file)).isFile()) return null;
  return { file, type: "image/png" };
}

const SCREENSHOT_UPLOAD_RE = /^\/tickets\/([^/]+)\/screenshots\/(before|after)$/;

/**
 * Bigger than any real capture needs to be — a 1680x940 PNG at 2x density is a few MB at
 * most — and small enough to bound what an upload can hold in memory. Enforced by
 * `readRawBody` aborting the connection once the running total crosses it, not by trusting a
 * client-supplied `Content-Length`.
 */
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

/** The one byte signature `screenshots.ts` ever writes — see `handleScreenshotUpload`. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Thrown by `readRawBody` when the body crosses `maxBytes`, so the caller can answer 413. */
class PayloadTooLargeError extends Error {}

/**
 * Same shape as `readBody`, minus the JSON parse: the one route whose body is bytes, not
 * JSON. Rejects with `PayloadTooLargeError` as soon as the running total exceeds `maxBytes`,
 * so an oversized upload is never buffered whole — but it does NOT destroy the connection:
 * the client is still writing, and killing the socket the instant the promise rejects races
 * the caller's 413 response, which the client then sees as a bare connection reset instead of
 * an HTTP error. Excess chunks are simply dropped rather than stored, which is what keeps
 * memory bounded; the stream is left to drain to its own `end` on its own time.
 */
async function readRawBody(
  req: { on: (e: string, f: (c?: unknown) => void) => void },
  maxBytes: number,
): Promise<Buffer> {
  const { promise, resolve: done, reject: fail } = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;
  req.on("data", (c) => {
    const chunk = c as Buffer;
    total += chunk.length;
    if (total > maxBytes) {
      if (!exceeded) fail(new PayloadTooLargeError(`body exceeded ${maxBytes} bytes`));
      exceeded = true;
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (!exceeded) done(Buffer.concat(chunks));
  });
  req.on("error", fail);
  return promise;
}

/**
 * `POST /tickets/:id/screenshots/:side`, raw PNG bytes — the visual-diff skill's upload path
 * (skills/visual-diff/SKILL.md). Deliberately NOT folded into `handle()`, whose `body`
 * parameter is JSON-or-undefined by contract everywhere else in this API.
 *
 * No ticket-status gate and no `inFlight` check: the agent that captures is the one already
 * holding the ticket for its whole time in progress, and a re-upload — a respawn re-capturing,
 * or the agent retrying after a failed POST — is an ordinary overwrite (screenshots.ts), not a
 * conflict.
 *
 * Two checks make "not a screenshot" a 400 rather than a stored garbage file: the declared
 * `Content-Type` must say `image/png` (params such as `; charset=` are stripped first,
 * defensively, though a PNG upload has no reason to carry one), and the bytes themselves must
 * start with the real PNG signature — a client that lies about its header is caught by the
 * second check even if it passes the first.
 */
async function handleScreenshotUpload(
  id: string,
  side: "before" | "after",
  contentType: string | undefined,
  data: Buffer,
): Promise<Reply> {
  if (getTicket(id) === undefined) return json({ error: "no_such_ticket", id }, 404);
  if (data.length === 0) return json({ error: "empty_body", message: "screenshot body was empty" }, 400);
  const mime = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mime !== "image/png") {
    return json(
      { error: "invalid_content_type", message: "expected Content-Type: image/png", contentType: contentType ?? null },
      400,
    );
  }
  if (!data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return json({ error: "invalid_image", message: "body is not a PNG" }, 400);
  }
  const path = await saveScreenshot(id, side, data);
  return json({ ok: true, path });
}

createServer(async (req, res) => {
  const url = req.url ?? "/";
  const path = url.split("#")[0] ?? "/";
  const bare = path.split("?")[0] ?? "/";

  // Static resolution is deliberately LAST: every API route answers with its own JSON
  // envelope first, so a wrong path under `/tickets` stays a JSON 404 instead of becoming a
  // probe of the filesystem. Only a GET that no route claimed may look at `public/`.

  try {
    // The one binary-body route in the whole API, so it is resolved before `readBody` ever
    // gets to treat the bytes as UTF-8 JSON — that would corrupt a PNG (see readRawBody).
    const screenshotUpload = req.method === "POST" ? SCREENSHOT_UPLOAD_RE.exec(bare) : null;
    const uploadId = screenshotUpload?.[1];
    const uploadSide = screenshotUpload?.[2];
    if (uploadId && uploadSide) {
      let raw: Buffer;
      try {
        raw = await readRawBody(req, MAX_SCREENSHOT_BYTES);
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "payload_too_large", maxBytes: MAX_SCREENSHOT_BYTES }));
          return;
        }
        throw err;
      }
      const out = await handleScreenshotUpload(
        decodeURIComponent(uploadId),
        uploadSide as "before" | "after",
        req.headers["content-type"],
        raw,
      );
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body);
      return;
    }

    const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readBody(req);
    const out = await handle(req.method ?? "GET", path, body);

    if (out.status === 404 && req.method === "GET") {
      const asset = (await resolveScreenshotAsset(bare)) ?? (await resolvePublicAsset(bare));
      if (asset) {
        res.writeHead(200, { "content-type": asset.type });
        res.end(await readFile(asset.file));
        return;
      }
      if (SPA_ROUTES[bare]) {
        const shell = await resolvePublicAsset("/");
        if (shell) {
          res.writeHead(200, { "content-type": shell.type });
          res.end(await readFile(shell.file));
          return;
        }
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
   * `dist` is gitignored and only exists after `pnpm build`, so a fresh clone — or a checkout
   * where someone forgot — would otherwise serve nothing but 404s and a blank page. Say so
   * once, plainly, rather than leaving it to be diagnosed from an empty browser tab.
   *
   * A warning and not a refusal: the API, the webhook receiver and every endpoint work fine
   * without a frontend, and the e2e suite's API specs run against exactly that.
   */
  if (!existsSync(join(PUBLIC_DIR, "index.html"))) {
    console.warn(`no frontend build at ${PUBLIC_DIR} — run \`pnpm build\` (not needed in dev: \`pnpm dev\` serves the UI on :5173)`);
  }

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

  /*
   * Collect plan workspaces whose conversation is over. Before the projects check and keyed
   * on tickets rather than projects, because the case with nothing left to key on — a ticket
   * deleted, or its whole project deleted, while its planner was open — is exactly the one
   * that leaks a pane. `listTickets()` unfiltered is required: a label missing from that list
   * reads as deleted, so one project's tickets would sweep every other project's planners.
   *
   * A live conversation is spared, and the log says which, because Herdr keeps panes alive
   * across this restart and "still in backlog" is indistinguishable from "the user is typing
   * in it right now".
   */
  for (const d of await sweepPlanWorkspaces(listTickets())) {
    console.log(`  plan sweep ${d.close ? "closed" : "spared"} ${d.label}: ${d.reason}`);
  }
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
