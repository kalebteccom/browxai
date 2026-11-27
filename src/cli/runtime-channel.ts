// `browxai runtime`: the version a channel names (RFC 0015, section 5, D6).
// `latest` is the `latest` dist-tag, what `npm install browxai` gets. `next` is
// the `next` dist-tag when that names a version newer than `latest`, and
// `latest` otherwise: a machine on `next` moves on to the release that
// supersedes its prerelease, and `next` works before any prerelease exists.
// Everything after the channel is the same for both: the delay after publish,
// the deprecated skip, the version guard and the verification.

import { compareVersions, isVersion } from "./runtime-layout.js";
import type { Registry, ViewResult } from "./runtime-npm.js";
import type { Channel } from "./runtime-settings.js";

export async function viewChannel(registry: Registry, channel: Channel): Promise<ViewResult> {
  const latest = await registry.view("latest");
  if (channel === "latest" || !latest.ok) return latest;
  const next = latest.info.distTags?.next;
  if (!next || !isVersion(next) || compareVersions(next, latest.info.version) <= 0) return latest;
  return registry.view(next);
}
