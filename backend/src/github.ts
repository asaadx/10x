/**
 * The app's GitHub calls, made with `fetch` and `git` directly — no client class, no injected
 * transport. Publishing a ticket's branch as a pull request (push with a scoped token, then open
 * or adopt the PR), and the repo read that admits a project onto the board in the first place.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { PullRequestState } from "./types.ts";

const run = promisify(execFile);

export type PullRequest = { number: number; url: string; state: PullRequestState; additions: number | null; deletions: number | null };

/**
 * The push URL embeds the token, so a failed push puts the secret into an error
 * message, a log line, and (via openPullRequest) an HTTP response body. Every error
 * either exported async function throws passes through this first.
 */
export const redact = (text: string, token: string): string =>
  text.split(token).join("***").replace(/https:\/\/[^/@\s]+@/g, "https://***@");

/** Accepts `https://github.com/owner/repo(.git)?` and `git@github.com:owner/repo(.git)?`. */
export const parseRemote = (remoteUrl: string): { owner: string; repo: string } => {
  const https = remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  const ssh = remoteUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  const match = https ?? ssh;
  if (!match) throw new Error(`not a recognized GitHub remote: ${remoteUrl}`);
  const [, owner, repo] = match;
  if (!owner || !repo) throw new Error(`not a recognized GitHub remote: ${remoteUrl}`);
  return { owner, repo };
};

export const pullRequestBody = (description: string, ticketId: string): string =>
  `${description}\n\n10x opened this pull request for ticket ${ticketId}.`;

/**
 * Every call below takes `owner`/`repo` as arguments. They used to be re-derived by shelling
 * `git remote get-url origin` inside the repo on every push, PR open and PR read — a subprocess
 * per call to recover something the project row now stores. It also meant the project's GitHub
 * identity lived only on disk, so a repo whose remote was missing or non-GitHub failed here, at
 * the finish line, rather than when it was added.
 *
 * `repoPath` stays where git itself needs a working tree to push from; it is no longer where
 * the identity comes from.
 */
export const pushTicketBranch = async (
  repoPath: string,
  identity: { owner: string; repo: string },
  branch: string,
  token: string,
): Promise<void> => {
  try {
    const url = `https://x-access-token:${token}@github.com/${identity.owner}/${identity.repo}.git`;
    await run("git", ["push", url, `${branch}:${branch}`], { cwd: repoPath });
  } catch (error) {
    throw new Error(redact(String(error), token));
  }
};

/** Narrows an unknown JSON value's field, or returns undefined if it isn't the wanted type. */
function field<T>(value: unknown, key: string, isType: (v: unknown) => v is T): T | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return isType(raw) ? raw : undefined;
}
const stringField = (value: unknown, key: string): string | undefined =>
  field(value, key, (v): v is string => typeof v === "string");
const numberField = (value: unknown, key: string): number | undefined =>
  field(value, key, (v): v is number => typeof v === "number");

/**
 * GitHub's `merged` + `state` fields collapse to our three-value model. Every caller that reads
 * a PR resource — the create response, a single-PR fetch, and the `pull_request` webhook
 * payload, all the same shape — derives state exactly this way, so this is the one place that
 * does it.
 */
function pullRequestState(value: unknown): PullRequestState {
  const merged = field(value, "merged", (v): v is boolean => typeof v === "boolean");
  const rawState = stringField(value, "state");
  return merged === true ? "merged" : rawState === "closed" ? "closed" : "open";
}

function toPullRequest(value: unknown): PullRequest | undefined {
  const number = numberField(value, "number");
  const url = stringField(value, "html_url");
  if (number === undefined || url === undefined) return undefined;
  return {
    number,
    url,
    state: pullRequestState(value),
    additions: numberField(value, "additions") ?? null,
    deletions: numberField(value, "deletions") ?? null,
  };
}

/** True when a 422 from POST /pulls is GitHub's "a pull request already exists" complaint. */
function isAlreadyExistsError(body: unknown): boolean {
  const message = stringField(body, "message") ?? "";
  if (/already exists/i.test(message)) return true;
  if (typeof body !== "object" || body === null) return false;
  const errors = (body as Record<string, unknown>).errors;
  return Array.isArray(errors) && errors.some((entry) => /already exists/i.test(stringField(entry, "message") ?? ""));
}

/**
 * Opens the PR, or — if one already exists for this head (a retry after a partial
 * failure) — adopts it. Adopting is correct behaviour here, not an error path.
 */
