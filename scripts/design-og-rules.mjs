// Share-card guard for scripts/check-design-rules.mjs: the generator draws a
// flat SVG, so its code lines carry no gradient, glow, blur, shadow, opacity
// or grid-line markup. Comment lines are skipped.
import { readFileSync } from "node:fs";

const OG_EFFECT =
  /gradient|glow|aurora|blur|shadow|<filter|<pattern|<line\b|backdrop|opacity|stroke-dash/i;

/** [line number, text] for each code line of the generator that draws an effect. */
export function ogEffects(file) {
  const found = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("<!--")) return;
      if (OG_EFFECT.test(line)) found.push([i + 1, t.slice(0, 90)]);
    });
  return found;
}
