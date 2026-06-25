// `browxai doctor` — the CDP reachability probe.
//
// A single GET against a Chrome DevTools `/json/version` endpoint, used by
// doctor's `cdp-attach` check both for an explicit BROWX_ATTACH_CDP and for the
// speculative default-port probe ("you could attach to that, you know."). Bounded
// by a 2s AbortSignal so a wedged port never hangs the checklist. Returns a small
// structured envelope — NOT a doctor `Check` — so doctor.ts owns the row wording
// while this owns the network probe.

export async function probeCdp(
  endpoint: string,
): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  try {
    const url = new URL(endpoint);
    const probeUrl = `${url.origin}/json/version`;
    const res = await fetch(probeUrl, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { Browser?: string };
    return { ok: true, version: body.Browser ?? "unknown" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
