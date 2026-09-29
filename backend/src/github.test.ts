/**
 * Tests for the pure pieces of GitHub publishing: redaction, remote parsing, and PR
 * body construction — plus `openPullRequest` and `fetchPullRequestSnapshot`'s metadata
 * extraction, against a real local git repo (for `origin` remote resolution, no network) with
 * `fetch` swapped for a queue of canned responses. `fetchRepoMetadata` needs no repo at all,
 * only the same canned `fetch`.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  redact,
  parseRemote,
  pullRequestBody,
  pullRequestUpdate,
  needsLiveCheck,
  openPullRequest,
  fetchPullRequestSnapshot,
  fetchRepoMetadata,
  markPullRequestReady,
  GitHubApiError,
} from "./github.ts";

describe("redact", () => {
  test("removes a token embedded in a plain string", () => {
    assert.equal(redact("push failed: bad credentials ghp_secret123", "ghp_secret123"), "push failed: bad credentials ***");
  });

  test("strips credentials from an https://x-access-token:SECRET@github.com/... URL", () => {
    const message = "fatal: unable to access 'https://x-access-token:ghp_secret123@github.com/o/r.git/'";
    assert.equal(redact(message, "ghp_secret123"), "fatal: unable to access 'https://***@github.com/o/r.git/'");
  });

  test("leaves an unrelated string untouched", () => {
    const message = "fatal: repository 'https://github.com/o/r.git' not found";
    assert.equal(redact(message, "ghp_secret123"), message);
  });
});

describe("parseRemote", () => {
  test("handles the https form with .git", () => {
    assert.deepEqual(parseRemote("https://github.com/owner/repo.git"), { owner: "owner", repo: "repo" });
  });

  test("handles the https form without .git", () => {
    assert.deepEqual(parseRemote("https://github.com/owner/repo"), { owner: "owner", repo: "repo" });
  });

  test("handles the ssh form with .git", () => {
    assert.deepEqual(parseRemote("git@github.com:owner/repo.git"), { owner: "owner", repo: "repo" });
  });

  test("handles the ssh form without .git", () => {
    assert.deepEqual(parseRemote("git@github.com:owner/repo"), { owner: "owner", repo: "repo" });
  });

  test("throws on a non-GitHub or malformed URL", () => {
    assert.throws(() => parseRemote("https://gitlab.com/owner/repo.git"));
    assert.throws(() => parseRemote("not a url"));
  });
});

describe("pullRequestBody", () => {
  test("includes the description and names the ticket id", () => {
    const body = pullRequestBody("Fixes the flaky spawn test.", "ticket/10x/7");
    assert.match(body, /Fixes the flaky spawn test\./);
    assert.match(body, /ticket\/10x\/7/);
  });
});

describe("pullRequestUpdate", () => {
  test("a merged PR reads state merged and the LOC pair off the payload", () => {
    const update = pullRequestUpdate({
      pull_request: { html_url: "https://github.com/o/r/pull/7", merged: true, state: "closed", additions: 12, deletions: 3 },
    });
    assert.deepEqual(update, { url: "https://github.com/o/r/pull/7", state: "merged", additions: 12, deletions: 3 });
  });

  test("closed but unmerged is state closed, not merged — the delete guard depends on this distinction", () => {
    const update = pullRequestUpdate({
      pull_request: { html_url: "https://github.com/o/r/pull/7", merged: false, state: "closed" },
    });
    assert.equal(update?.state, "closed");
  });

  test("an open PR reads state open", () => {
    const update = pullRequestUpdate({
      pull_request: { html_url: "https://github.com/o/r/pull/7", merged: false, state: "open" },
    });
    assert.equal(update?.state, "open");
  });

  test("a missing additions/deletions pair is still a valid update, with null LOC", () => {
    const update = pullRequestUpdate({
      pull_request: { html_url: "https://github.com/o/r/pull/7", merged: false, state: "open" },
    });
    assert.equal(update?.additions, null);
    assert.equal(update?.deletions, null);
  });

  test("returns null when the payload has no pull_request key", () => {
    assert.equal(pullRequestUpdate({ action: "opened" }), null);
  });

  test("returns null for a non-object body", () => {
    assert.equal(pullRequestUpdate(null), null);
    assert.equal(pullRequestUpdate("not a payload"), null);
  });
});

describe("needsLiveCheck", () => {
  test("merged needs no API call — merged is terminal, a PR cannot leave it", () => {
    assert.equal(needsLiveCheck("merged"), false);
  });

  test("closed needs no API call — closed is terminal, a PR cannot leave it", () => {
    assert.equal(needsLiveCheck("closed"), false);
  });

  test("open needs a live check", () => {
    assert.equal(needsLiveCheck("open"), true);
  });

  test("null needs a live check — null means no webhook told us, not that there is no PR, so treating it as safe-to-delete is the exact bug this guard exists to prevent", () => {
    assert.equal(needsLiveCheck(null), true);
  });
});

// ---------------------------------------------------------------------------
// A real local repo, only so `git remote get-url origin` has something to read — no network
// call ever leaves this process. `fetch` is swapped per test for a queue of canned Response
// objects, restored in `after`.
// ---------------------------------------------------------------------------

/**
 * No temp repo any more: these calls take the project's `{ owner, repo }` directly, so there is
 * nothing left to read a git remote from. The fixture used to exist purely to satisfy the
 * `git remote get-url origin` subprocess these functions ran on every call.
 */
