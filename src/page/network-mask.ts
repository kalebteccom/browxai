// Shared egress-masking helpers for the network/WebSocket capture modules.
// One chokepoint so the URL-sanitiser + per-session secrets-masking order is
// identical across the CDP (`network.ts`), Playwright (`network-playwright.ts`),
// and WebSocket (`network-ws.ts`) paths.

import { sanitizeUrl, sanitizeUrlsInText } from "../util/url-sanitizer.js";
import type { SecretRegistry } from "../util/secrets.js";

/** Apply the URL sanitiser (strips credentials / secret-shaped query
 *  params) then the per-session secrets-masking layer. Order matters:
 *  secrets-masking is literal substring; the URL sanitiser may already
 *  have stripped a credentialled query, but a real-value that landed in
 *  the path is still caught by the literal scan after. */
export function maskedUrl(url: string, secrets: SecretRegistry | null): string {
  const u = sanitizeUrl(url);
  return secrets ? secrets.applyMaskInText(u) : u;
}

export function maskedText(text: string, secrets: SecretRegistry | null): string {
  const t = sanitizeUrlsInText(text);
  return secrets ? secrets.applyMaskInText(t) : t;
}
