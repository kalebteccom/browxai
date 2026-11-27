// `browxai runtime`: whether a Node version satisfies a package's `engines.node`
// range. It reads the forms package.json files use for Node: comparators (`>=22`,
// `<23.0.0`), caret and tilde, x-ranges (`22.x`, `*`), hyphen ranges and `||`.
// A prerelease tag on a range bound is dropped. Anything else gives `undefined`,
// and the caller then holds nothing: the smoke check runs the version on that
// node anyway.

type Triple = [number, number, number];
type Op = "<" | "<=" | ">" | ">=" | "=";
interface Comparator {
  op: Op;
  v: Triple;
}

/** A partial version: `22`, `22.11`, `22.11.0`, with `x`, `X` or `*` for a part. */
interface Partial {
  parts: number[];
}

const PART = /^(0|[1-9]\d*|x|X|\*)$/;

function readPartial(text: string): Partial | undefined {
  const bare = text.replace(/^v/, "").replace(/[-+].*$/, "");
  if (bare === "" || bare === "*" || bare === "x" || bare === "X") return { parts: [] };
  const pieces = bare.split(".");
  if (pieces.length > 3 || !pieces.every((p) => PART.test(p))) return undefined;
  const parts: number[] = [];
  for (const p of pieces) {
    if (!/^\d+$/.test(p)) break;
    parts.push(Number(p));
  }
  return { parts };
}

const fill = (p: Partial): Triple => [p.parts[0] ?? 0, p.parts[1] ?? 0, p.parts[2] ?? 0];

/** The first version past every version `p` names: `22` gives 23.0.0, `22.11` 22.12.0. */
function pastPartial(p: Partial): Triple | undefined {
  const [a, b] = p.parts;
  if (p.parts.length === 0) return undefined;
  if (p.parts.length === 1) return [a! + 1, 0, 0];
  if (p.parts.length === 2) return [a!, b! + 1, 0];
  return undefined;
}

function caret(p: Partial): Comparator[] {
  const lo = fill(p);
  const [a, b, c] = lo;
  if (p.parts.length === 0) return [];
  let hi: Triple;
  if (a > 0 || p.parts.length === 1) hi = [a + 1, 0, 0];
  else if (b > 0 || p.parts.length === 2) hi = [0, b + 1, 0];
  else hi = [0, 0, c + 1];
  return [
    { op: ">=", v: lo },
    { op: "<", v: hi },
  ];
}

function tilde(p: Partial): Comparator[] {
  const lo = fill(p);
  if (p.parts.length === 0) return [];
  const hi: Triple = p.parts.length === 1 ? [lo[0] + 1, 0, 0] : [lo[0], lo[1] + 1, 0];
  return [
    { op: ">=", v: lo },
    { op: "<", v: hi },
  ];
}

/** One comparator token, such as `>=22.11` or `^20.19.0`, as plain comparators. */
function readToken(token: string): Comparator[] | undefined {
  const m = /^(\^|~>?|>=|<=|>|<|=)?(.*)$/.exec(token);
  if (!m) return undefined;
  const op = m[1] ?? "";
  const p = readPartial(m[2]!);
  if (!p) return undefined;
  if (op === "^") return caret(p);
  if (op.startsWith("~")) return tilde(p);
  const full = p.parts.length === 3;
  const past = pastPartial(p);
  if (p.parts.length === 0) return op === "<" || op === ">" ? undefined : [];
  if (op === ">=") return [{ op: ">=", v: fill(p) }];
  if (op === "<") return [{ op: "<", v: fill(p) }];
  if (op === ">") return [full ? { op: ">", v: fill(p) } : { op: ">=", v: past! }];
  if (op === "<=") return [full ? { op: "<=", v: fill(p) } : { op: "<", v: past! }];
  if (full) return [{ op: "=", v: fill(p) }];
  return [
    { op: ">=", v: fill(p) },
    { op: "<", v: past! },
  ];
}

/** One space-separated set, every comparator of which must hold. */
function readSet(text: string): Comparator[] | undefined {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(text);
  if (hyphen) {
    const lo = readPartial(hyphen[1]!);
    const hi = readPartial(hyphen[2]!);
    if (!lo || !hi) return undefined;
    const upper: Comparator[] =
      hi.parts.length === 3
        ? [{ op: "<=", v: fill(hi) }]
        : hi.parts.length === 0
          ? []
          : [{ op: "<", v: pastPartial(hi)! }];
    return [{ op: ">=", v: fill(lo) }, ...upper];
  }
  // `>= 22` is the same as `>=22`.
  const tokens = text
    .replace(/(\^|~>?|>=|<=|>|<|=)\s+/g, "$1")
    .split(/\s+/)
    .filter(Boolean);
  const out: Comparator[] = [];
  for (const t of tokens) {
    const c = readToken(t);
    if (!c) return undefined;
    out.push(...c);
  }
  return out;
}

function compare(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function holds(v: Triple, c: Comparator): boolean {
  const d = compare(v, c.v);
  if (c.op === "<") return d < 0;
  if (c.op === "<=") return d <= 0;
  if (c.op === ">") return d > 0;
  if (c.op === ">=") return d >= 0;
  return d === 0;
}

/**
 * Whether `version` (such as `22.11.0` or `v22.11.0`) satisfies `range`. Undefined
 * when either can't be read.
 */
export function satisfiesRange(version: string, range: string): boolean | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return undefined;
  const v: Triple = [Number(m[1]), Number(m[2]), Number(m[3])];
  let any = false;
  for (const set of range.split("||")) {
    const comparators = readSet(set.trim());
    if (!comparators) return undefined;
    if (comparators.every((c) => holds(v, c))) any = true;
  }
  return any;
}
