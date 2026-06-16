import { hostRunCommand, resolveDogfoodConfig } from "./config.js";
import { runDogfood } from "./runner.js";

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const config = resolveDogfoodConfig(argv);
  try {
    const result = await runDogfood(config);
    if (config.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(`dogfood report: ${result.reportPath}\n`);
      process.stdout.write(`normalized report: ${result.normalizedReportPath}\n`);
      process.stdout.write(`markdown summary: ${result.markdownPath}\n`);
      if (config.mode === "mock") {
        process.stdout.write(`live host command: ${hostRunCommand()}\n`);
      }
    }
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().then((code) => process.exit(code));
}
