/**
 * Tests for the pure pieces of GitHub publishing: redaction, remote parsing, and PR
 * body construction — plus `openPullRequest` and `fetchPullRequestSnapshot`'s metadata
 * extraction, against a real local git repo (for `origin` remote resolution, no network) with
 * `fetch` swapped for a queue of canned responses. `pushTicketBranch` still needs a real push
 * and stays covered only by the end-to-end test against a real throwaway repo.
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

const repoPath = mkdtempSync(join(tmpdir(), "10x-github-test-"));
execFileSync("git", ["init", "-q", repoPath]);
execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/proj.git"], { cwd: repoPath });

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
  rmSync(repoPath, { recursive: true, force: true });
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
    const pr = await openPullRequest(repoPath, spec, "tok");
    assert.deepEqual(pr, { number: 42, url: "https://github.com/acme/proj/pull/42", state: "open", additions: 10, deletions: 4 });
  });

  test("a merged PR's create response (the 422-adopt branch reuses the same shape) reads state merged", async () => {
    queueFetch([
      { status: 201, body: { number: 43, html_url: "https://github.com/acme/proj/pull/43", state: "closed", merged: true, additions: 1, deletions: 1 } },
    ]);
    const pr = await openPullRequest(repoPath, spec, "tok");
    assert.equal(pr.state, "merged");
  });

  test("a 422 already-exists response adopts the existing PR, with the same metadata fields populated", async () => {
    queueFetch([
      { status: 422, body: { message: "Validation Failed", errors: [{ message: "A pull request already exists for acme:b." }] } },
      { status: 200, body: [{ number: 7, html_url: "https://github.com/acme/proj/pull/7", state: "open", merged: false, additions: 3, deletions: 1 }] },
    ]);
    const pr = await openPullRequest(repoPath, spec, "tok");
    assert.deepEqual(pr, { number: 7, url: "https://github.com/acme/proj/pull/7", state: "open", additions: 3, deletions: 1 });
  });

  test("a create response missing additions/deletions still yields a PR, with null LOC", async () => {
    queueFetch([{ status: 201, body: { number: 44, html_url: "https://github.com/acme/proj/pull/44", state: "open", merged: false } }]);
    const pr = await openPullRequest(repoPath, spec, "tok");
    assert.equal(pr.additions, null);
    assert.equal(pr.deletions, null);
  });
});

describe("fetchPullRequestSnapshot", () => {
  test("returns state, additions and deletions from a single GET call", async () => {
    queueFetch([{ status: 200, body: { number: 9, state: "closed", merged: true, additions: 20, deletions: 5 } }]);
    const snapshot = await fetchPullRequestSnapshot(repoPath, 9, "tok");
    assert.deepEqual(snapshot, { state: "merged", additions: 20, deletions: 5 });
  });

  test("an open PR reads state open with its LOC", async () => {
    queueFetch([{ status: 200, body: { number: 9, state: "open", merged: false, additions: 2, deletions: 0 } }]);
    const snapshot = await fetchPullRequestSnapshot(repoPath, 9, "tok");
    assert.deepEqual(snapshot, { state: "open", additions: 2, deletions: 0 });
  });

  test("throws on a non-200 response, with the token redacted", async () => {
    queueFetch([{ status: 404, body: { message: "Not Found" } }]);
    await assert.rejects(() => fetchPullRequestSnapshot(repoPath, 9, "secret-tok"), /GitHub API error \(404\)/);
  });
});