export const openPullRequest = async (
  identity: { owner: string; repo: string },
  spec: { branch: string; base: string; title: string; description: string; ticketId: string },
  token: string,
): Promise<PullRequest> => {
  const { owner, repo } = identity;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  const body = {
    head: spec.branch,
    base: spec.base,
    title: spec.title,
    body: pullRequestBody(spec.description, spec.ticketId),
  };

  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const parsed: unknown = await response.json();

  if (response.status === 201) {
    const pr = toPullRequest(parsed);
    if (!pr) throw new Error(redact(`GitHub returned an unrecognized pull request: ${JSON.stringify(parsed)}`, token));
    return pr;
  }

  if (response.status === 422 && isAlreadyExistsError(parsed)) {
    const existing = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${spec.branch}&state=open`,
      { headers },
    );
    const list: unknown = await existing.json();
    const first = Array.isArray(list) ? list[0] : undefined;
    const pr = toPullRequest(first);
    if (!pr) throw new Error(redact(`no open pull request found for ${owner}:${spec.branch} after a 422`, token));
    return pr;
  }

  const message = stringField(parsed, "message") ?? JSON.stringify(parsed);
  throw new Error(redact(`GitHub API error (${response.status}): ${message}`, token));
};

/**
 * Accept for a cloud agent's pull request: the agent opened it as a DRAFT on its own branch
 * (prompts/implementation.md), and Accept is the human saying "this is ready". REST has no
 * endpoint for leaving draft — only the GraphQL `markPullRequestReadyForReview` mutation does —
 * and that mutation wants the PR's node id, so this is a REST read followed, only for a draft,
 * by one mutation.
 *
 * Returns the PR as read, so the caller records state and ±LOC with no third call. An already
 * non-draft PR is a success with no mutation: a retry after a partial failure, or a human who
 * clicked "Ready" on GitHub first, must not fail Accept.
 */
export const markPullRequestReady = async (
  identity: { owner: string; repo: string },
  prNumber: number,
  token: string,
): Promise<PullRequest> => {
  const { owner, repo } = identity;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  let parsed: unknown;
  let status: number;
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, { headers });
    status = response.status;
    parsed = await response.json();
  } catch (error) {
    throw new Error(redact(`GitHub unreachable reading PR #${prNumber}: ${String(error)}`, token));
  }
  if (status !== 200) {
    const message = stringField(parsed, "message") ?? JSON.stringify(parsed);
    throw new Error(redact(`GitHub API error (${status}) reading PR #${prNumber}: ${message}`, token));
  }
  const pr = toPullRequest(parsed);
  if (!pr) throw new Error(redact(`GitHub returned an unrecognized pull request: ${JSON.stringify(parsed)}`, token));

  const draft = field(parsed, "draft", (v): v is boolean => typeof v === "boolean") ?? false;
  if (!draft) return pr;
  const nodeId = stringField(parsed, "node_id");
  if (nodeId === undefined) throw new Error(`PR #${prNumber} has no node_id to mark ready`);

  let result: unknown;
  let gqlStatus: number;
  try {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers,
      body: JSON.stringify({
        query:
          "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) " +
          "{ pullRequest { isDraft } } }",
        variables: { id: nodeId },
      }),
    });
    gqlStatus = response.status;
    result = await response.json();
  } catch (error) {
    throw new Error(redact(`GitHub unreachable marking PR #${prNumber} ready: ${String(error)}`, token));
  }
  // GraphQL answers 200 with an `errors` array for a refused mutation, so the status alone
  // proves nothing — both have to be clean.
  const errors = typeof result === "object" && result !== null ? (result as Record<string, unknown>)["errors"] : undefined;
  if (gqlStatus !== 200 || (Array.isArray(errors) && errors.length > 0)) {
    const message = Array.isArray(errors)
      ? errors.map((e) => stringField(e, "message") ?? JSON.stringify(e)).join("; ")
      : JSON.stringify(result);
    throw new Error(redact(`GitHub refused to mark PR #${prNumber} ready (${gqlStatus}): ${message}`, token));
  }
  return pr;
};

/**
 * `merged` and `closed` are terminal: a PR cannot leave them, so a stored terminal state is
 * as good as a fresh read and needs no API call. Anything else — including `null`, which
 * only ever means "no webhook has told us" — has to be asked about.
 */
export const needsLiveCheck = (state: PullRequestState | null): boolean =>
  state !== "merged" && state !== "closed";

export type PullRequestSnapshot = { state: PullRequestState; additions: number | null; deletions: number | null };

/**
 * Reads a PR's current state, additions and deletions in one call — the same
 * `GET /repos/{owner}/{repo}/pulls/{n}` response carries all three, on the create call and on
 * this one. Throws on any non-200, with the token redacted.
 */
