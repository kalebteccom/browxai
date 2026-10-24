// What process a PID names, for `browxai chrome stop`. The PID comes from
// `<workspace>/chrome.pid`, a plain file, so `stop` confirms the process is
// Chrome before it sends any signal.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** How long a `ps` or `tasklist` lookup may take. */
const LOOKUP_TIMEOUT_MS = 5000;

/**
 * The command line of `pid`, or undefined when it cannot be read. Linux reads
 * `/proc/<pid>/cmdline`, macOS and the other Unixes ask `ps`, and Windows asks
 * `tasklist`, which reports the image name only.
 */
export function processCommandLine(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    if (platform === "linux") {
      const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      return raw.split("\0").join(" ").trim() || undefined;
    }
    if (platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        encoding: "utf8",
        timeout: LOOKUP_TIMEOUT_MS,
        windowsHide: true,
      });
      const row = /^"([^"]+)","(\d+)"/m.exec(out);
      return row && Number(row[2]) === pid ? row[1] : undefined;
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: LOOKUP_TIMEOUT_MS,
    });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** A Chrome or Chromium executable at the start of a command line:
 *  `/opt/google/chrome/chrome`, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
 *  `chrome.exe`. The directory part has no spaces, except inside a macOS
 *  `.app` bundle path, so `vim /tmp/chrome` does not match. */
const CHROME_EXECUTABLE =
  /^(?:[^\s]*[/\\]|.*\.app\/Contents\/MacOS\/)?(?:google chrome|google-chrome(?:-stable)?|chrome|chrome\.exe|chromium(?:-browser)?|chromium\.exe)(?:\s|$)/i;

/**
 * True when `commandLine` reads as the Chrome `browxai chrome start` launches:
 * a Chrome executable, and on platforms that report arguments, a
 * `--user-data-dir=` flag.
 */
export function looksLikeChrome(
  commandLine: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!CHROME_EXECUTABLE.test(commandLine)) return false;
  return platform === "win32" || commandLine.includes("--user-data-dir=");
}
