import { describe, it, expect, vi } from "vitest";
import { SeededRandomRegistry, _internal } from "./seed-random.js";

function fakeContext() {
  const initScripts: string[] = [];
  const ctx = {
    addInitScript: vi.fn(async (arg: { content: string }) => {
      initScripts.push(arg.content);
    }),
  };
  return { ctx, initScripts };
}

function fakePage() {
  const handlers: Record<string, Array<(arg: unknown) => unknown>> = {};
  const evaluates: string[] = [];
  const page = {
    on: vi.fn((event: string, h: (arg: unknown) => unknown) => {
      (handlers[event] ??= []).push(h);
    }),
    evaluate: vi.fn(async (script: string) => {
      evaluates.push(script);
      return undefined;
    }),
    _emit: async (event: string, arg: unknown): Promise<void> => {
      for (const h of handlers[event] ?? []) {
        await h(arg);
      }
    },
  };
  return { page, evaluates };
}

function frame(isMain = true) {
  return { parentFrame: () => (isMain ? null : {}) };
}

/** Evaluate the init-script source in an isolated Math-like sandbox. The
 *  script references `Math` / `Object` / `globalThis` — we run it as a
 *  Function body with a custom globalThis to keep the host's Math.random
 *  untouched. */
function runInitScript(script: string): {
  math: { random: () => number };
  globalThis: Record<string, unknown>;
} {
  const fakeMath: { random: () => number } & Record<string, unknown> = {
    random: () => 0,
    imul: Math.imul,
  };
  const sandbox: Record<string, unknown> = { Math: fakeMath };
  // Re-implement Object.defineProperty / Object.prototype.hasOwnProperty
  // pass-through via the real Object; we expose it as `Object`.
  sandbox.Object = Object;
  sandbox.globalThis = sandbox;
  // Run the script: `(() => { ... })()` — invoke with `with(sandbox)` so all
  // top-level names resolve out of the sandbox.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("sandbox", `with (sandbox) { ${script} }`);
  fn(sandbox);
  return { math: fakeMath, globalThis: sandbox };
}

describe("SeededRandomRegistry — init script", () => {
  it("produces a deterministic stream for a given seed", () => {
    const { math: m1 } = runInitScript(_internal.buildInitScript(42));
    const { math: m2 } = runInitScript(_internal.buildInitScript(42));
    const a = [m1.random(), m1.random(), m1.random(), m1.random(), m1.random()];
    const b = [m2.random(), m2.random(), m2.random(), m2.random(), m2.random()];
    expect(a).toEqual(b);
    // sanity: not all zero, not all equal — i.e. the PRNG actually mixes
    expect(new Set(a).size).toBeGreaterThan(1);
    a.forEach((n) => {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    });
  });

  it("different seeds produce different streams", () => {
    const { math: m1 } = runInitScript(_internal.buildInitScript(1));
    const { math: m2 } = runInitScript(_internal.buildInitScript(2));
    expect(m1.random()).not.toBe(m2.random());
  });

  it("idempotent re-run on the same realm only updates state (no double-install)", () => {
    const { math, globalThis: g } = runInitScript(_internal.buildInitScript(7));
    const first = math.random();
    // Re-run with a new seed in the same realm
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function("sandbox", `with (sandbox) { ${_internal.buildInitScript(99)} }`);
    fn(g);
    // After re-seed, the next value should be the FIRST value of seed=99's stream
    const { math: fresh } = runInitScript(_internal.buildInitScript(99));
    expect(math.random()).toBe(fresh.random());
    // and not the second value of seed=7's stream
    expect(first).not.toBe(math.random);
  });
});

describe("SeededRandomRegistry — apply", () => {
  it("installs the init script on the context on first apply", async () => {
    const { ctx, initScripts } = fakeContext();
    const { page } = fakePage();
    const reg = new SeededRandomRegistry();
    const { state } = await reg.apply(ctx as never, page as never, { seed: 123 });
    expect(state).toEqual({ seed: 123 });
    expect(ctx.addInitScript).toHaveBeenCalledTimes(1);
    expect(initScripts[0]).toContain("123");
  });

  it("re-applies on the current page immediately via page.evaluate", async () => {
    const { ctx } = fakeContext();
    const { page, evaluates } = fakePage();
    const reg = new SeededRandomRegistry();
    await reg.apply(ctx as never, page as never, { seed: 5 });
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(evaluates[0]).toContain("5");
  });

  it("subsequent applies do NOT re-install the context init script", async () => {
    const { ctx } = fakeContext();
    const { page } = fakePage();
    const reg = new SeededRandomRegistry();
    await reg.apply(ctx as never, page as never, { seed: 1 });
    await reg.apply(ctx as never, page as never, { seed: 2 });
    expect(ctx.addInitScript).toHaveBeenCalledTimes(1);
    // but the current-page push happens every apply
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(reg.current()).toEqual({ seed: 2 });
  });

  it("rejects invalid seeds", async () => {
    const { ctx } = fakeContext();
    const { page } = fakePage();
    const reg = new SeededRandomRegistry();
    await expect(reg.apply(ctx as never, page as never, { seed: -1 })).rejects.toThrow(/seed/);
    await expect(reg.apply(ctx as never, page as never, { seed: 1.5 })).rejects.toThrow(/seed/);
    await expect(reg.apply(ctx as never, page as never, { seed: 2 ** 33 })).rejects.toThrow(/seed/);
    await expect(reg.apply(ctx as never, page as never, { seed: NaN })).rejects.toThrow(/seed/);
  });

  it("accepts seed 0", async () => {
    const { ctx } = fakeContext();
    const { page } = fakePage();
    const reg = new SeededRandomRegistry();
    const { state } = await reg.apply(ctx as never, page as never, { seed: 0 });
    expect(state.seed).toBe(0);
  });
});

describe("SeededRandomRegistry — re-apply on navigation", () => {
  it("re-pushes the cached seed on main-frame framenavigated", async () => {
    const { ctx } = fakeContext();
    const { page, evaluates } = fakePage();
    const reg = new SeededRandomRegistry();
    await reg.apply(ctx as never, page as never, { seed: 9 });
    const initialPushes = evaluates.length;

    // Sub-frame nav: ignored
    await (page as unknown as { _emit: (e: string, a: unknown) => Promise<void> })._emit(
      "framenavigated",
      frame(false),
    );
    expect(evaluates.length).toBe(initialPushes);

    // Main-frame nav: cached seed re-pushed onto the page realm
    await (page as unknown as { _emit: (e: string, a: unknown) => Promise<void> })._emit(
      "framenavigated",
      frame(true),
    );
    expect(evaluates.length).toBe(initialPushes + 1);
    expect(evaluates[evaluates.length - 1]).toContain("9");
  });

  it("only installs the reattach hook once per page", async () => {
    const { ctx } = fakeContext();
    const { page } = fakePage();
    const reg = new SeededRandomRegistry();
    await reg.apply(ctx as never, page as never, { seed: 1 });
    await reg.apply(ctx as never, page as never, { seed: 2 });
    await reg.apply(ctx as never, page as never, { seed: 3 });
    expect(
      (page.on as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "framenavigated"),
    ).toHaveLength(1);
  });
});
