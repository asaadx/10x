/**
 * Reject, end to end against a REAL agent: a ticket in In Review is sent back to In Progress
 * with a re-prompt, and the worktree, branch, agent and port slot all survive — Reject is the
 * opposite of destructive (see the ticket's design notes).
 *
 * UNVERIFIED — deliberately never run as part of this change. It needs a real agent spawn,
 * which this ticket is forbidden from invoking.
 */
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import {
  api,
  cleanupAll,
  createProject,
  createTicket,
  liveAgentNames,
  liveWorktreeBranches,
  makeRepo,
  PROBE_DESCRIPTION,
  requireHerdr,
  spawnTicket,
  startBoard,
  storedTicket,
  waitForTicket,
  type Board,
} from "./fixtures.ts";

/** A spawn costs ~4s, plus a real model turn on the probe ticket (memory/spawn.md). */
const COMPLETION_MS = 180_000;

let board: Board;
let repoPath: string;

test.beforeAll(async () => {
  requireHerdr();
  board = await startBoard();
  repoPath = await makeRepo();
});

test.afterAll(async () => {
  await cleanupAll();
});

test("reject sends a reviewed ticket back to In Progress with the reason, and destroys nothing", async () => {
  test.setTimeout(COMPLETION_MS);
  await createProject(board, "rjct", repoPath);
  const id = await createTicket(board, "rjct", "Probe reject", PROBE_DESCRIPTION);

  const run = await spawnTicket(board, repoPath, id);
  await waitForTicket(board, id, "moved to review", (t) => t["status"] === "in_review", 150_000);

  const res = await api(board, "POST", `/tickets/${id}/reject`, { reason: "please add a test" });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body["status"]).toBe("in_progress");
  expect(res.body["finished"]).toBe(false);

  // Nothing about the run is torn down: worktree, branch, agent and port slot all survive
  // (this is the whole point of reject over a fresh respawn — the branch and agent name are
  // already taken by this same live run).
  expect(storedTicket(board, id)).toMatchObject({
    status: "in_progress",
    finished: false,
    branch: run.branch,
    agentName: run.agentName,
  });
  expect(existsSync(run.worktreePath)).toBe(true);
  expect(await liveWorktreeBranches(repoPath)).toContain(run.branch);
  expect(await liveAgentNames()).toContain(run.agentName);

  expect((await api(board, "DELETE", `/tickets/${id}`)).status).toBe(200);
});

test("reject without a reason is rejected with 400", async () => {
  await createProject(board, "rjctb", repoPath);
  const id = await createTicket(board, "rjctb", "Probe reject bad body", PROBE_DESCRIPTION);

  const run = await spawnTicket(board, repoPath, id);
  await waitForTicket(board, id, "moved to review", (t) => t["status"] === "in_review", 150_000);

  const missing = await api(board, "POST", `/tickets/${id}/reject`, {});
  expect(missing.status).toBe(400);
  expect(missing.body["error"]).toBe("reason_required");

  const blank = await api(board, "POST", `/tickets/${id}/reject`, { reason: "   " });
  expect(blank.status).toBe(400);
  expect(blank.body["error"]).toBe("reason_required");

  // Neither bad request touched the claim.
  expect(storedTicket(board, id)).toMatchObject({ status: "in_review" });

  expect((await api(board, "DELETE", `/tickets/${id}`)).status).toBe(200);
});
