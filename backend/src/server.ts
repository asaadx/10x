/**
 * HTTP surface. This module owns routing, the agent poller, and the per-process state that is
 * deliberately not persisted (operations in flight, running Previews); every other concern
 * lives in its own module.
 *
 * Two things keep the board honest:
 *
 *  - Ticket status transitions go through `claimTicket`, a conditional UPDATE. The status
 *    IS the lock (memory/operations.md): claim first, work second, and a concurrent request loses rather
 *    than queueing, so a double-click cannot start two sessions.
 *
 *  - Agents run as Claude Code cloud sessions whose status nothing can read
 *    (docs/prototype-cloud.md). So the agent writes its own state into the ticket row, the board
 *    reads the row, and the poller below turns an agent's `done` into the move to review. The
 *    board read is a pure database read: there is no second source of truth to join against.
 */
// FIRST IMPORT, AND THE POSITION IS LOAD-BEARING. This one loads the repo-root `.env`, and
// ESM evaluates imports in order: `db.ts` below reads `STATE_DIR`, `DB_PATH` and
// `TURSO_DATABASE_URL` at module load to pick its driver, so an `./env.ts` moved beneath it
// would read the defaults and silently use `~/.10x/10x.db` instead of the configured store —
// no error, just the wrong database. `env.test.ts` fails if this line stops being the first import.
import "./env.ts";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, realpath, rm, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { cloudDriverFromEnv } from "./cloud.ts";
import { startPoller } from "./poller.ts";
import { previewFor, startPreview, stopAllPreviews, stopPreview, sweepPreviews } from "./preview.ts";
import { sessionMessage } from "./prompts.ts";
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
  claimTicketWith,
  db,
  initDb,
  nowIso,
  releaseAllPortSlots,
  releasePortSlot,
  reservePortSlot,
  settleFinishedAgents,
  setPullRequest,
  setPullRequestState,
  STATE_DIR,
} from "./db.ts";
import { isTransitionStatus, planStatusMove, STATUSES } from "./transitions.ts";
import type { BoardResponse, BoardTicket, Project, Ticket } from "./types.ts";
import {
  fetchPullRequestSnapshot,
  fetchRepoMetadata,
  markPullRequestReady,
  needsLiveCheck,
  openPullRequest,
  parseRemote,
  pullRequestUpdate,
  GitHubApiError,
  type PullRequest,
  type PullRequestSnapshot,
} from "./github.ts";
import { blockFor } from "./ports.ts";

const PORT = Number(process.env.PORT ?? 4010);
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

/** Tickets with an operation in flight. Rejecting beats queueing: the conflict stays visible. */
const inFlight = new Set<string>();

/**
 * The only thing that talks to `claude`. Built once, at load: a typo in `CLOUD_DRIVER` must
 * stop the board from booting rather than surface as a 500 on the first Start click.
 */
const cloud = cloudDriverFromEnv(db);

/**
 * How often the poller reads the store. Five seconds: an agent's run is minutes long, so the
 * extra latency before a card moves is noise, while against Turso every tick is a network
 * round trip that a one-second loop would multiply by five for nothing.
 */
