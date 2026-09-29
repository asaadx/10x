/**
 * A self-scheduling loop that can never overlap itself.
 *
 * The board has exactly one way to learn that a cloud agent finished: poll the row the agent
 * wrote into (docs/prototype-cloud.md). Against Turso every tick is network I/O of unbounded
 * latency, so `setInterval` is wrong here — a slow tick would have the next one start on top of
 * it, and two ticks racing the same CAS is harmless only until one of them grows a side effect.
 * The next tick is scheduled only after the previous one settled, so there is never more than
 * one in flight.
 */
export type Poller = {
  /** Stop scheduling, and resolve once any tick already running has finished. */
  stop(): Promise<void>;
};

export function startPoller(
  tick: () => Promise<void>,
  intervalMs: number,
  onError: (err: unknown) => void = (err) => console.warn("poll tick failed:", err),
): Poller {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      // A failed tick is reported and the loop carries on: one bad network round trip must
      // not stop the board noticing finished agents for the rest of its life.
      running = tick().catch(onError).finally(schedule);
    }, intervalMs);
  };
  schedule();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
  };
}
