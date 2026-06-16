// CLI entry: serve the testbed app for manual inspection.
//   pnpm --filter @browxai/capability-testbed serve
import { startServer } from "./http.js";
import { surfaces } from "./registry.js";

const running = await startServer();
// eslint-disable-next-line no-console
console.log(`capability-testbed serving at ${running.url} (${surfaces().length} surfaces)`);
for (const s of surfaces().slice().sort((a, b) => a.id.localeCompare(b.id))) {
  // eslint-disable-next-line no-console
  console.log(`  ${running.url}${s.path}  —  ${s.id}`);
}

process.on("SIGINT", () => {
  void running.close().then(() => process.exit(0));
});
