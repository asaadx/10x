/**
 * Tests for the pure pieces of GitHub publishing: redaction, remote parsing, and PR
 * body construction. `pushTicketBranch` and `openPullRequest` need the network and are
 * covered by an end-to-end test against a real throwaway repo, not here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redact, parseRemote, pullRequestBody } from "./github.ts";

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
