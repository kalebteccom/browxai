#!/usr/bin/env python3
"""Write the images in a saved shots step log to a directory.

Usage:
    python3 -I scripts/shots/decode-log.py <log-file> <out-dir>

<log-file> is the text of the `shots` step of .woodpecker/shots.yml, saved as it
came out of Woodpecker (or .audit/shots/shots.log from the box). Each image sits
in the log as

    SHOT-BEGIN <name> <bytes>
    <base64, 76 characters per line>
    SHOT-END

The script decodes every block into <out-dir>/<name> and checks the decoded
length against <bytes>. A log prefix in front of a line (a timestamp, a step
name) and ANSI colour codes are ignored. Python 3, standard library only.

Exit 0 when at least one image was written and every length matched, 1 when a
block is damaged (length differs, no SHOT-END) or none was found, 2 on bad usage.
"""

import base64
import binascii
import os
import re
import sys

BEGIN = re.compile(r"SHOT-BEGIN (\S+) (\d+)\s*$")
END = re.compile(r"SHOT-END\s*$")
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
B64_LINE = re.compile(r"^[A-Za-z0-9+/=]+$")
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def body_text(line):
    """The base64 part of a line: its last whitespace-separated token, when that is base64."""
    parts = ANSI.sub("", line).split()
    if parts and B64_LINE.match(parts[-1]):
        return parts[-1]
    return ""


def blocks(lines):
    """Yield (name, expected_bytes, base64_text, closed) for every SHOT-BEGIN in the log."""
    name = None
    expected = 0
    chunks = []
    for raw in lines:
        line = ANSI.sub("", raw).rstrip("\r\n")
        begin = BEGIN.search(line)
        if begin:
            if name is not None:
                yield name, expected, "".join(chunks), False
            name, expected, chunks = begin.group(1), int(begin.group(2)), []
        elif name is not None and END.search(line):
            yield name, expected, "".join(chunks), True
            name = None
        elif name is not None:
            chunks.append(body_text(line))
    if name is not None:
        yield name, expected, "".join(chunks), False


def main(argv):
    if len(argv) != 3:
        print(__doc__.split("\n\n")[1].strip(), file=sys.stderr)
        return 2
    log_path, out_dir = argv[1], argv[2]
    os.makedirs(out_dir, exist_ok=True)
    with open(log_path, encoding="utf-8", errors="replace") as handle:
        found = list(blocks(handle))
    bad = 0
    written = 0
    for name, expected, text, closed in found:
        if not SAFE_NAME.match(name):
            print("skip %r: not a plain file name" % name)
            bad += 1
            continue
        try:
            data = base64.b64decode(text, validate=True)
        except (binascii.Error, ValueError) as err:
            print("FAIL %s: base64 does not decode (%s)" % (name, err))
            bad += 1
            continue
        problems = []
        if not closed:
            problems.append("no SHOT-END")
        if len(data) != expected:
            problems.append("decoded %d bytes, header says %d" % (len(data), expected))
        if problems:
            print("FAIL %s: %s" % (name, ", ".join(problems)))
            bad += 1
            continue
        with open(os.path.join(out_dir, name), "wb") as out:
            out.write(data)
        written += 1
        print("wrote %s (%d bytes)" % (os.path.join(out_dir, name), len(data)))
    if not found:
        print("no SHOT-BEGIN block in %s" % log_path)
        return 1
    print("%d written, %d failed" % (written, bad))
    return 0 if bad == 0 and written > 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
