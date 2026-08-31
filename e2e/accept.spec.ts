/**
 * Accept, end to end against a REAL agent and a REAL GitHub repo. Nothing about the publish
 * step (push, open a PR, retire the agent) can be proven against a throwaway local repo the
 * way the rest of this suite uses `makeRepo` — there is no GitHub on the other end of it — so
 * this clones `asaadx/10x-test` and pushes to it for real.
 *
 * UNVERIFIED — deliberately never run as part of this change. It needs a real agent spawn,
 * which step 3 (this ticket) is forbidden from invoking, and a `GITHUB_TOKEN` with push
 * access to `asaadx/10x-test`. Running it creates a real branch and a real pull request on
 * that repo; closing the PR and deleting the branch afterward is a manual step.
 *
 * Preconditions this test assumes and does not create: `asaadx/10x-test` already has a `dev`
 * branch (the project's `baseBranch`, matching every other spec's convention), and
 * `GITHUB_TOKEN` in the environment can push to it and open pull requests against it.
 */
import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  api,
  branchExists,
  cleanupAll,
  createProject,
  createTicket,
  liveAgentNames,
  liveWorktreeBranches,
  PROBE_DESCRIPTION,
  requireHerdr,
  spawnTicket,
  startBoard,
  storedTicket,
  stringField,
  waitForTicket,
  type Board,
} from "./fixtures.ts";

const git = promisify(execFile);
const TEST_REPO_URL = "https://github.com/asaadx/10x-test.git";

/** A spawn costs ~4s, plus a real model turn on the probe ticket (memory/spawn.md). */
const COMPLETION_MS = 180_000;
/** Publish does two real network calls (push, open PR) on top of the completion wait. */
const ACCEPT_MS = 30_000;

const GITHUB_API_HEADERS = {
  Authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ""}`,
  Accept: "application/vnd.github+json",
  "Content-Type": "application/json",
};

/**
 * Closes the PR and deletes the pushed branch on `asaadx/10x-test`, undoing exactly what
 * this test's Accept call created. Uses `fetch` against the GitHub REST API directly, the
 * same approach src/github.ts uses, rather than shelling out to `gh`. Best-effort: a failure
 * here is logged, not thrown, so it can never turn a passing test into a failing one.
 */
async function closeGithubState(branch: string, prNumber: number | undefined): Promise<void> {
  try {
    if (prNumber !== undefined) {
      await fetch(`https://api.github.com/repos/asaadx/10x-test/pulls/${prNumber}`, {
        method: "PATCH",
        headers: GITHUB_API_HEADERS,
        body: JSON.stringify({ state: "closed" }),
      });
    }
    await fetch(`https://api.github.com/repos/asaadx/10x-test/git/refs/heads/${branch}`, {
      method: "DELETE",
      headers: GITHUB_API_HEADERS,
    });
  } catch (err) {
    console.warn(`accept.spec.ts cleanup: failed to close PR/delete branch ${branch}:`, err);
  }
}

let board: Board;
let repoPath: string;

test.beforeAll(async () => {
  requireHerdr();
  board = await startBoard();
  repoPath = await mkdtemp(join(tmpdir(), "10x-e2e-accept-"));
  await git("git", ["clone", "-q", TEST_REPO_URL, repoPath]);
  await git("git", ["checkout", "-q", "dev"], { cwd: repoPath });
});

test.afterAll(async () => {
  await cleanupAll();
  await rm(repoPath, { recursive: true, force: true });
});

test("accept publishes the branch as a PR, moves the ticket to Done, and retires the agent", async () => {
  test.skip(!process.env.GITHUB_TOKEN, "needs a GITHUB_TOKEN with push access to asaadx/10x-test");
  test.setTimeout(COMPLETION_MS + ACCEPT_MS);

  await createProject(board, "accpt", repoPath);
  const id = await createTicket(board, "accpt", "Accept publish probe", PROBE_DESCRIPTION);

  const run = await spawnTicket(board, repoPath, id);
  await waitForTicket(board, id, "moved to review", (t) => t["status"] === "in_review", 150_000);

  // The PR number is only known once Accept responds, so the finally block that closes it
  // has to read it from up here rather than from inside the try.
  let prNumber: number | undefined;
  try {
    const res = await api(board, "POST", `/tickets/${id}/accept`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body["status"]).toBe("done");

    prNumber = typeof res.body["prNumber"] === "number" ? res.body["prNumber"] : undefined;
    const prUrl = stringField(res.body, "prUrl");
    expect(typeof prNumber).toBe("number");
    expect(prUrl).toContain("github.com/asaadx/10x-test/pull/");

    // Publish only ever moves forward: the row agrees with the response, and the branch
    // survives on both ends because Accept never merges and never deletes it.
    expect(storedTicket(board, id)).toMatchObject({ status: "done", branch: run.branch });
    expect(await branchExists(repoPath, run.branch)).toBe(true);
    const remoteBranches = await git("git", ["ls-remote", "--heads", "origin", run.branch], {
      cwd: repoPath,
    });
    expect(remoteBranches.stdout).toContain(run.branch);

    // The worktree is the reviewed work and Accept never reclaims it — only a merge does,
    // which is outside this app.
    expect(existsSync(run.worktreePath)).toBe(true);
    expect(await liveWorktreeBranches(repoPath)).toContain(run.branch);

    // The agent is retired: its pane and transcript are gone, but nothing about the worktree
    // or the branch says so.
    expect(await liveAgentNames()).not.toContain(run.agentName);
  } finally {
    // `finally` runs whether the assertions above passed or threw, so a failing run leaks
    // exactly as little GitHub state as a passing one. A cleanup failure here only warns —
    // a leaked branch/PR is untidy, but failing an otherwise-passing test over it is worse.
    await closeGithubState(run.branch, prNumber);
  }
});
