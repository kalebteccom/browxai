// Print the Lighthouse block from run.mjs's results file and set the exit status.
// Usage: node report.mjs <results.json>
// Exit status: 0 every median is at or above the thresholds in block.mjs, 1 a median is below one, 2 a tool error (a page without a usable run, or no results).
import { readFileSync } from "node:fs";
import { boxLines, pageLines, renderBlock, summarize } from "./block.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: report.mjs <results.json>");
  process.exit(2);
}
let results;
try {
  results = JSON.parse(readFileSync(file, "utf8"));
} catch (error) {
  console.error(`report: cannot read ${file}: ${error.message}`);
  process.exit(2);
}
if (!results.pages?.length) {
  console.error("report: the results file has no pages");
  process.exit(2);
}
const summaries = results.pages.map((p) => ({
  label: `${p.page} ${p.preset}`,
  s: summarize(p.runs),
}));
const headers = boxLines({ ...results });
console.log(
  renderBlock(
    headers,
    summaries.map(({ label, s }) => pageLines(label, s)),
  ),
);
// One run that errored out is noise under box load; a page with no usable run is a tool error.
if (summaries.some(({ s }) => !s.ok)) process.exit(2);
process.exit(summaries.some(({ s }) => s.below.length) ? 1 : 0);
