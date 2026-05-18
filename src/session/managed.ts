// Managed-profile launch. Normal Chrome flags, sandbox on, profile dir rooted at
// $BROWX_WORKSPACE/profile/. Never `cwd`, never the human's daily-driver profile,
// never lowered-security flags.

import { chromium } from "playwright-core";
import { log } from "../util/logging.js";
import { resolveWorkspace } from "../util/workspace.js";
import type { BrowserSession, SessionOptions } from "./types.js";

export async function openManagedSession(opts: SessionOptions = {}): Promise<BrowserSession> {
  const workspace = resolveWorkspace();
  const profileDir = opts.profileDir ?? workspace.sub("profile");
  log.info("session.managed: launching", { profileDir, headless: !!opts.headless });

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: !!opts.headless,
    // W-H6: device/viewport emulation applied at context creation.
    ...(opts.device ?? {}),
    // Deliberately no `args: [...]` — no `--disable-web-security`, no `--no-sandbox`.
    // These are the lowered-security flags that BYOB attaches to externally; managed
    // launches stay safe by default. (Phase-1 security non-negotiable.)
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const cdp = await context.newCDPSession(page);

  let closed = false;
  return {
    mode: "managed",
    ownsBrowser: true,
    page: () => page,
    cdp: () => cdp,
    close: async () => {
      if (closed) return;
      closed = true;
      log.info("session.managed: closing");
      await cdp.detach().catch(() => undefined);
      await context.close().catch(() => undefined);
    },
  };
}