const identity = { owner: "acme", repo: "proj" };

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** Queues canned responses in call order; a call past the end of the queue is a test bug. */
function queueFetch(responses: { status: number; body: unknown }[]): void {
  const queue = [...responses];
  globalThis.fetch = (async () => {
    const next = queue.shift();
    if (!next) throw new Error("fetch called more times than the test queued responses for");
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
}

const spec = { branch: "b", base: "main", title: "t", description: "d", ticketId: "tk-1" };

describe("openPullRequest surfaces PR metadata", () => {
  test("a 201 response carries state/additions/deletions alongside number/url", async () => {
    queueFetch([
      { status: 201, body: { number: 42, html_url: "https://github.com/acme/proj/pull/42", state: "open", merged: false, additions: 10, deletions: 4 } },
    ]);
    const pr = await openPullRequest(identity, spec, "tok");
    assert.deepEqual(pr, { number: 42, url: "https://github.com/acme/proj/pull/42", state: "open", additions: 10, deletions: 4 });
  });

  test("a merged PR's create response (the 422-adopt branch reuses the same shape) reads state merged", async () => {
    queueFetch([
      { status: 201, body: { number: 43, html_url: "https://github.com/acme/proj/pull/43", state: "closed", merged: true, additions: 1, deletions: 1 } },
    ]);
    const pr = await openPullRequest(identity, spec, "tok");
    assert.equal(pr.state, "merged");
  });

  test("a 422 already-exists response adopts the existing PR, with the same metadata fields populated", async () => {
    queueFetch([
      { status: 422, body: { message: "Validation Failed", errors: [{ message: "A pull request already exists for acme:b." }] } },
      { status: 200, body: [{ number: 7, html_url: "https://github.com/acme/proj/pull/7", state: "open", merged: false, additions: 3, deletions: 1 }] },
    ]);
    const pr = await openPullRequest(identity, spec, "tok");
    assert.deepEqual(pr, { number: 7, url: "https://github.com/acme/proj/pull/7", state: "open", additions: 3, deletions: 1 });
  });

  test("a create response missing additions/deletions still yields a PR, with null LOC", async () => {
    queueFetch([{ status: 201, body: { number: 44, html_url: "https://github.com/acme/proj/pull/44", state: "open", merged: false } }]);
    const pr = await openPullRequest(identity, spec, "tok");
    assert.equal(pr.additions, null);
    assert.equal(pr.deletions, null);
  });
});

describe("fetchPullRequestSnapshot", () => {
  test("returns state, additions and deletions from a single GET call", async () => {
    queueFetch([{ status: 200, body: { number: 9, state: "closed", merged: true, additions: 20, deletions: 5 } }]);
    const snapshot = await fetchPullRequestSnapshot(identity, 9, "tok");
    assert.deepEqual(snapshot, { state: "merged", additions: 20, deletions: 5 });
  });

  test("an open PR reads state open with its LOC", async () => {
    queueFetch([{ status: 200, body: { number: 9, state: "open", merged: false, additions: 2, deletions: 0 } }]);
    const snapshot = await fetchPullRequestSnapshot(identity, 9, "tok");
    assert.deepEqual(snapshot, { state: "open", additions: 2, deletions: 0 });
  });

  test("throws on a non-200 response, with the token redacted", async () => {
    queueFetch([{ status: 404, body: { message: "Not Found" } }]);
    await assert.rejects(() => fetchPullRequestSnapshot(identity, 9, "secret-tok"), /GitHub API error \(404\)/);
  });
});

describe("markPullRequestReady", () => {
  /** Like queueFetch, but also records what was asked, since the mutation body is the contract. */
  function recordFetch(responses: { status: number; body: unknown }[]): { url: string; body: string }[] {
    const seen: { url: string; body: string }[] = [];
    const queue = [...responses];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: typeof init?.body === "string" ? init.body : "" });
      const next = queue.shift();
      if (!next) throw new Error("fetch called more times than the test queued responses for");
      return new Response(JSON.stringify(next.body), { status: next.status });
    }) as typeof fetch;
    return seen;
  }
  const draftPr = {
    number: 12,
    html_url: "https://github.com/acme/proj/pull/12",
    node_id: "PR_kwDOabc",
    draft: true,
    state: "open",
    merged: false,
    additions: 5,
    deletions: 1,
  };

  test("a draft is read, then marked ready with its node id through GraphQL", async () => {
    const seen = recordFetch([
      { status: 200, body: draftPr },
      { status: 200, body: { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } } },
    ]);
    const pr = await markPullRequestReady(identity, 12, "tok");
    assert.deepEqual(pr, { number: 12, url: draftPr.html_url, state: "open", additions: 5, deletions: 1 });
    assert.equal(seen[0]?.url, "https://api.github.com/repos/acme/proj/pulls/12");
    assert.equal(seen[1]?.url, "https://api.github.com/graphql");
    const gql = JSON.parse(seen[1]?.body ?? "{}") as { query: string; variables: { id: string } };
    assert.match(gql.query, /markPullRequestReadyForReview/);
    assert.equal(gql.variables.id, "PR_kwDOabc");
  });

  test("a PR that is already ready needs no mutation", async () => {
    const seen = recordFetch([{ status: 200, body: { ...draftPr, draft: false } }]);
    await markPullRequestReady(identity, 12, "tok");
    assert.equal(seen.length, 1);
  });

  test("GraphQL errors inside a 200 are a failure, with the token redacted", async () => {
    recordFetch([
      { status: 200, body: draftPr },
      { status: 200, body: { errors: [{ message: "Resource not accessible by secret-tok" }] } },
    ]);
    await assert.rejects(
      markPullRequestReady(identity, 12, "secret-tok"),
      (err: Error) => /refused to mark PR #12 ready/.test(err.message) && !err.message.includes("secret-tok"),
    );
  });

  test("a missing PR is a failure", async () => {
    recordFetch([{ status: 404, body: { message: "Not Found" } }]);
    await assert.rejects(markPullRequestReady(identity, 12, "tok"), /\(404\)/);
  });
});

