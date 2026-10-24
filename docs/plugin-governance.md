# Plugin governance

browxai plugins run **in-process with full Node access**. The trust tier is an
advisory label describing where a plugin came from. It is not a sandbox, and it
changes nothing at runtime: the loader gates `kalebtec`, `community` and `local`
identically at capability-check and call-graph time.

Treat installing a plugin exactly like adding an npm dependency, because
mechanically that is what it is.

## Three tiers

The tier is **derived from how the package was installed**, never asserted by
the plugin.

- **`kalebtec`**: published under the `@browxai/*` npm scope, released from the
  browxai monorepo through the same OIDC trusted-publishing pipeline as the host
  package, npm-provenance signed. A plugin gets this tier only when
  `plugins-lock.json` records all of the following for it:
  - a plain registry spec of exactly its `@browxai/*` name
    (`@browxai/plugin-figma` or `@browxai/plugin-figma@^0.1.0`), with no
    `npm:` alias, git URL, tarball URL or `file:` path;
  - the registry integrity hash the package manager recorded for that name and
    version;
  - an installed `package.json` whose `name` is that same name.

  A package name alone does not count: an install can alias any package to an
  `@browxai/*` name, and a git dependency can name itself anything. A
  `"trust": "kalebtec"` claim, in a manifest or in `plugins.json`, is dropped
  with a warning when the lock does not back it.

- **`community`**: everything else that is not a `file:` install, including an
  `@browxai/*` name installed by alias, from git or from a tarball URL.

- **`local`**: installed from a `file:` path. Used during plugin development
  (`browxai plugin install file:./my-plugin/`).

An operator can override the tier per entry in `plugins.json`:

```jsonc
{
  "plugins": {
    "my-local-plugin": { "enabled": true, "trust": "local" },
  },
}
```

The operator override wins for `community` and `local`, because the operator is
the only party who can decide what to run. A plugin cannot upgrade itself, and
an override to `kalebtec` holds only for an install the lock backs as above.

`browxai plugin install`, `upgrade` and `sync` run the package manager with
lifecycle scripts off (`--ignore-scripts`). A plugin ships built code, so
nothing in the plugin contract runs at install time.

## Capability disclosure

A plugin manifest declares the capabilities its tools need. At load the runtime
checks that the declared set is a subset of the capability set the server
resolved at boot.

On mismatch the **plugin** is disabled with status
`disabled-by-capability-mismatch` and a warning naming the missing capability.
The server still starts and every other plugin still loads. A capability
mismatch is not fatal to the process.

At boot the server names every non-first-party plugin that loaded, with the
capabilities each declared, so an operator sees third-party in-process code
without having to go looking for it. First-party `@browxai/*` plugins load
quietly.

This is a **load-time set check, not runtime enforcement.** Nothing intercepts a
plugin's calls to verify it only touches what it declared. A plugin that
declares nothing and then reads the filesystem directly is not detected, because
it runs in the host process with the host's permissions. The declaration is a
disclosure mechanism for the operator reading `plugins_list`, and it is only as
honest as the plugin.

## What the tiers do not do

There is no curated registry, no review SLA, and no signing-key verification in
the loader today. If you are looking for the review process an earlier version
of this page described, it does not exist. The tier tells you where the code
came from and nothing more.

## Adopter guidance

Because plugins run with full Node access in the host process:

- Prefer `@browxai/*` first-party plugins.
- Read what a third-party plugin declares before enabling it:
  `browxai plugin info <pkg>`, and audit the live set with `plugins_list`.
- Grant only the capabilities the plugin actually needs. The capability gate
  narrows what the plugin's **tools** can reach through the host; it does not
  constrain what the plugin's own code can do.
- For a low trust budget, the containment that actually contains is
  infrastructure: run the server in a container or a VM with a non-root user.
  See [best practices for adopters](/security-best-practices-for-adopters/).

## Revocation

Removal from a curated registry is not available, since there is no registry.
What an operator can do today is remove the entry from `plugins.json` and
re-run `browxai plugin sync`. Security reports against a first-party plugin
follow the disclosure policy in [`SECURITY.md`](../SECURITY.md).