// `||`: an empty `AGENT_POLL_MS=` line in `.env` means "use the default", not zero.
const AGENT_POLL_MS = Number(process.env.AGENT_POLL_MS || 5000);
if (!Number.isFinite(AGENT_POLL_MS) || AGENT_POLL_MS <= 0) {
  throw new Error(`AGENT_POLL_MS must be a positive number, got "${process.env.AGENT_POLL_MS}"`);
}
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
      await setProvisionState(projectId, "failed", "GITHUB_TOKEN is not set, so the repo cannot be cloned");
      return;
    }
    const project = await getProject(projectId);
    if (project === undefined) return;

    await setProvisionState(projectId, "cloning");
    const outcome = await provisionProject(project, {
      token,
      seedInitialCommit,
      ...(await seedIdentity(token)),
    });
    await setProvisionState(projectId, outcome.ok ? "ready" : "failed", outcome.ok ? "" : outcome.message);
  } catch (err) {
    // A throw here is a bug rather than an expected failure, but leaving the row on `cloning`
    // forever would be worse than reporting it: that state disables Start with no way out.
    await setProvisionState(projectId, "failed", err instanceof Error ? err.message : String(err));
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
 * Reconcile cache for PR state: a ticket's PR is asked about live at most once per TTL window.
 * Keyed by ticket id, like `inFlight`. ~60s matches memory/github.md's own estimate for how
 * fresh an open-PR read needs to be.
 *
 * This runs from the POLLER, not from the board read, so `GET /tickets` stays a pure database
 * read (docs/prototype-cloud.md). It matters more now than it did: the cloud agent opens its
 * own draft PR and writes only `pr_number`/`pr_url`, so nothing else ever fills in the PR's
 * state or ±LOC unless a webhook happens to be forwarded.
 *
 * Tradeoff accepted: a merge or close between two checks of the same ticket is invisible until
 * the next one — up to PR_CHECK_TTL_MS stale.
 */
const PR_CHECK_TTL_MS = 60_000;
const prLastChecked = new Map<string, number>();

type Reply = { status: number; body: string };
const json = (body: unknown, status = 200): Reply => ({
  status,
  body: JSON.stringify(body),
});

/** Resolve a ticket and its project together — every lifecycle route needs both. */
async function resolve(id: string): Promise<{ ticket: Ticket; project: Project } | Reply> {
  const ticket = await getTicket(id);
  if (!ticket) return json({ error: "no_such_ticket", id }, 404);
  const project = await getProject(ticket.projectId);
  if (!project) return json({ error: "no_such_project", id: ticket.projectId }, 404);
  return { ticket, project };
}

const isReply = (x: object): x is Reply => "status" in x && "body" in x;

/**
 * Fail-open, unlike the delete guard's live read: this is a display concern, not an
 * irreversible-action gate. A missing token or a failed fetch leaves whatever the DB already
 * has in place — never thrown, never lets one bad ticket stall the poller. Every check runs
 * concurrently.
 */
async function reconcilePullRequests(now: number): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return;
  const tickets = await listTickets();
  const due = tickets.filter(
    (t) => t.prNumber !== null && needsLiveCheck(t.prState) && (prLastChecked.get(t.id) ?? 0) + PR_CHECK_TTL_MS <= now,
  );
  if (due.length === 0) return;
  const byId = new Map((await listProjects()).map((p) => [p.id, p]));
  await Promise.all(
    due.map(async (t) => {
      prLastChecked.set(t.id, now);
      const project = byId.get(t.projectId);
      if (!project || t.prNumber === null || !t.prUrl) return;
      try {
        const snapshot = await fetchPullRequestSnapshot(project, t.prNumber, token);
        await setPullRequestState(t.prUrl, snapshot.state, snapshot.additions, snapshot.deletions);
      } catch (err) {
        console.warn(`[${t.id}] PR state reconcile failed; the board keeps the stored value:`, err);
      }
    }),
  );
}

/**
 * One poll: move every ticket whose agent reported `done` to review, then refresh PR states
 * that are due. The move is first because it is what a human is waiting on; a slow GitHub
 * must never delay it.
 */
async function pollTick(): Promise<void> {
  for (const id of await settleFinishedAgents()) console.log(`[${id}] agent reported done → in_review`);
  await reconcilePullRequests(Date.now());
}

/**
 * A pure database read. Everything about the agent is already in the row (the board wrote the
 * session, the agent wrote its state), so the only things resolved here are this process's own:
 * whether an operation is in flight, and the ticket's running Preview.
 */
