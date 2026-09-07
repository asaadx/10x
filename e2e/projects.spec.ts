import { expect, test } from "@playwright/test";
import { cleanupAll, requireHerdr, startBoard, type Board } from "./fixtures.ts";

/**
 * A project is identified by its GitHub repo now, not by a path on this machine, and creating
 * one makes 10x clone that repo itself. So these tests cover the half of the contract that needs
 * neither the network nor a token: what the route refuses, and why.
 *
 * The half that does need GitHub — the lookup admission test, slug and repo-path derivation,
 * identity immutability and the provisioning guard — is covered against a faked GitHub in
 * `backend/src/project-routes.test.ts`, which is far cheaper than a live clone per assertion.
 */
let board: Board;

test.beforeAll(async () => {
  requireHerdr();
  board = await startBoard();
});

test.afterAll(async () => {
  await cleanupAll();
});

test("registers a project from a GitHub remote alone, and starts it unprovisioned", async ({ request }) => {
  const res = await request.post(`${board.baseUrl}/projects`, {
    data: { remote: "https://github.com/acme-e2e/widgets", name: "Widgets", description: "Probe" },
  });

  expect(res.status()).toBe(201);
  // The slug, the identity and the clone path are all derived: the caller supplied none of them.
  // `pending` rather than `ready`, because the answer comes back before the clone does — the
  // repo above does not exist, so provisioning will fail behind this response, which is the
  // state the board renders as "needs attention".
  expect(await res.json()).toMatchObject({
    id: "widgets",
    name: "Widgets",
    description: "Probe",
    owner: "acme-e2e",
    repo: "widgets",
    baseBranch: "main",
    provisionState: "pending",
  });
});

test("rejects a remote that is not a GitHub repository", async ({ request }) => {
  // Deliberate, and the reason a local-only project cannot exist: Accept pushes a branch and
  // opens a pull request, so a project with nowhere to push would park every ticket in In
  // Review permanently and could not even be archived.
  const res = await request.post(`${board.baseUrl}/projects`, {
    data: { remote: "https://gitlab.com/acme-e2e/widgets", name: "Elsewhere" },
  });

  expect(res.status()).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid_remote", field: "remote" });
});

test("rejects an id that is not a project slug", async ({ request }) => {
  // Uppercase, underscore and `!` all break /^[a-z0-9][a-z0-9-]{0,19}$/ — and the slug feeds
  // both the branch and the Herdr agent name, so it has to fail at registration.
  const res = await request.post(`${board.baseUrl}/projects`, {
    data: { remote: "https://github.com/acme-e2e/bad", name: "Bad Slug", id: "Bad_Slug!" },
  });

  expect(res.status()).toBe(400);
  expect(await res.json()).toMatchObject({ error: "invalid_project_slug", field: "id" });
});

test("rejects a caller-supplied repoPath rather than quietly obeying it", async ({ request }) => {
  const res = await request.post(`${board.baseUrl}/projects`, {
    data: { remote: "https://github.com/acme-e2e/derived", name: "Derived", repoPath: "/tmp/elsewhere" },
  });

  expect(res.status()).toBe(400);
  expect(await res.json()).toMatchObject({ error: "immutable_field", field: "repoPath" });
});

test("rejects a duplicate project id", async ({ request }) => {
  const data = { remote: "https://github.com/acme-e2e/dupe", name: "Dupe" };

  const first = await request.post(`${board.baseUrl}/projects`, { data });
  expect(first.status()).toBe(201);

  const second = await request.post(`${board.baseUrl}/projects`, { data });
  expect(second.status()).toBe(409);
  expect(await second.json()).toMatchObject({ error: "project_exists", field: "id" });
});
