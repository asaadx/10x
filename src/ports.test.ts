/**
 * Tests for the pure port-pool allocator.
 *
 * A wrong answer here hands two live agents the same TCP port, and the symptom is an
 * EADDRINUSE inside somebody's worktree rather than an error on the board — so the
 * arithmetic and the cap are pinned rather than trusted. The persistence that consumes
 * these lives in db.ts and is tested in port-slots.test.ts.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * Two rather than the default ten: exhaustion is the case worth testing and a cap of two
 * reaches it in two tickets. Set before the import below, because ports.ts reads its
 * configuration at load — the one place a dynamic import is required rather than preferred,
 * since a static one would hoist above this assignment.
 */
process.env.MAX_PORT_SLOTS = "2";

const { MAX_PORT_SLOTS, PORT_BLOCK_BASE, PORT_BLOCK_STRIDE, allocateSlot, blockFor, envFileFor } =
  await import("./ports.ts");

describe("block arithmetic", () => {
  test("a slot owns a contiguous inclusive block", () => {
    assert.deepEqual(blockFor(0, 4100, 10), { slot: 0, start: 4100, end: 4109 });
  });

  test("the last slot of a ten-wide pool ends exactly on the pool's upper bound", () => {
    // 4199, not 4200: an off-by-one here would put slot 9 one port into slot 10's
    // territory, which with the default cap does not exist but with a raised cap would.
    assert.deepEqual(blockFor(9, 4100, 10), { slot: 9, start: 4190, end: 4199 });
  });

  test("consecutive blocks abut without overlapping", () => {
    for (let slot = 0; slot < 9; slot++) {
      assert.equal(blockFor(slot + 1, 4100, 10).start, blockFor(slot, 4100, 10).end + 1);
    }
  });

  test("base and stride default to 4100 and 10, and blockFor uses them", () => {
    assert.equal(PORT_BLOCK_BASE, 4100);
    assert.equal(PORT_BLOCK_STRIDE, 10);
    assert.deepEqual(blockFor(3), { slot: 3, start: 4130, end: 4139 });
  });
});

describe("allocateSlot", () => {
  test("hands out the lowest free slot, not the next one up", () => {
    assert.deepEqual(allocateSlot([], 10), { ok: true, slot: 0 });
    assert.deepEqual(allocateSlot([0, 2, 3], 10), { ok: true, slot: 1 });
  });

  test("a released slot is reused rather than retired", () => {
    assert.deepEqual(allocateSlot([1, 2], 10), { ok: true, slot: 0 });
  });

  test("exhaustion is a named outcome carrying the cap, not a throw", () => {
    assert.deepEqual(allocateSlot([0, 1, 2], 3), { ok: false, reason: "pool_exhausted", cap: 3 });
  });

  test("the cap comes from MAX_PORT_SLOTS", () => {
    assert.equal(MAX_PORT_SLOTS, 2);
    assert.deepEqual(allocateSlot([0]), { ok: true, slot: 1 });
    assert.deepEqual(allocateSlot([0, 1]), { ok: false, reason: "pool_exhausted", cap: 2 });
  });
});

describe("envFileFor", () => {
  test("names the port and both bounds, and says what wrote it", () => {
    // The agent is told to read PORT from this file, so the keys are a contract with it and
    // with every project that already reads a .env.
    const lines = envFileFor(blockFor(1, 4100, 10), "ticket/demo/3").split("\n");
    assert.ok(lines.some((line) => line.startsWith("# Written by 10x")));
    assert.ok(lines.includes("PORT=4110"));
    assert.ok(lines.includes("PORT_RANGE_START=4110"));
    assert.ok(lines.includes("PORT_RANGE_END=4119"));
  });
});
