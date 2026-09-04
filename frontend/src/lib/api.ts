import { ALL_PROJECTS } from "@/lib/board.ts";
import type { BoardResponse, Playbook, Project, Status, Ticket } from "@/types.ts";

/**
 * The board's whole HTTP seam: the two GETs it renders from, and the writes behind every
 * button that has one. Reject is still unwired, deliberately, so a bug there is a missing
 * function rather than a half-working button.
 *
 * Paths are relative on purpose. `vite.config.ts` proxies `/tickets` and `/projects` to the
 * backend in dev, and in production the backend serves the built bundle itself, so the board
 * is same-origin in both and no origin ever needs to be configured.
 */

/**
 * Real data is the default, and only the exact string "true" turns fixtures on — matching the
 * `VITE_DIAGNOSTICS` precedent. Deliberate: an unset or misspelled variable in a production
 * build must serve the real board rather than silently serving `mock.ts`, because fixtures that
 * look plausible are far harder to notice than a board that fails loudly.
 */
export const MOCK_MODE = import.meta.env["VITE_MOCK_MODE"] === "true";

/**
 * Every route answers a JSON envelope on failure — `{error, message?}` — and the code in
 * `error` is the part worth reading: `transition_has_side_effects` names a bug in the caller
 * (and carries the owning route in `message`), `not_in_backlog` names a race with a click that
 * already moved the ticket, `operation_in_flight` names a double-click. Dropping it would make
 * every failed write read as the same dead button.
 *
 * A body that is not that envelope — the dev proxy's own 404, an HTML error page — falls back
 * to the status text, so the throw still says something.
 */
async function failureDetail(response: Response): Promise<string> {
  let body: { error?: unknown; message?: unknown };
  try {
    body = (await response.json()) as { error?: unknown; message?: unknown };
  } catch {
    return response.statusText;
  }
  const code = typeof body.error === "string" ? body.error : null;
  const detail = typeof body.message === "string" ? body.message : null;
  if (code !== null && detail !== null) return `${code}: ${detail}`;
  return code ?? detail ?? response.statusText;
}

/**
 * One shape for every unusable response, so the malformed-body check in `getBoard` throws the
 * same sentence a bad status does: the method, the path, and what was wrong with the answer.
 * Two error styles for two ways of being unusable would only be two things to recognise in a
 * bug report.
 */
function requestFailed(method: string, path: string, detail: string): Error {
  return new Error(`${method} ${path} failed: ${detail}`);
}

/**
 * One request helper for reads and writes alike, so a failure reads the same either way: the
 * method, the path, the status and the backend's own error code. Returning a partial or empty
 * shape instead would surface much later as an undefined field in a component, with nothing
 * left to point at the request that actually failed.
 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!response.ok) {
    throw requestFailed(method, path, `${response.status} ${await failureDetail(response)}`);
  }
  return (await response.json()) as T;
}

/**
 * Why the coercion below exists, before it reads as redundant and gets deleted: `BoardResponse`
 * is a COMPILE-TIME claim about an unchecked boundary. Every one of those types is erased at
 * build — `verbatimModuleSyntax`, see the header of `types.ts` — so the annotation on
 * `request<T>` is a cast, not a parse, and nothing inspects the bytes `fetch` actually
 * returned. Downstream the claim is trusted literally: `TicketCard` reads
 * `ticket.taskBreakdown.length` with no guard, because the point of a shared type is that
 * components do not each re-check the wire. A null there throws inside a render, React unmounts
 * the tree, and `#root` is left empty — one unexpected field costs the whole board, not one
 * card.
 *
 * And an unexpected null here is a NORMAL state, not a corrupt server: a backend still running
 * a build from before these columns were persisted answers `playbook`, `taskBreakdown`,
 * `acceptanceCriteria` and `attachments` as null, while a client rebuilt from the current tree
 * types all four as present. Old server plus new client happens every time the API restarts a
 * beat later than Vite, and a whitescreen is not an acceptable way to find that out.
 *
 * So the response is made to match its own type once, here at the seam. Not thirty `?? []` in
 * thirty components — that is thirty chances to miss one, and it would give up exactly the
 * guarantee the shared type is for.
 *
 * Only fields the type declares NON-nullable are touched. `prState`, `prUrl`, `prNumber`,
 * `prAdditions`, `prDeletions`, `agentStatus`, `worktreePath`, `paneId`, `workspaceId`,
 * `startedAt` and both sides of `screenshots` are nullable in `backend/src/types.ts` and are
 * passed through exactly as they arrive: defaulting a real null would invent data the backend
 * never sent, which is a worse failure than the crash this prevents.
 */

/** The four the older backend can still answer as null, typed as it really sends them. */
type Mistyped = "playbook" | "taskBreakdown" | "acceptanceCriteria" | "attachments";
type WireTicket = Omit<Ticket, Mistyped> & { [K in Mistyped]: Ticket[K] | null };

/**
 * What a server that had the column would have sent: `tickets.playbook` is
 * `TEXT NOT NULL DEFAULT 'Fullstack'` in `backend/src/db.ts`, in the CREATE TABLE, in the
 * `addColumnIfMissing` migration and in the backfill for rows written while it was briefly
 * nullable. A literal checked against the union rather than `PLAYBOOKS[0]`, because the default
 * is that specific profile — not whichever one happens to be listed first, which reordering the
 * picker would silently change.
 */
const ABSENT_PLAYBOOK = "Fullstack" satisfies Playbook;

function normalizeTicket(ticket: WireTicket): Ticket {
  return {
    ...ticket,
    playbook: ticket.playbook ?? ABSENT_PLAYBOOK,
    taskBreakdown: ticket.taskBreakdown ?? [],
    acceptanceCriteria: ticket.acceptanceCriteria ?? [],
    attachments: ticket.attachments ?? [],
  };
}

