/**
 * The port pool against REAL spawns.
 *
 * The unit tests pin the arithmetic; only a real spawn can show that the block actually
 * lands in the worktree the agent boots in, and that git does not see the file — which is
 * the part that would otherwise be discovered as a `.env` committed to a ticket branch.
 */
import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  api,
  cleanupAll,
  createProject,
  createTicket,
  makeRepo,
  postSpawn,
  PROBE_DESCRIPTION,
  requireHerdr,
  spawnTicket,
  startBoard,
  storedTicket,
  type Board,
} from "./fixtures.ts";

const git = promisify(execFile);

/** A spawn costs ~4s (memory/spawn.md) but the readiness guard alone may wait 60s. */
const SPAWN_MS = 120_000;
/** The reuse test spawns twice, serially. */
const TWO_SPAWNS_MS = 240_000;

/** Slot 0 of the default pool — `PORT_BLOCK_BASE` 4100, `PORT_BLOCK_STRIDE` 10. */
const FIRST_BLOCK = { start: 4100, end: 4109 };

let board: Board;
let repoPath: string;
let capBefore: string | undefined;

test.beforeAll(async () => {
  requireHerdr();
  /*
   * A cap of one, so exhaustion is one extra ticket away instead of ten real agents away.
   * `startBoard` takes no options and the fixture passes its own environment through to the
   * server child, so this is the seam. Restored in afterAll: the worker process is shared
   * with the other spec files, which must see the default.
   */
  capBefore = process.env.MAX_PORT_SLOTS;
  process.env.MAX_PORT_SLOTS = "1";
  board = await startBoard();
  // One throwaway repo for the file: branches are namespaced per project, so tests cannot
  // collide inside it.
  repoPath = await makeRepo();
});

test.afterAll(async () => {
  await cleanupAll();
  if (capBefore === undefined) delete process.env.MAX_PORT_SLOTS;
  else process.env.MAX_PORT_SLOTS = capBefore;
});

test("spawn writes the ticket's port block into the worktree, invisibly to git", async () => {
  test.setTimeout(SPAWN_MS);
  await createProject(board, "port", repoPath);
  const id = await createTicket(board, "port", "Port block", PROBE_DESCRIPTION);

  const run = await spawnTicket(board, repoPath, id);

  // The values, not just the presence of the file: a block whose PORT and bounds disagreed
  // would still parse as a valid .env and would still start a server on the wrong port.
  const env = await readFile(join(run.worktreePath, ".env"), "utf8");
  expect(env).toContain(`PORT=${FIRST_BLOCK.start}`);
  expect(env).toContain(`PORT_RANGE_START=${FIRST_BLOCK.start}`);
  expect(env).toContain(`PORT_RANGE_END=${FIRST_BLOCK.end}`);
  // A human who opens it inside a worktree has to be able to tell what wrote it.
  expect(env).toContain("Written by 10x");

  // The agent commits in this worktree, so an untracked .env is one `git add -A` away from
  // being committed to the ticket branch.
  const status = await git("git", ["-C", run.worktreePath, "status", "--porcelain"]);
  expect(status.stdout, `.env is visible to git:\n${status.stdout}`).not.toContain(".env");

  // Excluded via .git/info/exclude, so the project's own tracked .gitignore is untouched —
  // a created or modified one would show up here as a pending change.
  const ignoreFile = await git("git", [
    "-C",
    run.worktreePath,
    "status",
    "--porcelain",
    "--",
    ".gitignore",
  ]);
  expect(ignoreFile.stdout).toBe("");

  // Not an assertion — this test owns a live agent and the pool's only slot.
  expect((await api(board, "POST", `/tickets/${id}/cancel`)).status).toBe(200);
});

test("the pool is capped, and cancel returns the block to it", async () => {
  test.setTimeout(TWO_SPAWNS_MS);
  await createProject(board, "pool", repoPath);
  const first = await createTicket(board, "pool", "Holds the only slot", PROBE_DESCRIPTION);
  const second = await createTicket(board, "pool", "Wants the same slot", PROBE_DESCRIPTION);

  const held = await spawnTicket(board, repoPath, first);
  expect(await readFile(join(held.worktreePath, ".env"), "utf8")).toContain(
    `PORT=${FIRST_BLOCK.start}`,
  );

  // With the cap at one there is nowhere to put a second dev server, so the spawn is
  // refused outright rather than starting an agent with no port of its own.
  const refused = await postSpawn(board, repoPath, second);
  expect(refused.status).toBe(409);
  expect(refused.body["error"]).toBe("port_pool_exhausted");
  expect(refused.body["cap"]).toBe(1);
  // And the refusal is complete: the claim was handed back, so the ticket is where the spawn
  // found it — To Do, the column Start works from — and no half-configured agent exists.
  expect(storedTicket(board, second).status).toBe("todo");

  expect((await api(board, "POST", `/tickets/${first}/cancel`)).status).toBe(200);

  // The same block, because a released slot is reused rather than retired.
  const reused = await spawnTicket(board, repoPath, second);
  expect(await readFile(join(reused.worktreePath, ".env"), "utf8")).toContain(
    `PORT=${FIRST_BLOCK.start}`,
  );

  expect((await api(board, "POST", `/tickets/${second}/cancel`)).status).toBe(200);
});
