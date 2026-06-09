import { describe, it, expect, vi } from "vitest";
import {
  DialogPolicyState,
  installDialogHandler,
  attachDialogPolicy,
  parseDialogPolicyArg,
  UNHANDLED_DIALOG_HINT,
} from "./dialog.js";
import type { BrowserContext, Dialog, Page } from "playwright-core";

// Minimal Page mock — exposes the `dialog` event hook + lets the test simulate
// a fire. The real Playwright Page has a much larger surface; the handler
// module only consumes `on("dialog", fn)`, so that's all we mock.
function fakePage(): { page: Page; fireDialog: (d: Dialog) => Promise<void> } {
  let handler: ((d: Dialog) => void) | null = null;
  const page = {
    on: (event: string, fn: (d: Dialog) => void) => {
      if (event === "dialog") handler = fn;
    },
  } as unknown as Page;
  return {
    page,
    fireDialog: async (d) => {
      if (!handler) throw new Error("test: no handler installed");
      handler(d);
      // dispatch is async-internal; wait a microtask + a tick so the handler's
      // `await d.accept()` / `await d.dismiss()` resolves before assertions.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

function fakeContext(initialPages: Page[] = []): {
  ctx: BrowserContext;
  firePageEvent: (p: Page) => void;
} {
  let pageHandler: ((p: Page) => void) | null = null;
  const ctx = {
    pages: () => initialPages,
    on: (event: string, fn: (p: Page) => void) => {
      if (event === "page") pageHandler = fn;
    },
  } as unknown as BrowserContext;
  return {
    ctx,
    firePageEvent: (p) => {
      if (pageHandler) pageHandler(p);
    },
  };
}

function makeDialog(opts: {
  kind?: "alert" | "confirm" | "prompt" | "beforeunload";
  message?: string;
  defaultValue?: string;
}): Dialog & { accept: ReturnType<typeof vi.fn>; dismiss: ReturnType<typeof vi.fn> } {
  const accept = vi.fn(async () => undefined);
  const dismiss = vi.fn(async () => undefined);
  return {
    type: () => opts.kind ?? "alert",
    message: () => opts.message ?? "",
    defaultValue: () => opts.defaultValue ?? "",
    accept,
    dismiss,
  } as unknown as Dialog & { accept: typeof accept; dismiss: typeof dismiss };
}

describe("parseDialogPolicyArg", () => {
  it("defaults to raise when undefined", () => {
    expect(parseDialogPolicyArg(undefined)).toEqual({ mode: "raise" });
  });

  it("parses each simple mode", () => {
    expect(parseDialogPolicyArg("accept")).toEqual({ mode: "accept" });
    expect(parseDialogPolicyArg("dismiss")).toEqual({ mode: "dismiss" });
    expect(parseDialogPolicyArg("raise")).toEqual({ mode: "raise" });
  });

  it("parses accept-prompt-with:<text>", () => {
    expect(parseDialogPolicyArg("accept-prompt-with:hello world")).toEqual({
      mode: "accept-prompt-with",
      text: "hello world",
    });
  });

  it("accepts an empty answer (`accept-prompt-with:`)", () => {
    expect(parseDialogPolicyArg("accept-prompt-with:")).toEqual({
      mode: "accept-prompt-with",
      text: "",
    });
  });

  it("rejects unknown values", () => {
    expect(() => parseDialogPolicyArg("noop")).toThrow(/invalid/i);
  });
});

describe("DialogPolicyState — per-policy handling", () => {
  it('`accept` mode accepts every dialog and records handledAs="accepted"', async () => {
    const state = new DialogPolicyState({ mode: "accept" });
    const { page, fireDialog } = fakePage();
    installDialogHandler(page, state);
    const t = Date.now();
    const d = makeDialog({ kind: "confirm", message: "go?" });
    await fireDialog(d);
    expect(d.accept).toHaveBeenCalledTimes(1);
    expect(d.dismiss).not.toHaveBeenCalled();
    const slice = state.since(t);
    expect(slice).toHaveLength(1);
    expect(slice[0]?.handledAs).toBe("accepted");
    expect(slice[0]?.kind).toBe("confirm");
    expect(slice[0]?.message).toBe("go?");
  });

  it('`dismiss` mode dismisses every dialog and records handledAs="dismissed"', async () => {
    const state = new DialogPolicyState({ mode: "dismiss" });
    const { page, fireDialog } = fakePage();
    installDialogHandler(page, state);
    const t = Date.now();
    await fireDialog(makeDialog({ kind: "prompt", message: "name?" }));
    const slice = state.since(t);
    expect(slice[0]?.handledAs).toBe("dismissed");
  });

  it("`accept-prompt-with:<text>` answers prompts with text but plain-accepts alert/confirm", async () => {
    const state = new DialogPolicyState({ mode: "accept-prompt-with", text: "Codex" });
    const { page, fireDialog } = fakePage();
    installDialogHandler(page, state);
    const promptDlg = makeDialog({ kind: "prompt", message: "name?" });
    const alertDlg = makeDialog({ kind: "alert", message: "saved" });
    await fireDialog(promptDlg);
    await fireDialog(alertDlg);
    expect(promptDlg.accept).toHaveBeenCalledWith("Codex");
    expect(alertDlg.accept).toHaveBeenCalledWith();
  });

  it("`raise` mode (DEFAULT) DISMISSES server-side (no deadlock) AND flags raisedSince", async () => {
    const state = new DialogPolicyState(); // default = raise
    expect(state.current()).toEqual({ mode: "raise" });
    const { page, fireDialog } = fakePage();
    installDialogHandler(page, state);
    const t = Date.now();
    const d = makeDialog({ kind: "confirm", message: "delete?" });
    await fireDialog(d);
    // The deadlock-protection guarantee: the dialog MUST be acted on so the
    // page unblocks. Dismiss is the safe-by-default choice.
    expect(d.dismiss).toHaveBeenCalledTimes(1);
    expect(d.accept).not.toHaveBeenCalled();
    expect(state.raisedSince(t)).toBe(true);
    expect(state.since(t)[0]?.handledAs).toBe("raised");
  });

  it("UNHANDLED_DIALOG_HINT mentions both set knobs", () => {
    expect(UNHANDLED_DIALOG_HINT).toMatch(/open_session/);
    expect(UNHANDLED_DIALOG_HINT).toMatch(/set_dialog_policy/);
    expect(UNHANDLED_DIALOG_HINT).toMatch(/dismissed server-side/);
  });
});

describe("DialogPolicyState — runtime mutation via .set()", () => {
  it("set() flips policy for the NEXT dialog; prior dialogs keep their handledAs", async () => {
    const state = new DialogPolicyState({ mode: "accept" });
    const { page, fireDialog } = fakePage();
    installDialogHandler(page, state);
    const t0 = Date.now();
    const d1 = makeDialog({ kind: "alert" });
    await fireDialog(d1);
    expect(d1.accept).toHaveBeenCalled();

    state.set({ mode: "dismiss" });
    const d2 = makeDialog({ kind: "confirm" });
    await fireDialog(d2);
    expect(d2.dismiss).toHaveBeenCalled();
    expect(d2.accept).not.toHaveBeenCalled();

    const records = state.since(t0);
    expect(records.map((r) => r.handledAs)).toEqual(["accepted", "dismissed"]);
  });

  it("set() to accept-prompt-with requires text — throws otherwise", () => {
    const state = new DialogPolicyState();

    expect(() => state.set({ mode: "accept-prompt-with" } as any)).toThrow(/text/i);
  });
});

describe("attachDialogPolicy — persistence across navigation/new pages", () => {
  it("installs the handler on every initially-attached page AND on future `context.on('page')` pages", async () => {
    const state = new DialogPolicyState({ mode: "accept" });
    const p1 = fakePage();
    const { ctx, firePageEvent } = fakeContext([p1.page]);

    attachDialogPolicy(ctx, state);
    // Existing page is wired.
    expect(state.hasPage(p1.page)).toBe(true);

    // A new page added later (the navigation/popup case) also gets wired.
    const p2 = fakePage();
    firePageEvent(p2.page);
    expect(state.hasPage(p2.page)).toBe(true);

    // The policy is shared across both — a runtime set() applies to whichever
    // page fires next (proves the BYOB-reconnect / cross-navigation
    // persistence requirement holds).
    state.set({ mode: "dismiss" });
    const d2 = makeDialog({ kind: "confirm" });
    await p2.fireDialog(d2);
    expect(d2.dismiss).toHaveBeenCalled();
  });

  it("installDialogHandler is idempotent on the same page (no double-wire)", () => {
    const state = new DialogPolicyState();
    const { page } = fakePage();
    let installs = 0;
    const orig = page.on as unknown as (e: string, f: unknown) => void;
    (page as unknown as { on: unknown }).on = (e: string, f: unknown) => {
      if (e === "dialog") installs++;
      orig.call(page, e, f);
    };
    installDialogHandler(page, state);
    installDialogHandler(page, state);
    installDialogHandler(page, state);
    expect(installs).toBe(1);
  });
});

describe("DialogPolicyState — anti-deadlock guarantee", () => {
  it("EVERY policy mode acts on the dialog (accept OR dismiss) — never leaves it pending", async () => {
    const modes: Array<{
      p: ConstructorParameters<typeof DialogPolicyState>[0];
      cb: "accept" | "dismiss";
    }> = [
      { p: { mode: "accept" }, cb: "accept" },
      { p: { mode: "dismiss" }, cb: "dismiss" },
      { p: { mode: "accept-prompt-with", text: "x" }, cb: "accept" },
      { p: { mode: "raise" }, cb: "dismiss" }, // raise dismisses to unblock
    ];
    for (const { p, cb } of modes) {
      const state = new DialogPolicyState(p);
      const { page, fireDialog } = fakePage();
      installDialogHandler(page, state);
      const d = makeDialog({ kind: "alert" });
      await fireDialog(d);
      if (cb === "accept") expect(d.accept, JSON.stringify(p)).toHaveBeenCalled();
      else expect(d.dismiss, JSON.stringify(p)).toHaveBeenCalled();
    }
  });

  it("a handler that throws does NOT propagate (page never sees an unhandled rejection)", async () => {
    const state = new DialogPolicyState({ mode: "accept" });
    const { page, fireDialog } = fakePage();
    installDialogHandler(page, state);
    // A pathological dialog whose accept() rejects — the handler must swallow.
    const d = {
      type: () => "alert",
      message: () => "x",
      defaultValue: () => "",
      accept: vi.fn(async () => {
        throw new Error("boom");
      }),
      dismiss: vi.fn(async () => undefined),
    } as unknown as Dialog;
    // No throw out of fireDialog.
    await expect(fireDialog(d)).resolves.toBeUndefined();
  });
});

describe("ActionResult.dialogs[] capture — buffer semantics", () => {
  it("since(ts) returns ONLY records at-or-after the timestamp", async () => {
    const state = new DialogPolicyState({ mode: "accept" });
    const { page, fireDialog } = fakePage();
    installDialogHandler(page, state);
    await fireDialog(makeDialog({ kind: "alert", message: "first" }));
    await new Promise((r) => setTimeout(r, 5));
    const t = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    await fireDialog(makeDialog({ kind: "alert", message: "second" }));
    const slice = state.since(t);
    expect(slice).toHaveLength(1);
    expect(slice[0]?.message).toBe("second");
  });

  it("buffer is capped — oldest record evicted past `cap`", async () => {
    const state = new DialogPolicyState({ mode: "accept" }, 3);
    const { page, fireDialog } = fakePage();
    installDialogHandler(page, state);
    for (let i = 0; i < 5; i++) {
      await fireDialog(makeDialog({ kind: "alert", message: `m${i}` }));
    }
    const slice = state.since(0);
    expect(slice).toHaveLength(3);
    expect(slice.map((r) => r.message)).toEqual(["m2", "m3", "m4"]);
  });
});
