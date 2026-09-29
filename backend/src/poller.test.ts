/**
 * Tests for poller.ts: the loop never runs two ticks at once, survives a failing tick, and
 * `stop()` waits for the tick in flight — the properties that make it safe against Turso's
 * unbounded latency and safe to stop on server close.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { startPoller } from "./poller.ts";

test("a tick slower than the interval never overlaps the next", async () => {
  let running = 0;
  let maxRunning = 0;
  let ticks = 0;
  const poller = startPoller(async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await delay(30);
    ticks += 1;
    running -= 1;
  }, 5);
  await delay(200);
  await poller.stop();
  assert.equal(maxRunning, 1);
  assert.ok(ticks >= 3, `expected several ticks, got ${ticks}`);
});

test("a failing tick is reported and the loop carries on", async () => {
  let ticks = 0;
  const errors: unknown[] = [];
  const poller = startPoller(
    async () => {
      ticks += 1;
      throw new Error(`tick ${ticks}`);
    },
    5,
    (err) => errors.push(err),
  );
  await delay(80);
  await poller.stop();
  assert.ok(ticks >= 2);
  assert.equal(errors.length, ticks);
});

test("stop waits for the tick in flight and schedules nothing after it", async () => {
  let finished = false;
  let ticks = 0;
  const poller = startPoller(async () => {
    ticks += 1;
    await delay(60);
    finished = true;
  }, 1);
  await delay(20); // inside the first tick
  await poller.stop();
  assert.equal(finished, true);
  const after = ticks;
  await delay(50);
  assert.equal(ticks, after);
});
