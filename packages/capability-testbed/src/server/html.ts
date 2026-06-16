// Tiny HTML helpers so surfaces stay terse and consistent. No templating dep —
// just string composition. `esc()` guards interpolated text; `doc()` wraps a
// body in a complete, stable document shell (stable <title>, a data-surface
// marker on <body>, and a back-link) so snapshot/find/verify have predictable
// anchors across every surface.

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface DocOpts {
  /** Extra <head> content (inline <style>, <link>, <meta>). */
  readonly head?: string;
  /** Inline <script> appended at end of <body> (NOT escaped — it is code). */
  readonly script?: string;
  /** data-surface attribute value (defaults to title). */
  readonly surfaceId?: string;
}

export function doc(title: string, body: string, opts: DocOpts = {}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 2rem; max-width: 60rem; }
  h1, h2 { line-height: 1.2; }
  a { color: #0b6; }
  .card { border: 1px solid #8884; border-radius: 8px; padding: 1rem; margin: 1rem 0; }
  button, input, select, textarea { font: inherit; padding: .35rem .5rem; }
  [data-status] { font-family: ui-monospace, monospace; }
</style>
${opts.head ?? ""}
</head>
<body data-surface="${esc(opts.surfaceId ?? title)}">
<nav><a href="/" data-testid="home">&larr; testbed index</a></nav>
<h1 data-testid="surface-title">${esc(title)}</h1>
${body}
${opts.script ? `<script>${opts.script}</script>` : ""}
</body>
</html>`;
}

/** JSON response helper for surface routes. */
export function json(value: unknown): { type: string; body: string } {
  return { type: "application/json; charset=utf-8", body: JSON.stringify(value) };
}
