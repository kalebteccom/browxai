// Text blocks for the shots step log: one image as base64 between SHOT-BEGIN and SHOT-END, and the closing list.
// Format (decoded by decode-log.py):
//   SHOT-BEGIN <name> <bytes>
//   <base64 of the file, 76 characters per line>
//   SHOT-END
// Pure functions, no I/O, so they can be read and tested without a browser.

export const LINE_WIDTH = 76;

/** One image as a SHOT-BEGIN ... SHOT-END block. `bytes` is a Buffer. */
export function shotBlock(name, bytes) {
  const b64 = bytes.toString("base64");
  const lines = [];
  for (let i = 0; i < b64.length; i += LINE_WIDTH) lines.push(b64.slice(i, i + LINE_WIDTH));
  return [`SHOT-BEGIN ${name} ${bytes.length}`, ...lines, "SHOT-END"].join("\n");
}

/** The closing list: one `SHOT-LIST name bytes` line per image and a total. `shots` is [{ name, size }]. */
export function shotList(shots) {
  const total = shots.reduce((sum, s) => sum + s.size, 0);
  return [
    ...shots.map((s) => `SHOT-LIST ${s.name} ${s.size}`),
    `SHOT-LIST total ${shots.length} files ${total} bytes`,
  ].join("\n");
}
