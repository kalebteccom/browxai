import { describe, expect, it } from "vitest";
import {
  attestationsDoc,
  attestationsUrl,
  fakeCertificate,
  fakeIntegrity,
  tarballUrl,
  type ProvenanceShape,
} from "./__fixtures__/provenance.js";
import type { VersionInfo } from "./runtime-npm.js";
import {
  certificateUris,
  checkProvenance,
  expectedPublisher,
  pinProvenance,
  SLSA_PROVENANCE_V1,
} from "./runtime-provenance.js";

const V = "0.22.0";
const RELEASE = "https://github.com/kalebteccom/browxai/.github/workflows/release.yml";

function info(over: Partial<VersionInfo> = {}): VersionInfo {
  return {
    version: V,
    integrity: fakeIntegrity(V),
    tarball: tarballUrl(V),
    attestationsUrl: attestationsUrl(V),
    provenanceType: SLSA_PROVENANCE_V1,
    ...over,
  };
}

const check = (shape: Partial<ProvenanceShape> = {}, i: VersionInfo = info()) =>
  checkProvenance(attestationsDoc({ version: V, ...shape }), i);

describe("expectedPublisher", () => {
  it("names the repository, the release workflow and the version's tag", () => {
    expect(expectedPublisher("0.23.0-next.1")).toEqual({
      repository: "https://github.com/kalebteccom/browxai",
      path: ".github/workflows/release.yml",
      ref: "refs/tags/v0.23.0-next.1",
      identity: `${RELEASE}@refs/tags/v0.23.0-next.1`,
    });
  });
});

describe("certificateUris", () => {
  it("reads the SAN URI of a certificate", () => {
    expect(certificateUris(fakeCertificate(`${RELEASE}@refs/tags/v${V}`))).toEqual([
      `${RELEASE}@refs/tags/v${V}`,
    ]);
  });
});