/**
 * `ALL_PROJECTS` is the picker's sentinel, not a project id, so it is expressed by omitting the
 * query param — which is exactly how the backend spells "every project".
 */
export async function getBoard(projectId: string): Promise<BoardResponse> {
  const query = projectId === ALL_PROJECTS ? "" : `?project=${encodeURIComponent(projectId)}`;
  const path = `/tickets${query}`;
  const body = await request<unknown>("GET", path);
  // A 200 that is not the envelope at all — the dev proxy's HTML, something else answering on
  // the port — fails here, like a bad status does. Left to reach a component it would instead
  // be a TypeError in a render, with the request that produced it long gone from the stack.
  if (typeof body !== "object" || body === null) {
    throw requestFailed("GET", path, "malformed board: body is not an object");
  }
  const { tickets, unowned } = body as { tickets?: unknown; unowned?: unknown };
  if (!Array.isArray(tickets)) {
    throw requestFailed("GET", path, "malformed board: `tickets` is not an array");
  }
  return {
    tickets: (tickets as WireTicket[]).map(normalizeTicket),
    // `unowned` is the reconciler's output and a build that predates it omits the key
    // entirely; the empty list is what "no orphaned worktrees" already means.
    unowned: Array.isArray(unowned) ? unowned : [],
  };
}

export function getProjects(): Promise<Project[]> {
  return request<Project[]>("GET", "/projects");
}

/**
 * A new ticket always lands in `backlog` — `INSERT_TICKET` hardcodes the status, because a new
 * ticket is a raw idea. The three fields below are everything `createTicket` narrows.
 *
 * The response is the STORED ticket, not the board's `BoardTicket`, so only the one field the
 * caller actually needs is typed: the id, which is what lets a create be followed by a move.
 * Nothing renders from this — the board re-reads.
 */
export function createTicket(input: {
  projectId: string;
  title: string;
  description: string;
}): Promise<{ id: string }> {
  return request<{ id: string }>("POST", "/tickets", input);
}

/**
 * The two pure moves, `backlog -> todo` and `todo -> backlog`, and nothing else: the table in
 * `backend/src/transitions.ts` answers 409 `transition_has_side_effects` for a move that owns
 * a worktree, an agent or a pull request, naming the route that does own it.
 *
 * The route answers the moved ticket, and it is dropped: the board re-reads, and rendering a
 * single ticket from a write's response is how a card starts disagreeing with its column.
 */
export async function moveTicket(id: string, to: Status): Promise<void> {
  await request<unknown>("POST", `/tickets/${encodeURIComponent(id)}/status`, { to });
}

/**
 * Starts the planning agent: a workspace, a pane and an agent, created before the call
 * returns, which is why the button that calls this has to show it is working.
 *
 * The ticket is NOT modified — Plan never changes status, and the planner writes its task
 * breakdown and acceptance criteria back by PATCHing the ticket itself. So there is nothing in
 * the response to render, and the poll is what surfaces the new agent.
 */
export async function startPlanning(id: string): Promise<void> {
  await request<unknown>("POST", `/tickets/${encodeURIComponent(id)}/plan`);
}

/**
 * Starts the implementation agent: `todo -> in_progress`, and the worktree, branch, port block
 * and agent are all created before the call answers. Two failures are its own and both must
 * reach the card — `409 not_in_todo` when the ticket moved underneath the click, and
 * `409 port_pool_exhausted` when every slot in the pool is held — because the server hands the
 * claim back to `todo` in both cases, so the only trace left is the message.
 */
export async function spawnAgent(id: string): Promise<void> {
  await request<unknown>("POST", `/tickets/${encodeURIComponent(id)}/spawn`);
}

/**
 * Accepts the work: `in_review -> done`, pushing the branch and opening the pull request before
 * it answers. The push or the PR call failing rolls the claim back to `in_review`, so the
 * refresh that follows a success is exactly what must NOT happen on failure — the card would
 * otherwise read as accepted with no pull request behind it.
 */
export async function acceptTicket(id: string): Promise<void> {
  await request<unknown>("POST", `/tickets/${encodeURIComponent(id)}/accept`);
}

/**
 * Discards the attempt: stops the agent and closes its pane, force-removes the worktree,
 * deletes the branch and the transcript, and returns the ticket to `todo`. Everything the
 * agent did is thrown away and this cannot be undone — see the confirm dialog this backs.
 */
export async function cancelTicket(id: string): Promise<void> {
  await request<unknown>("POST", `/tickets/${encodeURIComponent(id)}/cancel`);
}

/**
 * Stops the running agent and closes its pane, force-removes the worktree directory and
 * deletes the transcript. The branch and its commits are kept.
 */
export async function deleteWorktree(id: string): Promise<void> {
  await request<unknown>("DELETE", `/tickets/${encodeURIComponent(id)}/worktree`);
}

/**
 * Stops the agent, removes the worktree, and deletes the branch and the transcript. The
 * server refuses to delete a ticket whose pull request is still open.
 */
export async function deleteTicket(id: string): Promise<void> {
  await request<unknown>("DELETE", `/tickets/${encodeURIComponent(id)}`);
}

/**
 * Hides the ticket from the board for good, after stopping the agent, force-removing the
 * worktree, deleting the branch and the transcript — the same teardown depth as Cancel.
 * There is no un-archive.
 */
export async function archiveTicket(id: string): Promise<void> {
  await request<unknown>("POST", `/tickets/${encodeURIComponent(id)}/archive`);
}
