/**
 * Publish a ticket's branch as a GitHub pull request: push the branch with a scoped
 * token, then open (or adopt) the PR. No client class, no injected transport — these
 * are the two network calls the app needs, calling `fetch` and `git` directly.
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

/** Reads the repo's `origin` remote and resolves it to `{ owner, repo }`. */
async function originOwnerRepo(repoPath: string): Promise<{ owner: string; repo: string }> {
  const { stdout } = await run("git", ["remote", "get-url", "origin"], { cwd: repoPath });
  return parseRemote(stdout.trim());
}

/**
 * Pushes `branch` to `origin` using a token-authenticated URL, bypassing whatever
 * credential helper (or lack of one) the worktree has configured. A ref that is
 * already up to date is success — git exits 0 and says so — so no special casing.
 */
export const pushTicketBranch = async (repoPath: string, branch: string, token: string): Promise<void> => {
  try {
    const { owner, repo } = await originOwnerRepo(repoPath);
    const url = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
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
  repoPath: string,
  spec: { branch: string; base: string; title: string; description: string; ticketId: string },
  token: string,
): Promise<PullRequest> => {
  const { owner, repo } = await originOwnerRepo(repoPath);
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
  repoPath: string,
  prNumber: number,
  token: string,
): Promise<PullRequestSnapshot> => {
  const { owner, repo } = await originOwnerRepo(repoPath);
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
