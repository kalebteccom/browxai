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

export const docsUrl = {
  threatModel: `${DOCS_SITE}/security/threat-model/`,
  toolReference: `${DOCS_SITE}/reference/tool-reference/`,
  pluginAuthoring: `${DOCS_SITE}/plugins/authoring/`,
  pluginGovernance: `${DOCS_SITE}/plugins/governance/`,
  pluginsFirstParty: `${DOCS_SITE}/plugins/first-party/`,
  /** Agent-facing note, not published on the site: link the source in the repo. */
  engineAdapters: `${REPO_URL}/blob/main/docs/ai-context/architecture/engine-adapters.md`,
} as const;
