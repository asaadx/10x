import { expect, test, type APIRequestContext } from "@playwright/test";
import { setTimeout as delay } from "node:timers/promises";
import { cleanupAll, makeRepo, requireHerdr, startBoard, type Board } from "./fixtures.ts";

let board: Board;

test.beforeAll(async () => {
  requireHerdr();
  board = await startBoard();
});

test.afterAll(async () => {
  await cleanupAll();
});

/**
 * The single parse boundary in this file: HTTP JSON carries no types, so it is narrowed once
 * here rather than trusted field by field at each assertion.
 */
function objectFrom(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(`expected a JSON object, got ${JSON.stringify(body)}`);
  }
  return { ...body };
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string") {
    throw new Error(`expected a string "${key}" in ${JSON.stringify(body)}`);
  }
  return value;
}

/** Ticket ids on the board, so a delete can be shown to have actually removed the row. */
function ticketIds(body: Record<string, unknown>): string[] {
  const tickets = body["tickets"];
  if (!Array.isArray(tickets)) {
    throw new Error(`expected a tickets array in ${JSON.stringify(body)}`);
  }
  return tickets.map((ticket: unknown) => stringField(objectFrom(ticket), "id"));
}

/** Each test gets its own project so ticket numbering is never coupled to test order. */
async function project(request: APIRequestContext, id: string): Promise<string> {
  const res = await request.post(`${board.baseUrl}/projects`, {
    data: { id, name: `Project ${id}`, repoPath: await makeRepo(), baseBranch: "dev" },
  });
  expect(res.status()).toBe(201);
  return id;
}

test("numbers tickets from one and builds the id from the slug", async ({ request }) => {
  const id = await project(request, "tnum");

  const first = await request.post(`${board.baseUrl}/tickets`, {
    data: { projectId: id, title: "First ticket", description: "one" },
  });
  expect(first.status()).toBe(201);
  expect(await first.json()).toMatchObject({
    id: "tnum-1",
    projectId: id,
    number: 1,
    title: "First ticket",
    description: "one",
    status: "backlog",
  });

  const second = await request.post(`${board.baseUrl}/tickets`, {
    data: { projectId: id, title: "Second ticket", description: "two" },
  });
  expect(second.status()).toBe(201);
  expect(await second.json()).toMatchObject({ id: "tnum-2", number: 2, status: "backlog" });
});

test("patches title and description and advances updatedAt", async ({ request }) => {
  const id = await project(request, "tpatch");

  const created = objectFrom(
    await (
      await request.post(`${board.baseUrl}/tickets`, {
        data: { projectId: id, title: "Before", description: "before" },
      })
    ).json(),
  );
  // createdAt === updatedAt is how "never edited" is expressed, and the timestamps are
  // millisecond ISO instants — without this the patch can land inside the same millisecond.
  expect(stringField(created, "updatedAt")).toBe(stringField(created, "createdAt"));
  await delay(5);

  const res = await request.patch(`${board.baseUrl}/tickets/${stringField(created, "id")}`, {
    data: { title: "After", description: "after" },
  });

  expect(res.status()).toBe(200);
  const patched = objectFrom(await res.json());
  expect(patched).toMatchObject({ title: "After", description: "after" });
  expect(Date.parse(stringField(patched, "updatedAt"))).toBeGreaterThan(
    Date.parse(stringField(created, "updatedAt")),
  );
});

test("deletes a ticket that was never spawned", async ({ request }) => {
  const id = await project(request, "tdel");

  const created = objectFrom(
    await (
      await request.post(`${board.baseUrl}/tickets`, {
        data: { projectId: id, title: "Never started", description: "no worktree exists" },
      })
    ).json(),
  );
  const ticketId = stringField(created, "id");

  // DELETE runs a full destructive teardown. With no worktree and no agent there is nothing
  // to remove, so it must no-op cleanly rather than surface a Herdr error.
  const res = await request.delete(`${board.baseUrl}/tickets/${ticketId}`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });

  const listed = await request.get(`${board.baseUrl}/tickets?project=${id}`);
  expect(listed.status()).toBe(200);
  expect(ticketIds(objectFrom(await listed.json()))).not.toContain(ticketId);
});

test("keeps ticket numbers monotonic across a delete", async ({ request }) => {
  const id = await project(request, "tmono");

  for (const title of ["One", "Two"]) {
    const res = await request.post(`${board.baseUrl}/tickets`, { data: { projectId: id, title } });
    expect(res.status()).toBe(201);
  }

  expect((await request.delete(`${board.baseUrl}/tickets/tmono-2`)).status()).toBe(200);

  /*
   * 3, not 2. Deleting a ticket deliberately leaves its worktree on disk, so recycling the
   * number would hand a new ticket a branch that already has another ticket's work on it.
   */
  const next = await request.post(`${board.baseUrl}/tickets`, {
    data: { projectId: id, title: "Three" },
  });
  expect(next.status()).toBe(201);
  expect(await next.json()).toMatchObject({ id: "tmono-3", number: 3 });
});
