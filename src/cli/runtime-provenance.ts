// `browxai runtime`: the provenance pin (RFC 0015, section 4). `npm audit
// signatures` checks the Sigstore signature on a version's attestations, but it
// compares the build's source to nothing: a version built in another
// repository, with valid provenance of its own, passes it. This pin reads the
// version's SLSA provenance from the same registry and requires that it names
// this project's release workflow at the version's own tag:
//   - one SLSA provenance v1 attestation, an in-toto v1 statement;
//   - a subject `pkg:npm/browxai@V` whose sha512 is the tarball's `dist.integrity`;
//   - `buildDefinition.externalParameters.workflow` naming the repository, the
//     release workflow and `refs/tags/vV`;
//   - a signing certificate whose identity (its SAN URI) names the same
//     repository, workflow and tag.
// The signature on the bundle stays npm's check. A version with no attestation,
// or with a predicate this code doesn't know, fails.

import { X509Certificate } from "node:crypto";
import type { Registry, VersionInfo } from "./runtime-npm.js";

/** The trusted publisher: the one repository and workflow a release comes from. */
export const TRUSTED_PUBLISHER = {
  repository: "https://github.com/kalebteccom/browxai",
  workflow: ".github/workflows/release.yml",
} as const;

export const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const IN_TOTO_STATEMENT_V1 = "https://in-toto.io/Statement/v1";
const IN_TOTO_PAYLOAD = "application/vnd.in-toto+json";
const GITHUB_WORKFLOW_BUILD =
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";

export interface ProvenanceResult {
  ok: boolean;
  detail: string;
  /** The attestation couldn't be read, so a later run may pass. Never set on a
   *  mismatch: a mismatch holds the version for good. */
  transient?: boolean;
}

/** The workflow fields and certificate identity a release of `version` carries. */
export function expectedPublisher(version: string): {
  repository: string;
  path: string;
  ref: string;
  identity: string;
} {
  const ref = `refs/tags/v${version}`;
  const { repository, workflow } = TRUSTED_PUBLISHER;
  return { repository, path: workflow, ref, identity: `${repository}/${workflow}@${ref}` };
}

/** The URIs in a DER certificate's subject alternative name. */
export function certificateUris(der: Buffer): string[] {
  const san = new X509Certificate(der).subjectAltName ?? "";
  return san
    .split(/,\s*/)
    .filter((entry) => entry.startsWith("URI:"))
    .map((entry) => entry.slice("URI:".length));
}

type Doc = Record<string, unknown>;

const isDoc = (v: unknown): v is Doc => !!v && typeof v === "object" && !Array.isArray(v);
const field = (v: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((at, k) => (isDoc(at) ? at[k] : undefined), v);

/** The sha512 of `dist.integrity` in hex, the form the statement's subject uses. */
function sha512Hex(integrity: string | undefined): string | undefined {
  const m = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity?.trim() ?? "");
  return m ? Buffer.from(m[1]!, "base64").toString("hex") : undefined;
}

/** The signing certificate of a Sigstore bundle: `certificate` in bundle v0.3,
 *  the first of `x509CertificateChain` before it. */
function bundleCertificate(bundle: unknown): Buffer | undefined {
  const material = field(bundle, "verificationMaterial");
  const raw =
    field(material, "certificate", "rawBytes") ??
    (field(material, "x509CertificateChain", "certificates") as unknown[] | undefined)?.[0];
  const bytes = typeof raw === "string" ? raw : field(raw, "rawBytes");
  return typeof bytes === "string" && bytes ? Buffer.from(bytes, "base64") : undefined;
}

function decodeStatement(bundle: unknown): Doc | string {
  const envelope = field(bundle, "dsseEnvelope");
  if (field(envelope, "payloadType") !== IN_TOTO_PAYLOAD)
    return "its provenance bundle has no in-toto payload";
  const payload = field(envelope, "payload");
  if (typeof payload !== "string") return "its provenance bundle has no payload";
  try {
    const statement: unknown = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    return isDoc(statement) ? statement : "its provenance payload isn't a JSON object";
  } catch {
    return "its provenance payload isn't JSON";
  }
}

