import type { RefRegistry, RefLocatorInputs } from "../page/refs.js";
import type { ElementSubstrate } from "../page/element-substrate.js";
import { elementQueryFor } from "../page/element-query.js";
import type { RawTargetArgs, ResolvedTarget } from "./host.js";

// Target-resolution domain helpers. These live in a leaf module — depended on by
// the composition root (`createServer`, via `buildHost`) without forcing
// `server.ts` to carry domain logic. `host.ts` is itself a leaf (it only declares
// the `RawTargetArgs` / `ResolvedTarget` seam types), so importing from it here
// closes no cycle: `host-build.ts` already depends on `host.ts`, and nothing in
// `host.ts` imports back from this module.
//
// `describeTarget` took a Playwright `Locator`. That single parameter was why
// this module and `host-build.ts` — which threads it into `SubstrateDeps` — were
// the two `src/tools` modules exempted from `no-tools-or-replay-to-playwright-core`
// in `.dependency-cruiser.cjs`, each annotated "P2 (ElementSubstrate)". It takes
// the element port now, and both exemptions are gone. (RFC 0009 P2.)

/** Structured one-liner alongside an element screenshot. Skips vision-reading
 *  when the agent only needs to confirm "yes the button is there." */
export async function describeTarget(
  elements: ElementSubstrate,
  refs: RefRegistry,
  target: { ref: string } | { selector: string } | { coords: { x: number; y: number } },
): Promise<string> {
  const bits: string[] = [];
  let inputs: RefLocatorInputs | undefined;
  if ("ref" in target && target.ref) {
    inputs = refs.locatorOf(target.ref);
    if (inputs) {
      bits.push(inputs.role);
      if (inputs.name) bits.push(`"${inputs.name}"`);
      if (inputs.testId) bits.push(`[${inputs.testIdAttr ?? "data-testid"}="${inputs.testId}"]`);
    } else {
      bits.push(`ref=${target.ref}`);
    }
  } else if ("selector" in target && target.selector) {
    bits.push(`selector=${target.selector}`);
  } else if ("coords" in target && target.coords) {
    bits.push(`coords=${target.coords.x},${target.coords.y}`);
    return bits.join(" "); // no element to probe further for coords targets
  }
  return `${bits.join(" ")}${await geometryBits(elements, target)}`.trimEnd();
}

/** The measured half of the caption. Every early return below is one arm of the
 *  old body's single try/catch: a failed resolve or a failed box read abandoned
 *  the whole block, so the visibility reads did not run either and the caption
 *  fell back to the descriptive bits alone. Returning early preserves that. */
async function geometryBits(
  elements: ElementSubstrate,
  target: { ref: string } | { selector: string } | { coords: { x: number; y: number } },
): Promise<string> {
  const query = elementQueryFor(target);
  if (!query) return "";
  const resolved = await elements.resolve(query);
  if (resolved.kind === "refusal") return "";
  const measured = await elements.bounds(resolved.el);
  if (measured.kind === "refusal") return "";
  const bits: string[] = [];
  const box = measured.rect;
  if (box) {
    bits.push(
      `bbox=${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}`,
    );
  }
  const read = await elements.probe(resolved.el, { visible: true, enabled: true });
  if (read.kind === "reading") {
    if (read.visible === false) bits.push("not-visible");
    if (read.enabled === false) bits.push("disabled");
  }
  return bits.length > 0 ? ` ${bits.join(" ")}` : "";
}

export function asTarget(args: RawTargetArgs, toolName: string, refs: RefRegistry): ResolvedTarget {
  const provided = [args.ref, args.selector, args.named, args.coords].filter(Boolean).length;
  if (provided > 1)
    throw new Error(
      `${toolName}: pass exactly one of \`ref\` / \`selector\` / \`named\` / \`coords\``,
    );
  if (args.ref) return { ref: args.ref };
  if (args.named) {
    const resolved = refs.refByNameLookup(args.named);
    if (!resolved)
      throw new Error(
        `${toolName}: name "${args.named}" not bound. Call name_ref({name, ref}) first.`,
      );
    return { ref: resolved };
  }
  if (args.selector) {
    return args.contextRef
      ? { selector: args.selector, contextRef: args.contextRef }
      : { selector: args.selector };
  }
  if (args.coords) return { coords: args.coords };
  throw new Error(
    `${toolName}: requires one of \`ref\` (from find/snapshot), \`selector\`, \`named\`, or \`coords\``,
  );
}
