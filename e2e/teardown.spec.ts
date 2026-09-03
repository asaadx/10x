/**
 * The two destructive endpoints, which differ on exactly one dial: deleting a ticket takes
 * the branch with it, removing the worktree keeps it (memory/teardown.md).
 */
import { expect, test } from "@playwright/test";
import { existsSync } from "node:fs";
import {
  api,
  boardRows,
  branchExists,
  cleanupAll,
  createProject,
  createTicket,
  expectZeroResidue,
  liveAgentNames,
  liveWorktreeBranches,
  makeRepo,
  PROBE_DESCRIPTION,
  requireHerdr,
  spawnTicket,
  startBoard,
  storedTicket,
  stringField,
  ticketRow,
  type Board,
} from "./fixtures.ts";

const SPAWN_MS = 120_000;

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

test("deleting a spawned ticket removes the row and every resource", async () => {
  test.setTimeout(SPAWN_MS);
  await createProject(board, "tdrp", repoPath);
  const id = await createTicket(board, "tdrp", "Deleted mid-flight", PROBE_DESCRIPTION);

  const run = await spawnTicket(board, repoPath, id);
  const sessionDir = stringField(await ticketRow(board, id), "sessionDir");
  expect(existsSync(sessionDir)).toBe(true);

  expect((await api(board, "DELETE", `/tickets/${id}`)).status).toBe(200);

  await expectZeroResidue(repoPath, run, sessionDir);
  expect((await boardRows(board)).map((row) => row["id"])).not.toContain(id);
});

test("removing only the worktree reclaims the disk and keeps the branch", async () => {
  test.setTimeout(SPAWN_MS);
  await createProject(board, "wtdl", repoPath);
  const id = await createTicket(board, "wtdl", "Worktree reclaimed", PROBE_DESCRIPTION);

  const run = await spawnTicket(board, repoPath, id);
  const sessionDir = stringField(await ticketRow(board, id), "sessionDir");

  const res = await api(board, "DELETE", `/tickets/${id}/worktree`);
  expect(res.status).toBe(200);

  // The disk is reclaimed and the agent goes with the pane...
  expect(existsSync(run.worktreePath)).toBe(false);
  expect(await liveWorktreeBranches(repoPath)).not.toContain(run.branch);
  expect(await liveAgentNames()).not.toContain(run.agentName);
  expect(existsSync(sessionDir)).toBe(false);

  // ...but THE BRANCH SURVIVES, and that is the entire point of this endpoint: it is the
  // escape hatch for an abandoned run whose commits still matter (memory/teardown.md).
  expect(await branchExists(repoPath, run.branch), `branch ${run.branch} was destroyed`).toBe(true);
  expect(res.body["branchKept"]).toBe(run.branch);

  // Back in To Do — the same edge cancel takes, since the run is over either way — and still
  // carrying the branch it will reuse on the next dispatch: only `sessionDir` is cleared,
  // because that transcript really is gone.
  expect(storedTicket(board, id)).toEqual({
    status: "todo",
    branch: run.branch,
    agentName: run.agentName,
    sessionDir: null,
  });
});
