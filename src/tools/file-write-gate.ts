// The `file-io` arm for a tool that writes a file into the workspace while its
// own capability is something else (`action` or `read`). The tool's declared
// capability still decides whether it runs at all; this adds the second
// capability for the write, with a reason that names what is written. One
// wording for every such tool, and one place that names the capability.

import type { GateHost, ToolResponse } from "./host.js";

/**
 * The `file-io` refusal for `tool`, or null when `file-io` is on.
 *
 * `writes` completes the sentence "<tool> writes ...", for example
 * `"a PDF of the page"`. The refusal is the standard gate refusal with
 * `requiredCapability: "file-io"` and that sentence in `reason`.
 */
export function fileWriteGate(
  gateCheck: GateHost["gateCheck"],
  tool: string,
  writes: string,
): ToolResponse | null {
  return gateCheck(
    tool,
    ["file-io"],
    `${tool} writes ${writes} to the workspace, which needs the \`file-io\` capability. Add \`file-io\` to BROWX_CAPABILITIES and restart the server.`,
  );
}
