/**
 * Port blocks for per-ticket dev servers.
 *
 * Pure and import-free, in the spirit of lifecycle.ts: allocation is the part that can
 * silently hand two tickets the same port, so it has to be testable without a database, a
 * Herdr session or an agent.
 *
 * A BOUNDED SLOT POOL, not `base + ticket.number`. Ticket numbers grow without bound and
 * would eventually walk into ports other software owns; a fixed pool cannot. A slot is
 * reused the moment it is released.
 *
 * A slot owns a BLOCK, not a single port. A project running Vite beside its API needs two,
 * and retrofitting a second port into a one-port-per-ticket scheme means renumbering
 * everything (memory/architecture.md), so the stride is there from the start.
 */

/**
 * Positive-integer override. A malformed value is a startup error rather than a silent
 * fallback: a typo'd cap that quietly stayed at 10 would look like a product bug later.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * How many tickets may hold a block at once. Ten is arbitrary, which is exactly why it is
 * configurable. Because a block is reserved at spawn — the port must exist before the agent
 * starts, to be injected into its environment — this is also a cap on concurrently
 * in-progress tickets: the next spawn is rejected, not queued.
 */
export const MAX_PORT_SLOTS = envInt("MAX_PORT_SLOTS", 10);

/**
 * First port of slot 0. With the defaults the pool is 4100-4199, clear of the board on 4010
 * and of the e2e harness on 4310.
 */
export const PORT_BLOCK_BASE = envInt("PORT_BLOCK_BASE", 4100);

/** Ports per slot: room for an API, a dev server, and whatever else one project runs. */
export const PORT_BLOCK_STRIDE = envInt("PORT_BLOCK_STRIDE", 10);

/** Inclusive. With the defaults slot 0 owns 4100-4109 and slot 9 owns 4190-4199. */
export type PortBlock = { slot: number; start: number; end: number };

export const blockFor = (
  slot: number,
  base = PORT_BLOCK_BASE,
  stride = PORT_BLOCK_STRIDE,
): PortBlock => ({
  slot,
  start: base + slot * stride,
  end: base + slot * stride + stride - 1,
});

/**
 * Exhaustion is a value, not a throw. The caller turns it into a 409 carrying the cap, and
 * a thrown string would have to be parsed back apart to say what the limit was.
 */
export type SlotAllocation =
  | { ok: true; slot: number }
  | { ok: false; reason: "pool_exhausted"; cap: number };

/**
 * Lowest free slot. Lowest rather than one-past-the-highest so a long-lived board keeps
 * reusing the same low ports instead of drifting up the pool as tickets come and go.
 */
export function allocateSlot(held: Iterable<number>, cap = MAX_PORT_SLOTS): SlotAllocation {
  const taken = new Set(held);
  for (let slot = 0; slot < cap; slot++) {
    if (!taken.has(slot)) return { ok: true, slot };
  }
  return { ok: false, reason: "pool_exhausted", cap };
}

/** The file 10x writes into a ticket's worktree so the agent can read its port. */
export const ENV_FILE = ".env";

/**
 * Its contents. Commented because a human who opens it inside a worktree deserves to know
 * what wrote it and why. `PORT` first — it is the one variable projects already read — with
 * the bounds alongside for anything that runs more than one service.
 */
export const envFileFor = (block: PortBlock, ticket: string): string =>
  [
    `# Written by 10x when it spawned the agent for ${ticket}.`,
    `# This worktree owns TCP ports ${block.start}-${block.end}; every other port belongs to`,
    "# another ticket or to the board itself. Machine-local — it is git-excluded, not tracked.",
    `PORT=${block.start}`,
    `PORT_RANGE_START=${block.start}`,
    `PORT_RANGE_END=${block.end}`,
    "",
  ].join("\n");
