// Inline code spans, shared by the build-time dash guard (doc-pipeline.mjs) and the
// static design-rules check, so the two cannot disagree about what counts as code.
// A span opens with a run of backticks and closes with the same run, so a code span
// can hold single backticks (``a `b` c``). One line at a time; fences are the caller's job.
const SPAN = /(`{2,}).+?\1|`[^`]*`/g;

/** The line with every inline code span replaced by `replacement` (empty by default). */
export function stripCodeSpans(line, replacement = "") {
  return line.replace(SPAN, replacement);
}
