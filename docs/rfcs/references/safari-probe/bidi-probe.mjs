// Safari 26.5 WebDriver BiDi module-coverage probe.
// Creates a BiDi session via safaridriver HTTP, connects the WebSocket,
// and exercises one representative command per BiDi module, recording
// success / "unknown command" / other error. Also checks whether
// subscribed events (log, network) actually fire.

const BASE = "http://localhost:4444";

async function http(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const results = [];
const events = new Set();

async function main() {
  const sess = await http("POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "safari",
        webSocketUrl: true,
        "safari:experimentalWebSocketUrl": true,
      },
    },
  });
  const sid = sess.value?.sessionId;
  const wsUrl = sess.value?.capabilities?.webSocketUrl;
  if (!sid || !wsUrl || typeof wsUrl !== "string") {
    console.log(JSON.stringify({ fatal: "no BiDi socket", sess }, null, 2));
    return;
  }
  console.log("session:", sid);
  console.log("wsUrl:", wsUrl);

  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  const ready = deferred();

  ws.addEventListener("open", () => ready.resolve());
  ws.addEventListener("error", (e) => ready.reject(new Error("ws error: " + (e.message || e))));
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const d = pending.get(msg.id);
      pending.delete(msg.id);
      d.resolve(msg);
    } else if (msg.type === "event" && msg.method) {
      events.add(msg.method);
    }
  });

  await ready.promise;

  async function send(method, params = {}, timeoutMs = 6000) {
    const id = nextId++;
    const d = deferred();
    pending.set(id, d);
    ws.send(JSON.stringify({ id, method, params }));
    const timer = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs));
    try {
      const msg = await Promise.race([d.promise, timer]);
      if (msg.type === "error") return { ok: false, error: msg.error, message: msg.message };
      return { ok: true, result: msg.result };
    } catch (e) {
      pending.delete(id);
      return { ok: false, error: "client", message: e.message };
    }
  }

  async function probe(label, method, params, timeoutMs) {
    const r = await send(method, params, timeoutMs);
    results.push({
      module: label,
      method,
      ok: r.ok,
      error: r.ok ? null : r.error,
      message: r.ok ? null : (r.message || "").slice(0, 120),
    });
    return r;
  }

  // --- session ---
  await probe("session", "session.status", {});
  await probe("session", "session.subscribe", {
    events: [
      "log.entryAdded",
      "network.beforeRequestSent",
      "network.responseStarted",
      "browsingContext.load",
    ],
  });

  // --- browsingContext ---
  const tree = await probe("browsingContext", "browsingContext.getTree", {});
  const ctx = tree.result?.contexts?.[0]?.context;
  await probe(
    "browsingContext",
    "browsingContext.navigate",
    { context: ctx, url: "https://example.com/", wait: "complete" },
    15000,
  );
  await probe("browsingContext", "browsingContext.captureScreenshot", { context: ctx });
  await probe("browsingContext", "browsingContext.setViewport", {
    context: ctx,
    viewport: { width: 800, height: 600 },
  });
  await probe("browsingContext", "browsingContext.activate", { context: ctx });
  await probe("browsingContext", "browsingContext.locateNodes", {
    context: ctx,
    locator: { type: "css", value: "h1" },
  });
  const newctx = await probe("browsingContext", "browsingContext.create", { type: "tab" });

  // --- script ---
  const ev = await probe("script", "script.evaluate", {
    expression: "1+2",
    target: { context: ctx },
    awaitPromise: false,
  });
  await probe("script", "script.callFunction", {
    functionDeclaration: "() => document.title",
    target: { context: ctx },
    awaitPromise: false,
  });
  await probe("script", "script.getRealms", {});
  await probe("script", "script.addPreloadScript", {
    functionDeclaration: "() => { window.__bx = 1; }",
  });

  // --- log event check: run a console.log, see if log.entryAdded fired ---
  await probe("script", "script.evaluate", {
    expression: "console.log('bx-probe-marker')",
    target: { context: ctx },
    awaitPromise: false,
  });
  await new Promise((r) => setTimeout(r, 800));

  // --- network ---
  await probe("network", "network.addIntercept", {
    phases: ["beforeRequestSent"],
    urlPatterns: [{ type: "string", pattern: "https://example.com/*" }],
  });
  await probe("network", "network.setCacheBehavior", { cacheBehavior: "bypass" });

  // --- input ---
  await probe("input", "input.performActions", {
    context: ctx,
    actions: [{ type: "none", id: "n", actions: [{ type: "pause", duration: 1 }] }],
  });
  await probe("input", "input.setFiles", {
    context: ctx,
    element: { sharedId: "bogus" },
    files: [],
  });

  // --- storage ---
  await probe("storage", "storage.getCookies", {});
  await probe("storage", "storage.setCookie", {
    cookie: { name: "bx", value: "1", domain: "example.com" },
  });

  // --- emulation (newest module) ---
  await probe("emulation", "emulation.setGeolocationOverride", {
    coordinates: { latitude: 1, longitude: 2, accuracy: 1 },
    contexts: [ctx],
  });

  // --- webExtension ---
  await probe("webExtension", "webExtension.install", {
    extensionData: { type: "path", path: "/nonexistent" },
  });

  await new Promise((r) => setTimeout(r, 400));
  ws.close();
  await http("DELETE", "/session/" + sid);

  console.log("\n=== EVENTS FIRED ===");
  console.log([...events].sort().join("\n") || "(none)");
  console.log("\n=== MODULE COVERAGE ===");
  for (const r of results) {
    const status = r.ok ? "OK  " : r.error === "unknown command" ? "MISS" : "ERR ";
    console.log(
      `${status} ${r.method}${r.ok ? "" : "  <" + r.error + (r.message ? ": " + r.message : "") + ">"}`,
    );
  }
  console.log("\n=== JSON ===");
  console.log(JSON.stringify({ events: [...events], results }, null, 2));
}

main().catch((e) => console.log("FATAL", e.message));
