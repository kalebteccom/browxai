// The one place that decides which origin a `blob:` or `filesystem:` URL
// belongs to. The origin allowlist (`policy/origin.ts`) and the secret scope
// (`util/secret-scope.ts`) both read it, so a scope and the allowlist agree on
// every URL.

const WRAPPED_SCHEMES = new Set(["blob:", "filesystem:"]);

/** How many wrapper schemes `unwrapOrigin` peels before it gives up. */
export const MAX_UNWRAP_DEPTH = 2;

/** `new URL(s)`, or null when it does not parse. */
export function safeUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** `blob:https://a.example/uuid` and `filesystem:https://a.example/temporary/x`
 *  belong to the origin that follows the scheme. Returns that inner URL, or null
 *  when it does not parse (or wraps another wrapper past `MAX_UNWRAP_DEPTH`). A
 *  URL that is not wrapped comes back as it is. */
export function unwrapOrigin(candidate: URL): URL | null {
  let current = candidate;
  // cap: at most `MAX_UNWRAP_DEPTH` wrapper schemes are peeled, then it returns null.
  for (let depth = 0; WRAPPED_SCHEMES.has(current.protocol); depth++) {
    if (depth >= MAX_UNWRAP_DEPTH) return null;
    const inner = safeUrl(current.href.slice(current.protocol.length));
    if (!inner) return null;
    current = inner;
  }
  return current;
}
