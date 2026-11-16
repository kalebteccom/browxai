// The README's SDK quickstart, pointed at the loopback fixture. run by snapshot.mjs from inside the throwaway project, so
// `import "browxai"` resolves to the package npm installed from the registry, so .depcheckrc.json ignores this file
// (depcheck would report the import as a missing dependency of the repo). Prints one `FR_SDK {json}` line.
import { createBrowxai } from "browxai";

const url = process.argv[2];
const out = {};
const t0 = Date.now();
const mark = (key, since) => {
  out[key] = Date.now() - since;
};
try {
  const browxai = await createBrowxai(); // in-process, single-script
  mark("createMs", t0);
  let t = Date.now();
  const nav = await browxai.navigate({ url });
  mark("navigateMs", t);
  out.navigateChars = JSON.stringify(nav).length;
  t = Date.now();
  const res = await browxai.extract({
    schema: {
      type: "object",
      properties: {
        title: { type: "string", "x-browx-source": { selector: "h1" } },
      },
    },
  });
  mark("extractMs", t);
  out.extractChars = JSON.stringify(res).length;
  out.title = res.data?.title;
  out.warnings = res.data?.warnings ?? res.warnings ?? [];
  await browxai.close();
  out.ok = true;
} catch (e) {
  out.ok = false;
  out.error = String(e?.message ?? e).slice(0, 300);
}
console.log(`FR_SDK ${JSON.stringify(out)}`);
process.exit(out.ok ? 0 : 1);
