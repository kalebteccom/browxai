// Ring buffer of console messages + page errors, hooked off Playwright Page events.
// Always-on (cheap); ActionResult slices the "since action started" view; the
// `console_read` MCP tool exposes the buffer.

import type { Page } from "playwright-core";
import { sanitizeUrlsInText } from "../util/url-sanitizer.js";
import type { SecretRegistry } from "../util/secrets.js";

export interface ConsoleMessage {
  ts: number; // epoch ms
  type: string; // "log" | "warn" | "error" | "info" | ...
  text: string;
}

const DEFAULT_CAP = 200;

export class ConsoleBuffer {
  private msgs: ConsoleMessage[] = [];
  private errs: { ts: number; text: string }[] = [];
  /** Optional per-session secrets registry. Injected by the server after
   *  session creation so the egress masking layer applies on every read. */
  private secrets: SecretRegistry | null = null;

  constructor(private cap: number = DEFAULT_CAP) {}

  /** Wire a per-session secrets registry. After this, every `recent` /
   *  `errorsSince` / `pageErrorsSince` read substitutes registered real-values
   *  with their `<NAME>` aliases AFTER the URL sanitiser runs (the
   *  query-string secret-stripper that runs first so encoded secrets in URLs
   *  don't leak past the name-substitution pass). */
  setSecrets(secrets: SecretRegistry): void {
    this.secrets = secrets;
  }

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

  /** Ingest a console entry from a NON-Playwright source — the safari engine has
   *  no Playwright Page, so its console arrives via the BiDi `log.entryAdded`
   *  stream. Mirrors the `page.on("console")` push so
   *  `recent()` / `warningCountSince()` / `errorsSince()` work identically. The
   *  BiDi level (`debug`/`info`/`warn`/`error`) is mapped to the console `type`
   *  vocabulary (`warn` → `warning`) the readers key on. */
  ingest(level: string, text: string): void {
    const type = level === "warn" ? "warning" : level;
    this.msgs.push({ ts: Date.now(), type, text });
    if (this.msgs.length > this.cap) this.msgs.shift();
  }

  /** Compose the two egress layers: URL-sanitise first (regex on URL shape),
   *  then secrets-mask (literal real-value substitution). They don't fight —
   *  the URL sanitiser already redacted `?token=…`; the literal scan still
   *  catches a registered secret that landed elsewhere in the text. */
  private sanitiseEgress(text: string): string {
    const afterUrl = sanitizeUrlsInText(text);
    return this.secrets ? this.secrets.applyMaskInText(afterUrl) : afterUrl;
  }

  // URL substrings + registered-secret values in console / page-error text are
  // sanitized at the egress boundary (read time) — the ring keeps raw text;
  // only what leaves the server toward an MCP result is redacted.
  recent(limit = 50): ConsoleMessage[] {
    return this.msgs.slice(-limit).map((m) => ({ ...m, text: this.sanitiseEgress(m.text) }));
  }
  errorsSince(ts: number): string[] {
    return this.msgs
      .filter((m) => m.type === "error" && m.ts >= ts)
      .map((m) => this.sanitiseEgress(m.text));
  }
  pageErrorsSince(ts: number): string[] {
    return this.errs.filter((e) => e.ts >= ts).map((e) => this.sanitiseEgress(e.text));
  }
  warningCountSince(ts: number): number {
    return this.msgs.filter((m) => m.type === "warning" && m.ts >= ts).length;
  }
}