async function board(projectFilter: string | undefined): Promise<Reply> {
  const tickets = await listTickets(projectFilter);
  // The `: BoardTicket` annotation is the point of types.ts: this object literal is the wire
  // format, and without it a field added or dropped here diverges from the frontend silently.
  const live = tickets.map((t): BoardTicket => ({ ...t, busy: inFlight.has(t.id), preview: previewFor(t.id) }));
  const payload: BoardResponse = { tickets: live };
  return json(payload);
}

/**
 * The live PR guard shared by ticket delete, project delete and archive. `prState` is null
 * whenever no webhook or poll has reached it — the common case — so a guard reading only the
 * column would fail open exactly when it matters. Anything non-terminal is read live, and an
 * unreadable state fails CLOSED, because every caller is about to do something irreversible.
 */
async function openPullRequestGuard(ticket: Ticket, project: Project, verb: string): Promise<Reply | null> {
  if (ticket.prNumber === null || !needsLiveCheck(ticket.prState)) return null;
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    return json(
      { error: "pr_state_unknown", message: `GITHUB_TOKEN is not set; the PR state cannot be verified before ${verb}` },
      409,
    );
  }
  let live: PullRequestSnapshot;
  try {
    live = await fetchPullRequestSnapshot(project, ticket.prNumber, token);
  } catch (err) {
    return json({ error: "pr_state_unknown", message: err instanceof Error ? err.message : String(err) }, 409);
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
  // Persist the freshly-read terminal state: the recovery path for a merge/close event missed
  // while webhook forwarding was down.
  if (ticket.prUrl) await setPullRequestState(ticket.prUrl, live.state, live.additions, live.deletions);
  return null;
}

/**
 * Tell a running session its ticket is gone. Best-effort by design: there is no CLI to stop a
 * cloud session (docs/prototype-cloud.md), so this polite message is all 10x can do, and a
 * failure to deliver it must not fail the cancel or delete the user asked for. The prompt tells
 * the agent to write nothing more once it reads this.
 */
async function tellSessionCancelled(ticket: Ticket): Promise<boolean> {
  if (!ticket.sessionId) return false;
  try {
    await cloud.sendMessage(ticket.sessionId, "Ticket cancelled — stop work now. Do not push and do not write to the 10x database again.");
    return true;
  } catch (err) {
    console.warn(`[${ticket.id}] could not tell session ${ticket.sessionId} it was cancelled:`, err);
    return false;
  }
}

/** Stop a ticket's Preview and free its port block. Safe to call when there is none. */
async function endPreview(ticket: Ticket, project: Project | undefined): Promise<boolean> {
  try {
    return await stopPreview(ticket.id, STATE_DIR, project?.repoPath);
  } finally {
    await releasePortSlot(ticket.id);
  }
}

/** The fields a cloud session leaves on the row, cleared together so none outlives the rest. */
const CLEARED_SESSION = {
  session_id: null,
  session_url: null,
  session_kind: null,
  agent_state: null,
  agent_note: null,
  agent_updated_at: null,
  run_token: null,
} as const;

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
 * Refuse if any ticket still has an open pull request — the same live guard the ticket route
 * uses — then tell every running session its ticket is gone, stop every Preview, and finally
 * remove the clone. Cloud sessions themselves cannot be stopped from here (there is no CLI
 * for it); the message is the most 10x can do, and the user archives them in claude.ai.
 */
