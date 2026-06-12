# Plugin governance

browxai plugins run in-process with full Node access. The trust tier
signals the review level applied to the plugin's code; it is not a
sandbox. Adopters should treat plugin trust like an npm dependency review
decision.

## Three tiers

- **`kalebtec`** — published under the `@browxai/*` npm scope, reviewed and
  released by the browxai maintainer, npm-provenance signed, listed in the
  curated registry. Identified by `"trust": "kalebtec"` in the plugin
  manifest **and** the scope match — both required.

- **`verified-community`** — third-party plugin that has passed a documented
  review: capability disclosure, code review, signing requirement. Listed in
  the curated registry with the reviewing maintainer named. Identified by
  `"trust": "verified-community"`.

- **`unverified`** — everything else. Default for any plugin not in the
  registry. Loads with a startup warning naming the capabilities the plugin
  has requested.

## Earning `verified-community`

Open a registry-listing issue with:

- Plugin source URL (public repo).
- Capability list with per-capability justification.
- Threat-model row per declared capability.
- Signing key fingerprint.
- Maintainer contact.

Review SLA is best-effort; no guarantee.

## Capability disclosure requirement

Every published plugin manifest must declare every capability the plugin
activates or requests. Runtime mismatch between declared and actual
capability set is a startup-fatal error.

## Adopter disclaimer

Plugins run with full Node access. browxai does not sandbox plugins.
Running an `unverified` plugin is an explicit trust decision. Use
`kalebtec` and `verified-community` tiers for adopters with low trust
budgets.

## Revocation

The maintainer may remove a `verified-community` plugin from the registry
for capability-drift, dormant maintenance, or disclosed unfixed
vulnerabilities. Listed plugins respond to security reports within the
same SLA browxai publishes (see `SECURITY.md`).
