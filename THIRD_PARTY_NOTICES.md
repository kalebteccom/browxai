# Third-party notices

browxai is distributed under the MIT license (see [`LICENSE`](LICENSE)).
The published packages depend on the following third-party software.

## `browxai` (host package)

Direct production dependencies:

- **`@modelcontextprotocol/sdk`** — MIT.
  Copyright Anthropic, PBC.
  <https://github.com/modelcontextprotocol/typescript-sdk>
- **`playwright-core`** — Apache-2.0.
  Copyright Microsoft Corporation.
  <https://github.com/microsoft/playwright>
  (ships its own `NOTICE` file, installed alongside the package)
- **`zod`** — MIT.
  Copyright Colin McDonnell.
  <https://github.com/colinhacks/zod>

These packages pull in their own (transitive) production dependencies;
every package in the installed tree carries its license text at
`node_modules/<name>/LICENSE` (or `LICENSE.md`/`LICENSE.txt`), and the
`pnpm licenses:check` CI gate restricts the production tree to the
allowlist `MIT / Apache-2.0 / BSD-2-Clause / BSD-3-Clause / ISC / 0BSD /
Unlicense / CC0-1.0`. A machine-readable inventory (CycloneDX SBOM,
`sbom.cdx.json`) is attached to every GitHub Release.

The optional `pnpm install-browser` step downloads Chromium via
`playwright-core`; Chromium is licensed under the BSD-3-Clause license
and bundles its own third-party notices (`chrome://credits`).

## `@browxai/plugin-example`, `@browxai/plugin-figma`, `@browxai/plugin-tldraw`, `@browxai/plugin-excalidraw`

No production dependencies — the host provides the plugin runtime API.
The canvas adapter plugins (`figma`, `tldraw`, `excalidraw`) drive the
respective web applications through the browser; they do not bundle or
link any code from those applications.

---

This file is reviewed on every production-dependency change.
`pnpm licenses:check` gates the production tree against the license
allowlist in CI; `pnpm licenses:notices` prints the raw per-package
inventory (name, license, repository, publisher) for review.
