import { ALL_PROJECTS } from "@/lib/board.ts";
import { MOCK_PROJECTS, MOCK_TICKETS } from "@/mock.ts";
import type { BoardResponse, Playbook, Priority, Project, Status, Ticket } from "@/types.ts";

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
 *
 * The parsed body is handed back as well, because one refusal is data rather than a sentence:
 * `pr_open` names the pull requests blocking a project delete, and the dialog links each one.
 */
async function failureDetail(response: Response): Promise<{
  detail: string;
  code: string | null;
  body: unknown;
}> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { detail: response.statusText, code: null, body: null };
  }
  const envelope = typeof body === "object" && body !== null ? body : {};
  const code = "error" in envelope && typeof envelope.error === "string" ? envelope.error : null;
  const detail = "message" in envelope && typeof envelope.message === "string" ? envelope.message : null;
  return {
    detail: code !== null && detail !== null ? `${code}: ${detail}` : (code ?? detail ?? response.statusText),
    code,
    body,
  };
}

/**
 * Same shape as the backend's `GitHubApiError`: a caller that has to *branch* on a refusal
 * switches on `code`, never on message text. `body` carries the whole envelope for the one
 * refusal that says more than a sentence; both are null for a response that was never the
 * envelope at all.
 */
export class RequestError extends Error {
  readonly code: string | null;
  readonly body: unknown;

  constructor(message: string, code: string | null, body: unknown) {
    super(message);
    this.name = "RequestError";
    this.code = code;
    this.body = body;
  }
}

/**
 * One shape for every unusable response, so the malformed-body check in `getBoard` throws the
 * same sentence a bad status does: the method, the path, and what was wrong with the answer.
 * Two error styles for two ways of being unusable would only be two things to recognise in a
 * bug report.
 */