async function deleteProjectCompletely(id: string): Promise<Reply> {
  const project = await getProject(id);
  if (project === undefined) {
    return json({ error: "project_not_found", field: "id", message: `no project with id "${id}"` }, 404);
  }
  // Archived tickets are excluded from the session loop — archiving already ended their run —
  // but not from the Preview sweep below, which goes by every id the project ever had.
  const tickets = await listTickets(id);
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
          await setPullRequestState(ticket.prUrl, live.state, live.additions, live.deletions);
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

  // Past the point of refusal. A failure on one ticket must not abandon the rest, so they are
  // collected rather than thrown.
  const failures: string[] = [];
  for (const ticket of tickets) {
    inFlight.add(ticket.id);
    try {
      if (ticket.status === "in_progress" || ticket.sessionKind === "plan") await tellSessionCancelled(ticket);
    } finally {
      inFlight.delete(ticket.id);
    }
  }
  for (const ticketId of await listProjectTicketIds(id)) {
    try {
      await stopPreview(ticketId, STATE_DIR, project.repoPath);
    } catch (err) {
      failures.push(`${ticketId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await deleteProject(id);

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
  if (method === "GET" && path === "/projects") return json(await listProjects());

  // Before the /projects/:id match below, which would otherwise read "lookup" as a project id.
  if (method === "GET" && path.startsWith("/projects/lookup")) {
    const query = path.includes("?") ? new URLSearchParams(path.split("?")[1]) : undefined;
    return lookupRemote(query?.get("remote") ?? null);
  }

  if (method === "POST" && path === "/projects") {
    const r = await createProject(body);
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
    const project = await getProject(id);
    if (project === undefined) {
      return json({ error: "project_not_found", field: "id", message: `no project with id "${id}"` }, 404);
    }
    if (provisioning.has(id)) return json({ error: "operation_in_flight", id }, 409);
    const seed = (body as { seedInitialCommit?: unknown } | undefined)?.seedInitialCommit !== false;
    await runProvisioning(id, seed);
    return json(await getProject(id) ?? project);
  }

  const projectMatch = /^\/projects\/([^/?]+)$/.exec(path);
  if (projectMatch?.[1]) {
    const id = projectMatch[1];
    if (method === "PATCH") {
      const r = await updateProject(id, body);
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
    const r = await createTicket(body);
    return r.ok ? json(r.ticket, 201) : json(r.body, r.status);
  }

  // Always answers 2xx: GitHub retries a non-2xx, and a retry cannot fix a body we do not
  // recognise or a PR no ticket owns, so a 4xx would just buy repeated deliveries of the
  // same useless event. No signature check — see memory/github.md.
  if (method === "POST" && path === "/webhooks/github") {
    const update = pullRequestUpdate(body);
    if (!update) return json({ ok: true, ignored: true });
    const matched = await setPullRequestState(update.url, update.state, update.additions, update.deletions);
    return json({ ok: true, matched });
  }

  const m = /^\/tickets\/([^/]+)(\/spawn|\/cancel|\/status|\/accept|\/reject|\/plan|\/archive|\/preview)?$/.exec(path);
  if (!m?.[1]) return json({ error: "not_found", path }, 404);
  const id = decodeURIComponent(m[1]);
  const action = m[2];

  if (!action && method === "PATCH") {
    const r = await updateTicket(id, body);
    return r.ok ? json(r.ticket) : json(r.body, r.status);
  }

  const found = await resolve(id);
  if (isReply(found)) return found;
  const { ticket, project } = found;

  if (inFlight.has(id)) return json({ error: "operation_in_flight", id }, 409);

  // Before any claim, so a refusal never moves the ticket. `claude --cloud` runs in the
  // project's local clone and Preview checks a branch out of it, so all three need the clone
  // on disk. Refusing here is what lets the board disable the button with an explanation.
  if ((action === "/spawn" || action === "/plan" || action === "/preview") && method === "POST") {
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
    // A ticket with an open PR still points a live GitHub review at its branch, so the delete
    // is refused until that PR is merged or closed.
    const refused = await openPullRequestGuard(ticket, project, "deleting");
    if (refused) return refused;

    inFlight.add(id);
    try {
      if (ticket.status === "in_progress" || ticket.sessionKind === "plan") await tellSessionCancelled(ticket);
      await endPreview(ticket, project);
      return json(await deleteTicket(id));
    } finally {
      inFlight.delete(id);
    }
  }

  if (action === "/plan" && method === "POST") {
    /*
     * Plan is the `backlog -> todo` conversation, so it belongs to backlog and nowhere else:
     * a planner shaping a ticket that is already being implemented would be rewriting the brief
     * under a running agent. It never claims the ticket — promoting is a human clicking the
     * button — so `inFlight` (checked above) is the whole concurrency guard.
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

    // Idempotent: the conversation already exists in claude.ai, with the human's answers in
    // it. A second click must lead back there, not start a rival planner that knows nothing.
    if (ticket.sessionKind === "plan" && ticket.sessionId && ticket.sessionUrl && ticket.agentState !== "failed") {
      return json({ ok: true, reused: true, sessionId: ticket.sessionId, sessionUrl: ticket.sessionUrl });
    }

    inFlight.add(id);
    try {
      const runToken = randomUUID();
      await setRunFields(id, {
        sessionKind: "plan",
        agentState: "starting",
        sessionId: null,
        sessionUrl: null,
        agentNote: null,
        runToken,
      });
      try {
        const session = await cloud.startSession({
          cwd: project.repoPath,
          baseBranch: project.baseBranch,
          message: await sessionMessage("plan", ticket, project, runToken),
          title: `Plan ${ticket.id}: ${ticket.title}`,
        });
        await setRunFields(id, { sessionId: session.sessionId, sessionUrl: session.sessionUrl });
        return json({ ok: true, reused: false, ...session });
      } catch (err) {
        await setRunFields(id, { sessionKind: null, agentState: null, sessionId: null, sessionUrl: null, runToken: null });
        return json({ error: "session_start_failed", message: err instanceof Error ? err.message : String(err) }, 502);
      }
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
    // In Progress with no session behind it, so the refusal names the route that owns the move.
    const plan = planStatusMove(ticket.status, to);
    if (!plan.ok) {
      return json({ error: plan.error, message: plan.message, from: ticket.status, to, owner: plan.owner }, 409);
    }

    // There is no work to do after the claim — that is what makes the move pure — but the CAS
    // is still what resolves two concurrent moves to one winner (memory/operations.md).
    if (!await claimTicket(id, ticket.status, to)) {
      return json({ error: "not_in_status", expected: ticket.status, status: (await getTicket(id))?.status ?? null }, 409);
    }
    return json(await getTicket(id));
  }

  if (action === "/spawn" && method === "POST") {
    /*
     * Claim first, work second (memory/operations.md), and the session columns change in the
     * SAME statement as the status. A leftover `agent_state = 'done'` from an earlier session
     * sitting next to `in_progress` for even one poll would move the ticket straight to review.
     * `started_at` is stamped here, where the claim is won, because it is the run timer.
     */
    const runToken = randomUUID();
    const claimed = await claimTicketWith(id, "todo", "in_progress", {
      ...CLEARED_SESSION,
      run_token: runToken,
      session_kind: "impl",
      agent_state: "starting",
      finished: 0,
      died: 0,
      started_at: nowIso(),
    });
    if (!claimed) return json({ error: "not_in_todo", status: ticket.status }, 409);

    inFlight.add(id);
    try {
      const session = await cloud.startSession({
        cwd: project.repoPath,
        baseBranch: project.baseBranch,
        message: await sessionMessage("impl", ticket, project, runToken),
        title: `${ticket.id}: ${ticket.title}`,
      });
      // Only the session columns: the agent may already have written `working`, and this must
      // not clobber it back to `starting`.
      await setRunFields(id, { sessionId: session.sessionId, sessionUrl: session.sessionUrl });
      return json({ ok: true, ...session });
    } catch (err) {
      // Hand the claim back and leave no half-started session on the row. If the CLI started a
      // session and then failed to report it, that session is invisible to us — the error
      // carries the CLI's own output so the human can find it in claude.ai.
      await claimTicketWith(id, "in_progress", "todo", { ...CLEARED_SESSION, started_at: null });
      return json({ error: "session_start_failed", message: err instanceof Error ? err.message : String(err) }, 502);
    } finally {
      inFlight.delete(id);
    }
  }

  if (action === "/cancel" && method === "POST") {
    // "Discard this attempt": the session fields and the branch the agent reported are cleared
    // with the claim. The branch itself stays on GitHub (nothing here can delete it), and any
    // PR the agent opened is kept on the row so the delete guard still sees it.
    const claimed = await claimTicketWith(id, "in_progress", "todo", {
      ...CLEARED_SESSION,
      branch: null,
      finished: 0,
      died: 0,
    });
    if (!claimed) return json({ error: "not_in_progress", status: ticket.status }, 409);
    inFlight.add(id);
    try {
      await endPreview(ticket, project);
      const messaged = await tellSessionCancelled(ticket);
      return json({ ok: true, messaged });
    } finally {
      inFlight.delete(id);
    }
  }

  if (action === "/accept" && method === "POST") {
    // Nothing to publish: the agent never reported a PR, nor a branch to open one from.
    if (ticket.prNumber === null && !ticket.branch) {
      return json({ error: "no_branch", id }, 409);
    }

    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      return json({ error: "missing_github_token", message: "GITHUB_TOKEN is not set" }, 500);
    }

    // Claim first, work second (memory/operations.md): the status IS the lock.
    if (!await claimTicket(id, "in_review", "done")) {
      return json({ error: "not_in_review", status: ticket.status }, 409);
    }

    inFlight.add(id);
    try {
      let pr: PullRequest;
      try {
        // The agent's own draft PR is the normal case: Accept is the human saying "ready".
        // Only an agent that pushed but never opened one falls back to opening it here — from
        // the branch it already pushed, so there is nothing to push locally.
        pr =
          ticket.prNumber !== null
            ? await markPullRequestReady(project, ticket.prNumber, token)
            : await openPullRequest(
                project,
                {
                  branch: ticket.branch ?? "",
                  base: project.baseBranch,
                  title: ticket.title,
                  description: ticket.description,
                  ticketId: ticket.id,
                },
                token,
              );
        await setPullRequest(id, pr.number, pr.url);
        await setPullRequestState(pr.url, pr.state, pr.additions, pr.deletions);
      } catch (err) {
        // Hand the claim back: a ticket sitting in Done with no ready PR is worse than a visible
        // failure. The message is already redacted by github.ts.
        await claimTicket(id, "done", "in_review");
        return json({ error: err instanceof Error ? err.message : String(err) }, 502);
      }
      return json(await getTicket(id));
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

    // A rejection is a follow-up message into the session that did the work, so there has to
    // be one — the only session that can address the reason is the one holding the context.
    if (!ticket.sessionId) return json({ error: "no_session", id }, 409);

    // `agent_state = 'working'` in the same statement as the claim, or the poller could see
    // the old `done` next to `in_progress` and undo the rejection (db.ts `claimTicketWith`).
    const claimed = await claimTicketWith(id, "in_review", "in_progress", { agent_state: "working", finished: 0 });
    if (!claimed) return json({ error: "not_in_review", status: ticket.status }, 409);

    inFlight.add(id);
    try {
      const text = [
        "TICKET REJECTED: this work was sent back from review. The reason is below.",
        "",
        reason,
        "",
        "Set agent_state to working first, address this on the same branch, push to the same pull",
        "request, update agent_note, and report agent_state done as your very last action.",
      ].join("\n");
      try {
        await cloud.sendMessage(ticket.sessionId, text);
      } catch (err) {
        // Hand the claim back, with the agent's own last report restored: a ticket left in In
        // Progress whose agent never heard the rejection is a silent dead end.
        await claimTicketWith(id, "in_progress", "in_review", {
          agent_state: ticket.agentState,
          finished: ticket.finished ? 1 : 0,
        });
        return json({ error: "prompt_failed", message: err instanceof Error ? err.message : String(err) }, 409);
      }
      return json(await getTicket(id));
    } finally {
      inFlight.delete(id);
    }
  }

  if (action === "/archive" && method === "POST") {
    // Archive only ever fires from Done — refused here rather than trusting the frontend.
    if (ticket.status !== "done") {
      return json(
        { error: "not_done", message: `archive only applies to Done tickets; this one is ${ticket.status}`, status: ticket.status },
        409,
      );
    }
    // A Done ticket with no recorded PR cannot be verified safe to hide, so that is refused too.
    if (ticket.prNumber === null) {
      return json(
        { error: "pr_state_unknown", message: "this ticket has no recorded pull request, so archiving cannot be verified safe" },
        409,
      );
    }
    const refused = await openPullRequestGuard(ticket, project, "archiving");
    if (refused) return refused;

    inFlight.add(id);
    try {
      await endPreview(ticket, project);
      await archiveTicket(id);
      return json(await getTicket(id));
    } finally {
      inFlight.delete(id);
    }
  }

  if (action === "/preview" && method === "POST") {
    // The branch is the one the agent reported pushing; before it reports one there is
    // nothing on GitHub to fetch.
    if (!ticket.branch) return json({ error: "no_branch", id }, 409);
    const reserved = await reservePortSlot(id);
    if (!reserved.ok) {
      return json(
        {
          error: "port_pool_exhausted",
          cap: reserved.cap,
          message: `all ${reserved.cap} port slots are in use; stop a Preview or raise MAX_PORT_SLOTS`,
        },
        409,
      );
    }
    inFlight.add(id);
    try {
      const preview = await startPreview({
        ticketId: id,
        repoPath: project.repoPath,
        branch: ticket.branch,
        devCommand: project.devCommand,
        block: blockFor(reserved.slot),
        stateDir: STATE_DIR,
      });
      return json(preview);
    } catch (err) {
      await endPreview(ticket, project).catch(() => undefined);
      return json({ error: "preview_failed", message: err instanceof Error ? err.message : String(err) }, 500);
    } finally {
      inFlight.delete(id);
    }
  }

  if (action === "/preview" && method === "DELETE") {
    inFlight.add(id);
    try {
      const stopped = await endPreview(ticket, project);
      return json({ ok: true, stopped });
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

// Schema and migrations before the first request can arrive: every handler assumes a migrated
// store, and against Turso this is network I/O that must not hide inside a module import.
await initDb();

/*
 * Every held port block is residue: blocks are held only by Previews, and Previews live in this
 * process's memory, so none survives a restart (db.ts `releaseAllPortSlots`). Their checkouts
 * are residue for the same reason — the directory goes, and each clone forgets the worktree
 * registration so the next Preview at that path is not refused.
 */
{
  const released = await releaseAllPortSlots();
  if (released > 0) console.log(`  released ${released} port slot(s) left by a previous run`);
  await sweepPreviews(STATE_DIR, (await listProjects()).map((p) => p.repoPath));
}

const server = createServer(async (req, res) => {
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
});

const poller = startPoller(pollTick, AGENT_POLL_MS);
server.on("close", () => {
  void poller.stop();
});

/*
 * Previews run in their own process groups (preview.ts), so a signal aimed at the board does
 * not reach them — which is right for Ctrl-C hygiene and wrong for shutdown. Stop them
 * explicitly, or every restart leaves a dev server squatting on a port block the next boot
 * believes is free.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: stopping previews and the poller`);
  server.close();
  await Promise.allSettled([poller.stop(), stopAllPreviews(STATE_DIR)]);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

server.listen(PORT, async () => {
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

  const projects = await listProjects();
  if (projects.length === 0) {
    console.log("no projects yet — add one from the board");
    return;
  }
  for (const p of projects) console.log(`  ${p.id} → ${p.repoPath}`);
});
