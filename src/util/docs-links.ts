/**
 * Public documentation URLs for text the server generates (refusals, doctor
 * rows, startup warnings, tool descriptions). The npm tarball ships `dist/`
 * only, so a `docs/...` path in a message points at nothing in an installed
 * package; these resolve on the live site instead.
 *
 * Paths follow the site build: `website/scripts/doc-pipeline.mjs` maps each
 * `docs/*.md` source to the page below.
 */
export const DOCS_SITE = "https://browxai.com";

export const REPO_URL = "https://github.com/kalebteccom/browxai";

/**
 * A link to a page on the site, optionally to a heading on it. `anchor` is the
 * heading id the site build generates, without the `#`. Keep each anchor in
 * `docsUrl` below, next to the page it belongs to, so a heading rename has one
 * place to update.
 */
export function docLink(path: string, anchor?: string): string {
  return `${DOCS_SITE}${path}${anchor ? `#${anchor}` : ""}`;
}

const THREAT_MODEL = "/security/threat-model/";
const TOOL_REFERENCE = "/reference/tool-reference/";

export const docsUrl = {
  threatModel: docLink(THREAT_MODEL),
  /** How to turn a capability on: BROWX_CAPABILITIES, the config ceiling, confirm hooks. */
  threatModelConfiguring: docLink(THREAT_MODEL, "configuring"),
  /** What each capability grants, with its default. */
  threatModelCapabilities: docLink(THREAT_MODEL, "the-capability-set"),
  /** Origin allow and blocklist syntax and matching rules. */
  threatModelOrigins: docLink(THREAT_MODEL, "origin-allowblocklist"),
  toolReference: docLink(TOOL_REFERENCE),
  /** The `secrets` section: what is masked and the partial `screenshot` sink. */
  toolReferenceSecrets: docLink(TOOL_REFERENCE, "secrets-registry-capability-secrets"),
  /** The `credentials` section: providers, `BROWX_CREDENTIAL_ORIGINS`, account names. */
  toolReferenceCredentials: docLink(TOOL_REFERENCE, "credentials-hook-capability-credentials"),
  /** Wiring browxai into an MCP client, the step after a clean `doctor`. */
  gettingStartedConnect: docLink("/getting-started/", "wire-it-into-an-mcp-client"),
  troubleshooting: docLink("/guides/troubleshooting/"),
  troubleshootingProfileInUse: docLink("/guides/troubleshooting/", "profile-in-use"),
  troubleshootingOriginBlocked: docLink("/guides/troubleshooting/", "origin-blocked"),
  pluginAuthoring: docLink("/plugins/authoring/"),
  pluginGovernance: docLink("/plugins/governance/"),
  pluginsFirstParty: docLink("/plugins/first-party/"),
  /** Agent-facing note, not published on the site: link the source in the repo. */
  engineAdapters: `${REPO_URL}/blob/main/docs/ai-context/architecture/engine-adapters.md`,
} as const;
