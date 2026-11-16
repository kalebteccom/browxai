// A minimal MCP stdio client: newline-delimited JSON-RPC to a child process. No dependency, so the measurement does not
// depend on any SDK version. Used to start `browxai` the way an MCP client config does (command "browxai", or npx -y browxai).
import { spawn } from "node:child_process";

const PROTOCOL = "2025-06-18";

/** startMcp({ command, args, env, cwd }) -> { request, notify, initialize, callTool, close, stderr } */
export function startMcp({ command, args = [], env, cwd }) {
  const child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 1;
  let buf = "";
  let stderrTail = "";
  let exit = null;

  const failAll = (why) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
      pending.delete(id);
    }
  };
  child.on("error", (e) => {
    exit = { code: -1, signal: null, error: e.message };
    failAll(`could not start ${command}: ${e.message}`);
  });
  child.on("exit", (code, signal) => {
    exit = { code, signal };
    failAll(`${command} exited (code ${code}, signal ${signal}) before it answered`);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => {
    stderrTail = (stderrTail + d).slice(-4000);
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method && msg.id !== undefined) {
        // A request from the server (ping, roots/list): answer with an empty result.
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })}\n`);
      } else if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve({ msg, wireChars: line.length, ms: Date.now() - p.started });
      }
    }
  });

  const send = (obj) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...obj })}\n`);
  /** Resolves { result, error, wireChars, ms }; rejects on timeout or when the child dies. */
  const request = (method, params = {}, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const started = Date.now();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, {
        started,
        timer,
        reject,
        resolve: ({ msg, wireChars, ms }) =>
          resolve({ result: msg.result, error: msg.error, wireChars, ms }),
      });
      send({ id, method, params });
    });

  return {
    request,
    stderr: () => stderrTail,
    exited: () => exit,
    pid: child.pid,
    /** The handshake. Resolves { ms, serverInfo, protocolVersion } or throws. */
    async initialize(timeoutMs = 60_000) {
      const r = await request(
        "initialize",
        {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: { name: "first-run", version: "0" },
        },
        timeoutMs,
      );
      if (r.error) throw new Error(`initialize failed: ${r.error.message}`);
      send({ method: "notifications/initialized" });
      return {
        ms: r.ms,
        serverInfo: r.result?.serverInfo,
        protocolVersion: r.result?.protocolVersion,
      };
    },
    /** tools/call. Resolves { ms, wireChars, textChars, isError, text, data }. */
    async callTool(name, args, timeoutMs = 60_000) {
      const r = await request("tools/call", { name, arguments: args }, timeoutMs);
      if (r.error) {
        return {
          ms: r.ms,
          wireChars: r.wireChars,
          textChars: 0,
          isError: true,
          text: r.error.message,
        };
      }
      const items = Array.isArray(r.result?.content) ? r.result.content : [];
      const text = items
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      let data;
      try {
        const parsed = JSON.parse(items.find((c) => c.type === "text")?.text ?? "");
        if (parsed && typeof parsed === "object") data = parsed;
      } catch {
        /* a snapshot tree is plain text */
      }
      const isError = r.result?.isError === true || data?.ok === false;
      return { ms: r.ms, wireChars: r.wireChars, textChars: text.length, isError, text, data };
    },
    /** Close stdin, wait up to 8 s, then stop the child. */
    async close() {
      child.stdin.end();
      const done = new Promise((res) => child.once("exit", res));
      const t = setTimeout(() => child.kill("SIGTERM"), 8000);
      const k = setTimeout(() => child.kill("SIGKILL"), 15_000);
      if (exit === null) await done;
      clearTimeout(t);
      clearTimeout(k);
    },
  };
}
