import { describe, expect, it } from "vitest";
import { fakeRegistry, type FakeVersion } from "./__fixtures__/runtime-tree.js";
import { viewChannel } from "./runtime-channel.js";
import type { Registry } from "./runtime-npm.js";

const VERSIONS: Record<string, FakeVersion> = {
  "0.22.0": {},
  "0.23.0-next.1": {},
  "0.23.0": {},
};

/** A registry that records the specs it was asked for. */
function recorded(tags: Record<string, string>): Registry & { specs: string[] } {
  const inner = fakeRegistry(VERSIONS, tags);
  const specs: string[] = [];
  return {
    specs,
    view: (spec) => {
      specs.push(spec);
      return inner.view(spec);
    },
    attestations: (url) => inner.attestations(url),
  };
}

const versionOf = async (registry: Registry, channel: "latest" | "next") => {
  const r = await viewChannel(registry, channel);
  return r.ok ? r.info.version : r.message;
};

describe("viewChannel", () => {
  it("latest reads the latest dist-tag only", async () => {
    const r = recorded({ latest: "0.22.0", next: "0.23.0-next.1" });
    expect(await versionOf(r, "latest")).toBe("0.22.0");
    expect(r.specs).toEqual(["latest"]);
  });

  it("next takes the next dist-tag when it is newer than latest", async () => {
    const r = recorded({ latest: "0.22.0", next: "0.23.0-next.1" });
    expect(await versionOf(r, "next")).toBe("0.23.0-next.1");
    expect(r.specs).toEqual(["latest", "0.23.0-next.1"]);
  });

  it("next follows latest once a release passes the prerelease", async () => {
    const r = recorded({ latest: "0.23.0", next: "0.23.0-next.1" });
    expect(await versionOf(r, "next")).toBe("0.23.0");
    expect(r.specs).toEqual(["latest"]);
  });

  it("next follows latest when the package has no next dist-tag", async () => {
    const r = recorded({ latest: "0.22.0" });
    expect(await versionOf(r, "next")).toBe("0.22.0");
    expect(r.specs).toEqual(["latest"]);
  });

  it("next ignores a dist-tag that isn't a version", async () => {
    const r = recorded({ latest: "0.22.0", next: "soon" });
    expect(await versionOf(r, "next")).toBe("0.22.0");
  });

  it("passes on a registry that can't be reached", async () => {
    const r = await viewChannel(fakeRegistry(VERSIONS, {}, { unreachable: true }), "next");
    expect(r).toMatchObject({ ok: false, unreachable: true });
  });
});
