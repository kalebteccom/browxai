// The README's "Share one browser across agents" path, from the client side: two SDK clients attached to one running
// `browxai serve --socket <path>` by `endpoint: "unix://<path>"`. Run by paths-socket.mjs from inside the throwaway project
// (copied next to procs.mjs), so `import "browxai"` resolves to the package npm installed from the registry; .depcheckrc.json
// ignores this file for the same reason as sdk-quickstart.mjs. The server runs in another process and Chrome is its child.
// Env: FR_SOCKET (socket path), FR_URL (loopback page), FR_WORK (throwaway directory). Prints one `FR_PATHS {json}` line of
// facts; paths-socket.mjs decides which of them are differences from the docs.
import { createBrowxai } from "browxai";
import { chromeMains, readTable, waitUntil } from "./procs.mjs";

const { FR_SOCKET: socket, FR_URL: url, FR_WORK: work } = process.env;
const out = { steps: [], counts: {} };
const text = (r) => (r?.content ?? []).map((c) => c.text ?? "").join("\n");
const failed = (r) => r?.data?.ok === false;
const count = () => {
  const rows = readTable();
  return rows ? chromeMains(rows, work).length : null;
};
const settle = async (target) => {
  // Chrome exits a moment after its session closes: wait for the count to reach the target.
  await waitUntil(() => count() === target, 10_000);
  return count();
};
let a;
let b;
const step = async (label, fn) => {
  const started = Date.now();
  try {
    const value = await fn();
    out.steps.push({ label, ok: true, ms: Date.now() - started });
    return value;
  } catch (e) {
    out.steps.push({ label, ok: false, ms: Date.now() - started });
    throw e;
  }
};

try {
  out.counts.start = count();
  a = await step("attach A", () => createBrowxai({ endpoint: `unix://${socket}` }));
  b = await step("attach B", () => createBrowxai({ endpoint: `unix://${socket}` }));

  const opened = await step("A open_session", () =>
    a.open_session({ session: "fr-a", mode: "incognito" }),
  );
  if (failed(opened)) throw new Error(`A open_session: ${text(opened).slice(0, 200)}`);
  const nav = await step("A navigate", () => a.navigate({ session: "fr-a", url }));
  if (failed(nav)) throw new Error(`A navigate: ${text(nav).slice(0, 200)}`);
  out.counts.afterA = count();

  // B sees what A opened.
  const listed = await step("B list_sessions", () => b.list_sessions());
  const row = listed.data?.sessions?.find((s) => s.id === "fr-a");
  out.bSees = Boolean(row);
  out.bSeesUrl = row?.url ?? null;
  out.bSessionIds = (listed.data?.sessions ?? []).map((s) => s.id);

  // B reads the page A opened: one browser, so one tab.
  const snapB = await step("B snapshot of A's session", () => b.snapshot({ session: "fr-a" }));
  out.bReadsPage = /\[ref=e\d+\]/.test(text(snapB)) && text(snapB).includes("Subscribe");
  out.counts.afterBRead = count();

  // B opens a session of its own (a documented incognito session).
  const second = await step("B open_session", () =>
    b.open_session({ session: "fr-b", mode: "incognito" }),
  );
  out.bOpenOk = !failed(second);
  out.counts.afterBOpen = count();

  // Closing B must leave A alone.
  await step("B close_session + close", async () => {
    await b.close_session({ session: "fr-b" });
    await b.close();
  });
  out.counts.afterBClose = await settle(out.counts.afterA);
  const listedA = await step("A list_sessions", () => a.list_sessions());
  out.aStillListed = Boolean(listedA.data?.sessions?.some((s) => s.id === "fr-a"));
  const snapA = await step("A snapshot", () => a.snapshot({ session: "fr-a" }));
  out.aStillWorks = /\[ref=e\d+\]/.test(text(snapA)) && text(snapA).includes("Subscribe");

  await step("A close_session + close", async () => {
    await a.close_session({ session: "fr-a" });
    await a.close();
  });
  out.counts.afterAClose = await settle(0);
  out.ok = true;
} catch (e) {
  out.ok = false;
  out.error = String(e?.message ?? e).slice(0, 300);
} finally {
  await a?.close().catch(() => {});
  await b?.close().catch(() => {});
}
console.log(`FR_PATHS ${JSON.stringify(out)}`);
process.exit(out.ok ? 0 : 1);
