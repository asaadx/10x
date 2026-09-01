/**
 * Tests for the pure pieces of GitHub publishing: redaction, remote parsing, and PR
 * body construction. `pushTicketBranch` and `openPullRequest` need the network and are
 * covered by an end-to-end test against a real throwaway repo, not here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redact, parseRemote, pullRequestBody, pullRequestUpdate, needsLiveCheck } from "./github.ts";

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