export const fetchPullRequestSnapshot = async (
  identity: { owner: string; repo: string },
  prNumber: number,
  token: string,
): Promise<PullRequestSnapshot> => {
  const { owner, repo } = identity;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, { headers });
  const parsed: unknown = await response.json();

  if (response.status !== 200) {
    const message = stringField(parsed, "message") ?? JSON.stringify(parsed);
    throw new Error(redact(`GitHub API error (${response.status}): ${message}`, token));
  }

  return {
    state: pullRequestState(parsed),
    additions: numberField(parsed, "additions") ?? null,
    deletions: numberField(parsed, "deletions") ?? null,
  };
};

export type PullRequestUpdate = {
  url: string;
  state: PullRequestState;
  additions: number | null;
  deletions: number | null;
};

/**
 * Narrow a `pull_request` webhook payload to what the board stores, or null if the body is
 * not one. Derived from `merged` + `state` rather than from `action`, so every action
 * (opened, synchronize, reopened, closed) is handled by the same three lines and no
 * allow-list can fall behind GitHub's action vocabulary.
 */
export const pullRequestUpdate = (payload: unknown): PullRequestUpdate | null => {
  const pr = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).pull_request : undefined;
  const url = stringField(pr, "html_url");
  if (url === undefined) return null;
  const state = pullRequestState(pr);
  return {
    url,
    state,
    additions: numberField(pr, "additions") ?? null,
    deletions: numberField(pr, "deletions") ?? null,
  };
};

export type RepoMetadata = {
  owner: string;
  repo: string;
  name: string;
  description: string;
  defaultBranch: string;
  private: boolean;
};

export type GitHubApiErrorCode = "repo_not_found" | "repo_not_accessible" | "github_unavailable";

/**
 * A coded error: the route layer switches on `code`, never on message text. The
 * codes are the wire codes the route answers with, so mapping one to a status is a lookup rather
 * than a translation.
 */
export class GitHubApiError extends Error {
  readonly code: GitHubApiErrorCode;

  constructor(code: GitHubApiErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "GitHubApiError";
    this.code = code;
  }
}

/**
 * The admission test behind adding a project: one `GET /repos/{owner}/{repo}` proves the link
 * parses, the repo exists, and the token can read it. Because it is that test, its failures must
 * stay distinguishable — the dialog says something different for each — so it throws a coded
 * `GitHubApiError` instead of the flat `Error` the publishing calls get away with.
 *
 * `default_branch` is a *setting*, not a promise that the branch exists: a commitless repo
 * reports `main` and has no refs at all (memory/gotchas.md G8). Emptiness is `provision.ts`'s
 * question, asked of the remote's refs, not of this response.
 */
export const fetchRepoMetadata = async (owner: string, repo: string, token: string): Promise<RepoMetadata> => {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
  } catch (error) {
    // DNS failure, TLS failure, dropped connection: no status to classify, and the dialog should
    // read it the same way it reads a 502 rather than as an unhandled crash.
    throw new GitHubApiError("github_unavailable", redact(String(error), token));
  }

  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    // GitHub answers a 5xx with an HTML error page or an empty body often enough that
    // `response.json()` would throw a SyntaxError, losing the status this call exists to classify.
    parsed = undefined;
  }

  if (response.status !== 200) {
    // A 404 covers both "no such repo" and "your token cannot see this private one" — GitHub
    // refuses to distinguish them, so as not to leak the existence of private repos, and
    // `repo_not_found` is the most we can honestly claim. A 401/403 is the opposite case: the
    // repo was acknowledged and the credential was refused.
    const code: GitHubApiErrorCode =
      response.status === 404
        ? "repo_not_found"
        : response.status === 401 || response.status === 403
          ? "repo_not_accessible"
          : "github_unavailable";
    const message = stringField(parsed, "message") ?? `GitHub answered ${response.status}`;
    throw new GitHubApiError(code, redact(message, token));
  }

  const name = stringField(parsed, "name");
  const defaultBranch = stringField(parsed, "default_branch");
  if (name === undefined || defaultBranch === undefined) {
    throw new GitHubApiError(
      "github_unavailable",
      redact(`GitHub returned an unrecognized repository: ${JSON.stringify(parsed)}`, token),
    );
  }

  return {
    // A renamed or transferred repo still answers on its old path, via a redirect `fetch` follows,
    // so the response's own pair is canonical and the pasted link may be stale.
    owner: stringField(field(parsed, "owner", (v): v is object => typeof v === "object" && v !== null), "login") ?? owner,
    repo: name,
    name,
    // `description` is null for a repo without one; the dialog prefills a text input with it.
    description: stringField(parsed, "description") ?? "",
    defaultBranch,
    private: field(parsed, "private", (v): v is boolean => typeof v === "boolean") ?? false,
  };
};
