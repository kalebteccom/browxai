import type { RefRegistry, RefLocatorInputs } from "../page/refs.js";
import type { RawTargetArgs, ResolvedTarget } from "./host.js";

// Target-resolution domain helpers. These live in a leaf module — depended on by
// the composition root (`createServer`, via `buildHost`) without forcing
// `server.ts` to carry domain logic. `host.ts` is itself a leaf (it only declares
// the `RawTargetArgs` / `ResolvedTarget` seam types), so importing from it here
// closes no cycle: `host-build.ts` already depends on `host.ts`, and nothing in
// `host.ts` imports back from this module.

/** structured one-liner alongside an element screenshot. Skips
 *  vision-reading when the agent only needs to confirm "yes the button is there." */
export async function describeTarget(
  loc: import("playwright-core").Locator,
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
    return bits.join(" "); // no Locator to probe further for coords targets
  }
  try {
    const box = await loc.boundingBox();
    if (box)
      bits.push(
        `bbox=${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}`,
      );
    const visible = await loc.isVisible().catch(() => undefined);
    if (visible === false) bits.push("not-visible");
    const enabled = await loc.isEnabled().catch(() => undefined);
    if (enabled === false) bits.push("disabled");
  } catch {
    /* skip — fall back to whatever we have */
  }
  return bits.join(" ");
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