describe("fetchRepoMetadata is the admission test, so its failures stay distinguishable", () => {
  test("a 200 maps default_branch, a null description and the visibility flag", async () => {
    queueFetch([
      {
        status: 200,
        body: {
          name: "10x-test",
          full_name: "asaadx/10x-test",
          owner: { login: "asaadx" },
          description: null,
          default_branch: "master",
          private: true,
        },
      },
    ]);
    assert.deepEqual(await fetchRepoMetadata("asaadx", "10x-test", "tok"), {
      owner: "asaadx",
      repo: "10x-test",
      name: "10x-test",
      description: "",
      defaultBranch: "master",
      private: true,
    });
  });

  test("a redirect to a renamed repo is followed, and the response's owner/name wins over the pasted pair", async () => {
    queueFetch([
      {
        status: 200,
        body: { name: "hearth-home", owner: { login: "newowner" }, description: "d", default_branch: "main", private: false },
      },
    ]);
    const metadata = await fetchRepoMetadata("oldowner", "old-name", "tok");
    assert.equal(metadata.owner, "newowner");
    assert.equal(metadata.repo, "hearth-home");
  });

  test("a 404 is repo_not_found", async () => {
    queueFetch([{ status: 404, body: { message: "Not Found" } }]);
    await assert.rejects(() => fetchRepoMetadata("acme", "nope", "tok"), (err: unknown) => {
      assert.ok(err instanceof GitHubApiError);
      assert.equal(err.code, "repo_not_found");
      return true;
    });
  });

  test("a 403 is repo_not_accessible — the repo was acknowledged and the token was refused", async () => {
    queueFetch([{ status: 403, body: { message: "Resource not accessible by personal access token" } }]);
    await assert.rejects(() => fetchRepoMetadata("acme", "proj", "tok"), (err: unknown) => {
      assert.ok(err instanceof GitHubApiError);
      assert.equal(err.code, "repo_not_accessible");
      return true;
    });
  });

  test("a 500 is github_unavailable", async () => {
    queueFetch([{ status: 500, body: { message: "Server Error" } }]);
    await assert.rejects(() => fetchRepoMetadata("acme", "proj", "tok"), (err: unknown) => {
      assert.ok(err instanceof GitHubApiError);
      assert.equal(err.code, "github_unavailable");
      return true;
    });
  });

  test("a 200 with no default_branch is github_unavailable, not a repo with an empty base", async () => {
    queueFetch([{ status: 200, body: { name: "proj", owner: { login: "acme" } } }]);
    await assert.rejects(() => fetchRepoMetadata("acme", "proj", "tok"), (err: unknown) => {
      assert.ok(err instanceof GitHubApiError);
      assert.equal(err.code, "github_unavailable");
      return true;
    });
  });

  test("a non-JSON body — GitHub's 5xx HTML error page — still classifies by status instead of throwing a SyntaxError", async () => {
    globalThis.fetch = (async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })) as typeof fetch;
    await assert.rejects(() => fetchRepoMetadata("acme", "proj", "tok"), (err: unknown) => {
      assert.ok(err instanceof GitHubApiError);
      assert.equal(err.code, "github_unavailable");
      return true;
    });
  });

  test("a thrown error never carries the token, however GitHub echoed it back", async () => {
    queueFetch([{ status: 404, body: { message: "Not Found for token ghp_secret123" } }]);
    await assert.rejects(() => fetchRepoMetadata("acme", "proj", "ghp_secret123"), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.doesNotMatch(err.message, /ghp_secret123/);
      assert.doesNotMatch(String(err.stack), /ghp_secret123/);
      return true;
    });
  });
});