/** Why the statement doesn't name `version`'s release, or undefined when it does. */
function statementMismatch(statement: Doc, version: string, digest: string): string | undefined {
  if (statement._type !== IN_TOTO_STATEMENT_V1)
    return `its provenance statement is ${JSON.stringify(statement._type)}, expected ${IN_TOTO_STATEMENT_V1}`;
  if (statement.predicateType !== SLSA_PROVENANCE_V1)
    return `its provenance predicate is ${JSON.stringify(statement.predicateType)}, expected ${SLSA_PROVENANCE_V1}`;
  const name = `pkg:npm/browxai@${version}`;
  const subjects: unknown[] = Array.isArray(statement.subject) ? statement.subject : [];
  const subject = subjects.find((s) => field(s, "name") === name);
  if (!subject) return `its provenance has no subject ${name}`;
  if (field(subject, "digest", "sha512") !== digest)
    return "its provenance subject digest doesn't match the tarball's integrity";
  const build = field(statement, "predicate", "buildDefinition");
  if (field(build, "buildType") !== GITHUB_WORKFLOW_BUILD)
    return `its provenance build type is ${JSON.stringify(field(build, "buildType"))}, expected ${GITHUB_WORKFLOW_BUILD}`;
  const workflow = field(build, "externalParameters", "workflow");
  const want = expectedPublisher(version);
  for (const key of ["repository", "path", "ref"] as const) {
    const got = field(workflow, key);
    if (got !== want[key])
      return `its provenance names workflow.${key} ${JSON.stringify(got)}, expected ${want[key]}`;
  }
  return undefined;
}

/** Why the signing certificate doesn't name `version`'s release, or undefined. */
function certificateMismatch(
  bundle: unknown,
  version: string,
  urisOf: (der: Buffer) => string[],
): string | undefined {
  const der = bundleCertificate(bundle);
  if (!der) return "its provenance bundle has no signing certificate";
  let uris: string[];
  try {
    uris = urisOf(der);
  } catch {
    return "its provenance signing certificate can't be read";
  }
  const { identity } = expectedPublisher(version);
  if (uris.includes(identity)) return undefined;
  return `its provenance was signed for ${uris[0] ?? "no workflow"}, expected ${identity}`;
}

/**
 * Check the attestations document the registry serves for `info.version`
 * against the trusted publisher. Pure: `urisOf` reads a certificate's SAN URIs.
 */
export function checkProvenance(
  doc: unknown,
  info: Pick<VersionInfo, "version" | "integrity">,
  urisOf: (der: Buffer) => string[] = certificateUris,
): ProvenanceResult {
  const v = info.version;
  const fail = (why: string): ProvenanceResult => ({ ok: false, detail: `${v}: ${why}` });
  const digest = sha512Hex(info.integrity);
  if (!digest)
    return fail("the registry gives no sha512 integrity to check its provenance against");
  const attestations = field(doc, "attestations");
  const slsa = Array.isArray(attestations)
    ? attestations.filter((a) => field(a, "predicateType") === SLSA_PROVENANCE_V1)
    : [];
  if (slsa.length === 0) return fail(`it has no ${SLSA_PROVENANCE_V1} attestation`);
  if (slsa.length > 1) return fail(`it has ${slsa.length} provenance attestations, expected one`);
  const bundle = field(slsa[0], "bundle");
  const statement = decodeStatement(bundle);
  if (typeof statement === "string") return fail(statement);
  const why = statementMismatch(statement, v, digest) ?? certificateMismatch(bundle, v, urisOf);
  if (why) return fail(why);
  return {
    ok: true,
    detail: `provenance names ${expectedPublisher(v).identity}`,
  };
}

/** Read `info`'s attestations from the registry and check them. */
export async function pinProvenance(
  info: VersionInfo,
  registry: Pick<Registry, "attestations">,
): Promise<ProvenanceResult> {
  const v = info.version;
  if (!info.attestationsUrl)
    return { ok: false, detail: `${v}: the registry lists no provenance attestation for it` };
  if (info.provenanceType !== undefined && info.provenanceType !== SLSA_PROVENANCE_V1) {
    return {
      ok: false,
      detail: `${v}: the registry lists provenance of type ${JSON.stringify(info.provenanceType)}, expected ${SLSA_PROVENANCE_V1}`,
    };
  }
  if (info.tarball && origin(info.tarball) !== origin(info.attestationsUrl)) {
    return {
      ok: false,
      detail: `${v}: its attestations are on ${origin(info.attestationsUrl) ?? "an unreadable URL"}, not on the registry that serves its tarball`,
    };
  }
  const read = await registry.attestations(info.attestationsUrl);
  if (!read.ok) return { ok: false, transient: true, detail: `${v}: ${read.message}` };
  return checkProvenance(read.doc, info);
}

function origin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