function requestFailed(
  method: string,
  path: string,
  detail: string,
  code: string | null = null,
  body: unknown = null,
): RequestError {
  return new RequestError(`${method} ${path} failed: ${detail}`, code, body);
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
    const { detail, code, body: envelope } = await failureDetail(response);
    throw requestFailed(method, path, `${response.status} ${detail}`, code, envelope);
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

/** The five the older backend can still answer as null, typed as it really sends them. */
type Mistyped = "playbook" | "priority" | "taskBreakdown" | "acceptanceCriteria" | "attachments";
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

/** Same reasoning as `ABSENT_PLAYBOOK`: `tickets.priority` defaults to `'low'`, never absent. */
const ABSENT_PRIORITY = "low" satisfies Priority;

function normalizeTicket(ticket: WireTicket): Ticket {
  return {
    ...ticket,
    playbook: ticket.playbook ?? ABSENT_PLAYBOOK,
    priority: ticket.priority ?? ABSENT_PRIORITY,
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

/**
 * Saves edits made in the ticket sheet. Any subset of these fields may be sent; the server
 * accepts a partial update and returns the full ticket back.
 */
export async function updateTicket(
  id: string,
  fields: {
    title?: string;
    description?: string;
    playbook?: Playbook;
    priority?: Priority;
    taskBreakdown?: { text: string; done: boolean }[];
    acceptanceCriteria?: { text: string; done: boolean }[];
  },
): Promise<Ticket> {
  return request<Ticket>("PATCH", `/tickets/${encodeURIComponent(id)}`, fields);
}

/**
 * Sends the reason back to the still-live agent and returns the ticket to In Progress.
 * Nothing is deleted — the worktree, branch and agent all survive, exactly as they were.
 */
export async function rejectTicket(id: string, reason: string): Promise<void> {
  await request<unknown>("POST", `/tickets/${encodeURIComponent(id)}/reject`, { reason });
}

/**
 * Adding a project is three typed fields and one admission test: `GET /projects/lookup` proves
 * the link parses, the repo exists and the token can read it, and hands back everything the
 * dialog would otherwise have had to ask for. `POST`, `PATCH` and `/provision` all answer the
 * bare `Project`, same as every other write on this seam — there is no `{project}` envelope to
 * unwrap.
 */
export type RepoLookup = {
  owner: string;
  repo: string;
  /** The repo's *own* name and description, which prefill the two fields — not the project's. */
  name: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  /**
   * Zero commits, which makes `defaultBranch` a GitHub setting rather than a branch that
   * exists (memory/gotchas.md G8): the first ticket would die at worktree creation. This is
   * what the seed-commit offer in the dialog is for.
   */
  empty: boolean;
};

/**
 * A remote, not a path: the repo *is* the project's identity and 10x clones it itself, so
 * `owner`, `repo`, `repoPath` and `baseBranch` are all derived server-side. `id` is the
 * permanent slug; omitting it lets the server derive one with `deriveProjectSlug`.
 * `seedInitialCommit` is only honoured on a repo with no commits — the one time 10x writes to
 * a repo outside a ticket.
 */
export type CreateProjectInput = {
  remote: string;
  name: string;
  description: string;
  id?: string;
  seedInitialCommit?: boolean;
};

/** The three fields that stay editable. The slug and the repo are frozen at creation. */
export type UpdateProjectInput = {
  name?: string;
  description?: string;
  baseBranch?: string;
};

/** One of the still-open pull requests `409 pr_open` refuses a project delete with. */
export type OpenPullRequest = { ticketId: string; prNumber: number; prUrl: string };

/**
 * The two remote shapes `github.ts`'s own `parseRemote` accepts, and nothing else. The dialog
 * parses before it debounces, so a half-typed URL costs no request and a non-GitHub host is
 * refused with a different sentence than "GitHub does not have that repo" — the reason for
 * that refusal is the board's finish line, not a limitation worth being vague about.
 */
const GITHUB_HTTPS_REMOTE = /^(?:https:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i;
const GITHUB_SSH_REMOTE = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i;

export function parseGithubRemote(remote: string): { owner: string; repo: string } | null {
  const raw = remote.trim().replace(/\/+$/, "");
  const match = GITHUB_HTTPS_REMOTE.exec(raw) ?? GITHUB_SSH_REMOTE.exec(raw);
  const [, owner, repo] = match ?? [];
  return owner === undefined || repo === undefined ? null : { owner, repo };
}

export function lookupRepo(remote: string): Promise<RepoLookup> {
  if (MOCK_MODE) return mockLookupRepo(remote);
  return request<RepoLookup>("GET", `/projects/lookup?remote=${encodeURIComponent(remote)}`);
}

/**
 * The project row lands immediately, `pending`, and the clone runs behind it: a large repo
 * takes minutes and filling the backlog does not need the code, so the dialog closes on this
 * response rather than on the download. Only Start waits for `ready`.
 */
export async function createProject(input: CreateProjectInput): Promise<Project> {
  if (MOCK_MODE) return mockCreateProject(input);
  // The bare row, not `{ project }`: every other write on this seam answers with the resource
  // itself — `POST /tickets` returns the Ticket, `GET /projects` returns `Project[]`.
  return request<Project>("POST", "/projects", input);
}

/**
 * Name, description and base branch. `id`, `owner`, `repo` and `repoPath` are deliberately not
 * accepted: the slug is in every branch and agent name the project has ever created, and work
 * already on disk carries the old value.
 */
export async function updateProject(id: string, patch: UpdateProjectInput): Promise<Project> {
  if (MOCK_MODE) return mockUpdateProject(id, patch);
  return request<Project>("PATCH", `/projects/${encodeURIComponent(id)}`, patch);
}

/**
 * Total cleanup: agents stopped, working copies and their unmerged branches removed, 10x's
 * downloaded copy of the repo deleted. Nothing on GitHub is touched.
 *
 * Refused with `pr_open` while any ticket in the project has an open pull request — deleting
 * the branch out from under a PR leaves whoever is reviewing it pointing at nothing. The list
 * of blocking PRs rides on the error; `openPullRequests` below reads it.
 */
export async function deleteProject(id: string): Promise<void> {
  if (MOCK_MODE) return mockDeleteProject(id);
  await request<unknown>("DELETE", `/projects/${encodeURIComponent(id)}`);
}

/** Retries a clone that failed, from the top. The project returns to `pending`. */
export async function provisionProject(id: string): Promise<Project> {
  if (MOCK_MODE) return mockProvisionProject(id);
  return request<Project>("POST", `/projects/${encodeURIComponent(id)}/provision`);
}

/**
 * `pr_open` is the one refusal a component renders as data rather than as a sentence: the fix
 * is on GitHub, so the dialog links each blocking PR instead of making you go and find it.
 * Narrowing the `unknown` belongs here at the seam, not in the dialog. Null means "not that
 * refusal"; an empty array means the refusal arrived without its list, which is a server bug
 * and still must not read as "nothing is blocking you".
 */
export function openPullRequests(error: unknown): OpenPullRequest[] | null {
  if (!(error instanceof RequestError) || error.code !== "pr_open") return null;
  const body = error.body;
  if (typeof body !== "object" || body === null || !("openPullRequests" in body)) return [];
  const list = body.openPullRequests;
  // Rendered as a link, so a half-shaped entry would show as `#undefined` rather than fail —
  // the one read in this file worth checking instead of casting.
  return Array.isArray(list) ? list.filter(isOpenPullRequest) : [];
}

function isOpenPullRequest(value: unknown): value is OpenPullRequest {
  if (typeof value !== "object" || value === null) return false;
  return (
    "ticketId" in value &&
    typeof value.ticketId === "string" &&
    "prNumber" in value &&
    typeof value.prNumber === "number" &&
    "prUrl" in value &&
    typeof value.prUrl === "string"
  );
}

/*
 * ── Mock mode ─────────────────────────────────────────────────────────────────────────────
 *
 * `use-board.ts` serves `mock.ts` as a static board and starts no timer, so mock mode has no
 * write path at all: without the store below the project dialog renders and then has nothing
 * to submit to, which defeats building the UI before the endpoints exist. Every write above
 * resolves against this instead of `fetch`, and refuses with the same coded `RequestError` a
 * real route would, so the dialog's error handling is the one it will ship with.
 *
 * Outcomes are driven by the repo name rather than by a hidden switch, so every state is
 * reachable from the field you are already typing in: `notfound`, `private`, `new`/`fresh`/
 * `empty`, `failclone`.
 */

const MOCK_LOOKUP_MS = 350;
const MOCK_CLONE_START_MS = 700;
const MOCK_CLONE_MS = 3000;

/** Whatever the mock lookup resolves is also what a mock clone ends up on. */
const MOCK_DEFAULT_BRANCH = "main";

/**
 * Replaced, never mutated in place: a changed array identity is the only signal a subscriber
 * has that the list moved, and it is what `useSyncExternalStore` compares.
 */
let mockSnapshot: Project[] = MOCK_PROJECTS;
const mockListeners = new Set<() => void>();

export const mockProjects = {
  list: (): Project[] => mockSnapshot,
  subscribe(listener: () => void): () => void {
    mockListeners.add(listener);
    return () => {
      mockListeners.delete(listener);
    };
  },
};

function publishMock(next: Project[]): void {
  mockSnapshot = next;
  for (const listener of mockListeners) listener();
}

/** Null when the project is gone — a clone that lands after a delete must not resurrect it. */
function patchMock(id: string, patch: Partial<Project>): Project | null {
  const current = mockSnapshot.find((project) => project.id === id);
  if (current === undefined) return null;
  const updated: Project = { ...current, ...patch, updatedAt: new Date().toISOString() };
  publishMock(mockSnapshot.map((project) => (project.id === id ? updated : project)));
  return updated;
}

/** The same envelope a real refusal carries, so `RequestError.code` reads the same in both modes. */
function mockRefusal(method: string, path: string, status: number, code: string, message: string): RequestError {
  return requestFailed(method, path, `${status} ${code}: ${message}`, code, { error: code, message });
}

/** Executor form because `Promise.withResolvers` is ES2024 and this build's lib is ES2023. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function mockLookupRepo(remote: string): Promise<RepoLookup> {
  await sleep(MOCK_LOOKUP_MS);
  const path = "/projects/lookup";
  const parsed = parseGithubRemote(remote);
  if (parsed === null) {
    throw mockRefusal("GET", path, 400, "invalid_remote", `${remote} is not a GitHub repo URL.`);
  }
  const repo = parsed.repo.toLowerCase();
  if (repo.includes("notfound")) {
    throw mockRefusal("GET", path, 404, "repo_not_found", `No repo at ${parsed.owner}/${parsed.repo}.`);
  }
  if (repo.includes("private")) {
    throw mockRefusal(
      "GET",
      path,
      403,
      "repo_not_accessible",
      `${parsed.owner}/${parsed.repo} exists but the token cannot see it.`,
    );
  }
  const empty = /new|fresh|empty/.test(repo);
  return {
    ...parsed,
    name: parsed.repo,
    // A brand-new repo has no description yet, which is also the case the dialog must not
    // prefill over.
    description: empty ? "" : "Everything I keep meaning to automate around the house.",
    defaultBranch: MOCK_DEFAULT_BRANCH,
    private: true,
    empty,
  };
}

async function mockCreateProject(input: CreateProjectInput): Promise<Project> {
  const parsed = parseGithubRemote(input.remote);
  if (parsed === null) {
    throw mockRefusal("POST", "/projects", 400, "invalid_remote", `${input.remote} is not a GitHub repo URL.`);
  }
  await sleep(MOCK_LOOKUP_MS);
  const now = new Date().toISOString();
  const project: Project = {
    // The dialog always sends the slug it showed you; the bare repo name is a stand-in for
    // `deriveProjectSlug`, which lives in the backend mock mode never reaches.
    id: input.id ?? parsed.repo.toLowerCase(),
    name: input.name,
    description: input.description,
    ...parsed,
    // Displayed, never read: mock mode never learns the real `$PROJECTS_ROOT`, and the dialog
    // shows the same `~/.10x/repos/<slug>` form.
    repoPath: `~/.10x/repos/${input.id ?? parsed.repo.toLowerCase()}`,
    baseBranch: MOCK_DEFAULT_BRANCH,
    // Anything created through this dialog is cloned by 10x, so it always owns the folder.
    ownsClone: true,
    provisionState: "pending",
    provisionError: "",
    devCommand: "",
    createdAt: now,
    updatedAt: now,
  };
  publishMock([...mockSnapshot, project]);
  runMockClone(project);
  return project;
}

/**
 * Deliberately not awaited by its caller: the response is the row, and the download runs
 * behind the closed dialog exactly as the real one does.
 */
function runMockClone(project: Project): void {
  setTimeout(() => {
    if (patchMock(project.id, { provisionState: "cloning" }) === null) return;
    setTimeout(() => {
      patchMock(
        project.id,
        /failclone/i.test(project.repo)
          ? {
              provisionState: "failed",
              provisionError:
                "Could not download the repo: the connection dropped partway through. Nothing was left behind — retry when you are ready.",
            }
          : { provisionState: "ready", provisionError: "" },
      );
    }, MOCK_CLONE_MS);
  }, MOCK_CLONE_START_MS);
}

async function mockUpdateProject(id: string, patch: UpdateProjectInput): Promise<Project> {
  await sleep(MOCK_LOOKUP_MS);
  const updated = patchMock(id, patch);
  if (updated === null) {
    throw mockRefusal("PATCH", `/projects/${id}`, 404, "project_not_found", `No project ${id}.`);
  }
  return updated;
}

async function mockDeleteProject(id: string): Promise<void> {
  await sleep(MOCK_LOOKUP_MS);
  if (!mockSnapshot.some((project) => project.id === id)) {
    throw mockRefusal("DELETE", `/projects/${id}`, 404, "project_not_found", `No project ${id}.`);
  }
  // The same refusal the real route answers, so the dialog's blocking-PR banner is reachable in
  // mock mode too — `jarvis-3` is the fixture built to exercise exactly this.
  const open = MOCK_TICKETS.filter((t) => t.projectId === id && t.prState === "open" && t.prNumber !== null);
  if (open.length > 0) {
    const path = `/projects/${id}`;
    const message =
      open.length === 1
        ? `PR #${open[0]?.prNumber} is still open — merge or close it on GitHub first`
        : `${open.length} pull requests are still open — merge or close them on GitHub first`;
    throw requestFailed(
      "DELETE",
      path,
      `409 pr_open: ${message}`,
      "pr_open",
      { error: "pr_open", message, openPullRequests: open.map((t) => ({ ticketId: t.id, prNumber: t.prNumber, prUrl: t.prUrl })) },
    );
  }
  publishMock(mockSnapshot.filter((project) => project.id !== id));
}

async function mockProvisionProject(id: string): Promise<Project> {
  await sleep(MOCK_LOOKUP_MS);
  const retried = patchMock(id, { provisionState: "pending", provisionError: "" });
  if (retried === null) {
    throw mockRefusal("POST", `/projects/${id}/provision`, 404, "project_not_found", `No project ${id}.`);
  }
  runMockClone(retried);
  return retried;
}