describe("checkProvenance", () => {
  it("passes a release built by the release workflow at its own tag", () => {
    expect(check()).toEqual({
      ok: true,
      detail: `provenance names ${RELEASE}@refs/tags/v${V}`,
    });
  });

  it("passes a prerelease tag", () => {
    const v = "0.23.0-next.1";
    const r = checkProvenance(attestationsDoc({ version: v }), {
      version: v,
      integrity: fakeIntegrity(v),
    });
    expect(r.ok).toBe(true);
  });

  it("reads the certificate from x509CertificateChain, as bundle v0.2 has it", () => {
    expect(check({ chain: true }).ok).toBe(true);
  });

  const mismatches: Array<[string, Partial<ProvenanceShape>, RegExp]> = [
    [
      "another repository",
      { repository: "https://github.com/someone/browxai-fork" },
      /workflow\.repository "https:\/\/github\.com\/someone\/browxai-fork", expected https:\/\/github\.com\/kalebteccom\/browxai/,
    ],
    [
      "another workflow",
      { path: ".github/workflows/ci.yml" },
      /workflow\.path "\.github\/workflows\/ci\.yml", expected \.github\/workflows\/release\.yml/,
    ],
    [
      "another tag",
      { ref: "refs/tags/v0.21.0" },
      /workflow\.ref "refs\/tags\/v0\.21\.0", expected refs\/tags\/v0\.22\.0/,
    ],
    ["a branch", { ref: "refs/heads/main" }, /workflow\.ref "refs\/heads\/main"/],
    [
      "another package",
      { subjectName: "pkg:npm/other@0.22.0" },
      /no subject pkg:npm\/browxai@0\.22\.0/,
    ],
    [
      "another tarball",
      { integrity: fakeIntegrity("0.21.0") },
      /subject digest doesn't match the tarball's integrity/,
    ],
    [
      "an unknown predicate",
      { predicateType: "https://slsa.dev/provenance/v0.2" },
      /has no https:\/\/slsa\.dev\/provenance\/v1 attestation/,
    ],
    [
      "an unknown statement type",
      { statementType: "https://in-toto.io/Statement/v0.1" },
      /statement is "https:\/\/in-toto\.io\/Statement\/v0\.1"/,
    ],
    [
      "an unknown build type",
      { buildType: "https://example.test/build/v1" },
      /build type is "https:\/\/example\.test\/build\/v1"/,
    ],
    ["a payload that isn't in-toto", { payloadType: "text/plain" }, /no in-toto payload/],
    ["no signing certificate", { identity: null }, /no signing certificate/],
    [
      "a certificate for another repository",
      {
        identity:
          "https://github.com/someone/browxai-fork/.github/workflows/release.yml@refs/tags/v0.22.0",
      },
      /signed for https:\/\/github\.com\/someone\/browxai-fork\/.*expected https:\/\/github\.com\/kalebteccom\/browxai\//,
    ],
    [
      "a certificate for another tag",
      { identity: `${RELEASE}@refs/tags/v0.21.0` },
      /signed for .*v0\.21\.0, expected .*v0\.22\.0/,
    ],
  ];

  it.each(mismatches)("fails a statement that names %s", (_label, shape, why) => {
    const r = check(shape);
    expect(r.ok).toBe(false);
    expect(r.transient).toBeUndefined();
    expect(r.detail).toMatch(why);
  });

  it("fails a document with no attestations", () => {
    expect(checkProvenance({ attestations: [] }, info())).toMatchObject({
      ok: false,
      detail: expect.stringMatching(/has no https:\/\/slsa\.dev\/provenance\/v1 attestation/),
    });
    expect(checkProvenance("not json", info()).ok).toBe(false);
  });

  it("fails two provenance attestations", () => {
    const doc = attestationsDoc({ version: V });
    doc.attestations.push(doc.attestations[1]);
    expect(checkProvenance(doc, info()).detail).toMatch(/2 provenance attestations/);
  });

  it("fails when the registry gives no sha512 integrity", () => {
    expect(check({}, info({ integrity: "sha1-abc=" })).detail).toMatch(/no sha512 integrity/);
  });

  it("fails a certificate it can't read", () => {
    const r = checkProvenance(attestationsDoc({ version: V }), info(), () => {
      throw new Error("bad DER");
    });
    expect(r.detail).toMatch(/signing certificate can't be read/);
  });
});

describe("pinProvenance", () => {
  const registry = (doc: unknown = attestationsDoc({ version: V })) => {
    const urls: string[] = [];
    return {
      urls,
      attestations: (url: string) => {
        urls.push(url);
        return Promise.resolve({ ok: true as const, doc });
      },
    };
  };

  it("reads the attestations URL the registry lists and checks it", async () => {
    const r = registry();
    expect(await pinProvenance(info(), r)).toMatchObject({ ok: true });
    expect(r.urls).toEqual([attestationsUrl(V)]);
  });

  it("fails a version the registry lists no attestation for, with no fetch", async () => {
    const r = registry();
    const { attestationsUrl: _none, ...rest } = info();
    expect(await pinProvenance(rest, r)).toEqual({
      ok: false,
      detail: "0.22.0: the registry lists no provenance attestation for it",
    });
    expect(r.urls).toEqual([]);
  });

  it("fails a provenance type it doesn't know, with no fetch", async () => {
    const r = registry();
    const out = await pinProvenance(
      info({ provenanceType: "https://slsa.dev/provenance/v0.2" }),
      r,
    );
    expect(out.detail).toMatch(/provenance of type "https:\/\/slsa\.dev\/provenance\/v0\.2"/);
    expect(r.urls).toEqual([]);
  });

  it("fails attestations on another host than the tarball", async () => {
    const r = registry();
    const out = await pinProvenance(
      info({ attestationsUrl: "https://elsewhere.example.test/attestations/browxai@0.22.0" }),
      r,
    );
    expect(out.detail).toMatch(/not on the registry that serves its tarball/);
    expect(r.urls).toEqual([]);
  });

  it("marks a fetch failure transient", async () => {
    const out = await pinProvenance(info(), {
      attestations: () =>
        Promise.resolve({ ok: false as const, message: "the registry answered 503" }),
    });
    expect(out).toEqual({
      ok: false,
      transient: true,
      detail: "0.22.0: the registry answered 503",
    });
  });
});
