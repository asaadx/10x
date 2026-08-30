import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cleanupAll, makeRepo, requireHerdr, startBoard, type Board } from "./fixtures.ts";

let board: Board;

test.beforeAll(async () => {
  requireHerdr();
  board = await startBoard();
});

test.afterAll(async () => {
  await cleanupAll();
});

test("registers a project against a real repo", async ({ request }) => {
  const repoPath = await makeRepo();

  const res = await request.post(`${board.baseUrl}/projects`, {
    data: { id: "probe", name: "Probe", repoPath, baseBranch: "dev" },
  });

  expect(res.status()).toBe(201);
  expect(await res.json()).toMatchObject({
    id: "probe",
    name: "Probe",
    repoPath,
    baseBranch: "dev",
  });
});

test("rejects an id that is not a project slug", async ({ request }) => {
  const repoPath = await makeRepo();

  // Uppercase, underscore and `!` all break /^[a-z0-9][a-z0-9-]{0,19}$/ — and the slug feeds
  // both the branch and the Herdr agent name, so it has to fail at registration.
  const res = await request.post(`${board.baseUrl}/projects`, {
    data: { id: "Bad_Slug!", name: "Bad Slug", repoPath, baseBranch: "dev" },
  });

  expect(res.status()).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid_project_slug", field: "id" });
});

test("rejects a repoPath that is not a git repository", async ({ request }) => {
  // A plain directory inside a tracked temp repo, so cleanupAll still reaps it.
  const notARepo = join(await makeRepo(), "not-a-repo");
  await mkdir(notARepo);

  const res = await request.post(`${board.baseUrl}/projects`, {
    data: { id: "nogit", name: "No Git", repoPath: notARepo, baseBranch: "dev" },
  });

  expect(res.status()).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid_repo_path", field: "repoPath" });
});

test("rejects a repoPath that does not exist", async ({ request }) => {
  const missing = join(await makeRepo(), "does-not-exist");

  const res = await request.post(`${board.baseUrl}/projects`, {
    data: { id: "missing", name: "Missing", repoPath: missing, baseBranch: "dev" },
  });

  expect(res.status()).toBe(400);
  // The same error code as a non-repo, distinguished only by the message — assert it, or
  // this test and the previous one prove the same thing.
  expect(await res.json()).toMatchObject({
    error: "invalid_repo_path",
    field: "repoPath",
    message: expect.stringContaining("does not exist"),
  });
});

test("rejects a duplicate project id", async ({ request }) => {
  const repoPath = await makeRepo();
  const data = { id: "dupe", name: "Dupe", repoPath, baseBranch: "dev" };

  const first = await request.post(`${board.baseUrl}/projects`, { data });
  expect(first.status()).toBe(201);

  const second = await request.post(`${board.baseUrl}/projects`, { data });
  expect(second.status()).toBe(409);
  expect(await second.json()).toMatchObject({ error: "project_exists", field: "id" });
});
