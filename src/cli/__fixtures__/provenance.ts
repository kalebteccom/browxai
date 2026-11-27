// Attestation documents for the provenance tests, built in the shape the npm
// registry serves (an `attestations` array of Sigstore bundles whose DSSE
// payload is an in-toto statement). Digests are fake and nothing is signed with
// a real key: the signature is npm's check, and these fixtures exercise the
// identity pin only. Test code only.

import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { VersionInfo } from "../runtime-npm.js";
import { SLSA_PROVENANCE_V1, TRUSTED_PUBLISHER } from "../runtime-provenance.js";

/** The registry these fixtures stand in for. */
export const FAKE_REGISTRY = "https://registry.example.test";

/** A stable, fake `dist.integrity` for a version. */
export function fakeIntegrity(version: string): string {
  return `sha512-${createHash("sha512").update(`browxai@${version}`).digest("base64")}`;
}

export function attestationsUrl(version: string): string {
  return `${FAKE_REGISTRY}/-/npm/v1/attestations/browxai@${version}`;
}

export function tarballUrl(version: string): string {
  return `${FAKE_REGISTRY}/browxai/-/browxai-${version}.tgz`;
}

// A minimal DER writer: enough for a certificate whose only extension is a
// subject alternative name, which is what the pin reads.
function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}
function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [40 * a! + b!];
  for (const n of rest) {
    const part = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) part.unshift((v & 0x7f) | 0x80);
    out.push(...part);
  }
  return tlv(0x06, Buffer.from(out));
}
const seq = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);

let key: ReturnType<typeof generateKeyPairSync> | undefined;

/** A DER certificate whose subject alternative name is the URI `uri`. */
export function fakeCertificate(uri: string): Buffer {
  key ??= generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const san = seq(
    oid("2.5.29.17"),
    tlv(0x01, Buffer.from([0xff])),
    tlv(0x04, seq(tlv(0x86, Buffer.from(uri)))),
  );
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.from([1])),
    ecdsaSha256,
    seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from("fixture"))))),
    seq(tlv(0x17, Buffer.from("260101000000Z")), tlv(0x17, Buffer.from("360101000000Z"))),
    seq(),
    key.publicKey.export({ type: "spki", format: "der" }),
    tlv(0xa3, seq(san)),
  );
  const signature = sign("sha256", tbs, key.privateKey);
  return seq(tbs, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
}

/** What a fixture attestation says. Every field defaults to a genuine release of
 *  `version`; override one to build a mismatch. */
export interface ProvenanceShape {
  version: string;
  integrity?: string;
  statementType?: string;
  predicateType?: string;
  subjectName?: string;
  buildType?: string;
  repository?: string;
  path?: string;
  ref?: string;
  /** The certificate's SAN URI. `null` leaves the certificate out. */
  identity?: string | null;
  /** Put the certificate in `x509CertificateChain`, as bundle v0.2 does. */
  chain?: boolean;
  payloadType?: string;
}

/** One SLSA provenance attestation entry, as the registry lists it. */
export function slsaAttestation(shape: ProvenanceShape): Record<string, unknown> {
  const v = shape.version;
  const ref = shape.ref ?? `refs/tags/v${v}`;
  const repository = shape.repository ?? TRUSTED_PUBLISHER.repository;
  const path = shape.path ?? TRUSTED_PUBLISHER.workflow;
  const integrity = shape.integrity ?? fakeIntegrity(v);
  const statement = {
    _type: shape.statementType ?? "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: shape.subjectName ?? `pkg:npm/browxai@${v}`,
        digest: {
          sha512: Buffer.from(integrity.slice("sha512-".length), "base64").toString("hex"),
        },
      },
    ],
    predicateType: shape.predicateType ?? SLSA_PROVENANCE_V1,
    predicate: {
      buildDefinition: {
        buildType:
          shape.buildType ??
          "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: { workflow: { ref, repository, path } },
        internalParameters: { github: { event_name: "push" } },
        resolvedDependencies: [
          { uri: `git+${repository}@${ref}`, digest: { gitCommit: "0".repeat(40) } },
        ],
      },
      runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } },
    },
  };
  const identity = shape.identity === undefined ? `${repository}/${path}@${ref}` : shape.identity;
  const rawBytes = identity === null ? undefined : fakeCertificate(identity).toString("base64");
  const verificationMaterial: Record<string, unknown> = { tlogEntries: [] };
  if (rawBytes && shape.chain)
    verificationMaterial.x509CertificateChain = { certificates: [{ rawBytes }] };
  else if (rawBytes) verificationMaterial.certificate = { rawBytes };
  return {
    predicateType: statement.predicateType,
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial,
      dsseEnvelope: {
        payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
        payloadType: shape.payloadType ?? "application/vnd.in-toto+json",
        signatures: [{ sig: "ZmFrZQ==", keyid: "" }],
      },
    },
  };
}

/** The npm publish attestation that sits beside the provenance one. */
function publishAttestation(version: string): Record<string, unknown> {
  return {
    predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
      verificationMaterial: { publicKey: { hint: "fake" }, tlogEntries: [] },
      dsseEnvelope: {
        payload: Buffer.from(
          JSON.stringify({
            _type: "https://in-toto.io/Statement/v0.1",
            predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
            predicate: { name: "browxai", version, registry: FAKE_REGISTRY },
          }),
        ).toString("base64"),
        payloadType: "application/vnd.in-toto+json",
        signatures: [{ sig: "ZmFrZQ==", keyid: "fake" }],
      },
    },
  };
}

/** The attestations document for a version: the publish attestation and the
 *  provenance attestation `shape` describes. */
export function attestationsDoc(shape: ProvenanceShape): { attestations: unknown[] } {
  return { attestations: [publishAttestation(shape.version), slsaAttestation(shape)] };
}

/** What the registry says about a genuine release of `version`, attestation included. */
export function releasedInfo(version: string, publishedAt?: string): VersionInfo {
  return {
    version,
    ...(publishedAt ? { publishedAt } : {}),
    integrity: fakeIntegrity(version),
    tarball: tarballUrl(version),
    attestationsUrl: attestationsUrl(version),
    provenanceType: SLSA_PROVENANCE_V1,
  };
}
