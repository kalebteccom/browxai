// Ring buffer of console messages + page errors, hooked off Playwright Page events.
// Always-on (cheap); ActionResult slices the "since action started" view; the
// `console_read` MCP tool exposes the buffer.

import type { Page } from "playwright-core";
import { sanitizeUrlsInText } from "../util/url-sanitizer.js";

export interface ConsoleMessage {
  ts: number; // epoch ms
  type: string; // "log" | "warn" | "error" | "info" | ...
  text: string;
}

const DEFAULT_CAP = 200;

export class ConsoleBuffer {
  private msgs: ConsoleMessage[] = [];
  private errs: { ts: number; text: string }[] = [];

  constructor(private cap: number = DEFAULT_CAP) {}

  attach(page: Page): void {
    page.on("console", (m) => {
      this.msgs.push({ ts: Date.now(), type: m.type(), text: m.text() });
      if (this.msgs.length > this.cap) this.msgs.shift();
    });
    page.on("pageerror", (err) => {
      this.errs.push({ ts: Date.now(), text: err.message });
      if (this.errs.length > this.cap) this.errs.shift();
    });
  }

  // URL substrings in console / page-error text are sanitized at the egress
  // boundary (read time) — the ring keeps raw text; only what leaves the
  // server toward an MCP result is redacted.
  recent(limit = 50): ConsoleMessage[] {
    return this.msgs.slice(-limit).map((m) => ({ ...m, text: sanitizeUrlsInText(m.text) }));
  }
  errorsSince(ts: number): string[] {
    return this.msgs
      .filter((m) => m.type === "error" && m.ts >= ts)
      .map((m) => sanitizeUrlsInText(m.text));
  }
  pageErrorsSince(ts: number): string[] {
    return this.errs.filter((e) => e.ts >= ts).map((e) => sanitizeUrlsInText(e.text));
  }
  warningCountSince(ts: number): number {
    return this.msgs.filter((m) => m.type === "warning" && m.ts >= ts).length;
  }
}
