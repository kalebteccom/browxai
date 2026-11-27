// A clock for the daemon drain tests that the test moves by hand. Test code only.

import type { DrainClock } from "../serve-drain.js";

/** `advance` moves the clock and runs each timer as it comes due. */
export function fakeDrainClock(start = Date.parse("2026-11-27T12:00:00.000Z")) {
  let now = start;
  const timers: Array<{ ms: number; fn: () => void; next: number; live: boolean }> = [];
  const clock: DrainClock = {
    now: () => now,
    every: (ms, fn) => {
      const t = { ms, fn, next: now + ms, live: true };
      timers.push(t);
      return () => {
        t.live = false;
      };
    },
  };
  const advance = (ms: number): void => {
    const end = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.next <= end).sort((a, b) => a.next - b.next)[0];
      if (!due) break;
      now = due.next;
      due.next += due.ms;
      due.fn();
    }
    now = end;
  };
  return { clock, advance, live: () => timers.filter((t) => t.live).length };
}
