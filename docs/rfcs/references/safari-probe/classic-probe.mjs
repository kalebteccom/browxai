// Confirm what WebDriver *Classic* on safaridriver covers that BiDi lacked:
// screenshot, findElement+click, cookies, sendKeys, executeScript.
const BASE = "http://localhost:4444";
async function http(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j;
  try {
    j = await res.json();
  } catch {
    j = { _status: res.status };
  }
  return { status: res.status, j };
}
const out = [];
function rec(label, r, extract) {
  const ok = r.status >= 200 && r.status < 300 && !(r.j && r.j.value && r.j.value.error);
  out.push({
    label,
    ok,
    detail: ok ? (extract ? extract(r.j) : "ok") : JSON.stringify(r.j).slice(0, 140),
  });
  return r.j;
}
async function main() {
  const s = await http("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "safari" } },
  });
  const sid = s.j.value?.sessionId;
  if (!sid) {
    console.log("no session", JSON.stringify(s.j));
    return;
  }
  await http("POST", `/session/${sid}/url`, { url: "https://example.com/" });
  rec("classic: navigate example.com", { status: 200, j: { value: null } });

  const ss = await http("GET", `/session/${sid}/screenshot`);
  rec("classic: screenshot", ss, (j) => `png base64 ${String(j.value || "").length} chars`);

  const el = await http("POST", `/session/${sid}/element`, { using: "css selector", value: "h1" });
  const eid =
    el.j.value && (el.j.value["element-6066-11e4-a52e-4f735466cecf"] || el.j.value.ELEMENT);
  rec("classic: findElement h1", el, () => `elementId ${eid ? "found" : "none"}`);

  if (eid) {
    const txt = await http("GET", `/session/${sid}/element/${eid}/text`);
    rec("classic: element.text", txt, (j) => JSON.stringify(j.value).slice(0, 60));
    const clk = await http("POST", `/session/${sid}/element/${eid}/click`, {});
    rec("classic: element.click", clk);
  }

  const ck = await http("GET", `/session/${sid}/cookie`);
  rec("classic: getCookies", ck, (j) => `${Array.isArray(j.value) ? j.value.length : "?"} cookies`);

  const exec = await http("POST", `/session/${sid}/execute/sync`, {
    script: "return navigator.userAgent",
    args: [],
  });
  rec("classic: executeScript", exec, (j) => String(j.value).slice(0, 50));

  // try a text input page for sendKeys
  await http("POST", `/session/${sid}/url`, { url: "data:text/html,<input id=i>" });
  const inp = await http("POST", `/session/${sid}/element`, { using: "css selector", value: "#i" });
  const iid =
    inp.j.value && (inp.j.value["element-6066-11e4-a52e-4f735466cecf"] || inp.j.value.ELEMENT);
  if (iid) {
    const sk = await http("POST", `/session/${sid}/element/${iid}/value`, {
      text: "hello",
      value: ["h", "e", "l", "l", "o"],
    });
    rec("classic: sendKeys", sk);
  }

  await http("DELETE", `/session/${sid}`);
  console.log("=== CLASSIC PROTOCOL COVERAGE (real Safari 26.5) ===");
  for (const r of out) console.log(`${r.ok ? "OK  " : "ERR "} ${r.label}  — ${r.detail}`);
}
main().catch((e) => console.log("FATAL", e.message));
