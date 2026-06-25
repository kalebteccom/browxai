// Browser-realm page script for the fs-picker policy. Realm 2 of the
// fs-picker split (the *_PAGE_SCRIPT constant) — sibling realms are
// `fs-picker-policy` (Node-side state) and `fs-picker-attach` (the Playwright
// binding adapter). Re-exported by the `fs-picker` barrel.
//
// This is browser-only JS, stringified. Do NOT inline, transform, or rewrite
// it in TS — the serialization contract (it is passed verbatim to
// `addInitScript` / `page.evaluate`) depends on its exact text, and the
// install-plumbing test asserts byte-identity. Keep browser-only JS — no
// TS-only syntax.
//
// Why one layer (init-script stubs) instead of two (CDP + init-script):
//   - There is no CDP analogue for the File System Access API — Chromium
//     exposes the picker UX only via the real OS file chooser, which
//     headless can't drive and which (on attached Chrome) wouldn't route
//     through the agent. The init-script stub IS the policy enforcement
//     point. The native `window.show*FilePicker` is replaced before any
//     page script runs, so the original is never called.
//
// FileSystemFileHandle.createWritable() handling:
//   - In `allow` mode for `showSaveFilePicker`, the agent supplies a
//     workspace-rooted `path` via `fs_picker_respond`. The init-script
//     stub returns a synthetic `FileSystemFileHandle` whose
//     `createWritable()` returns a stub `FileSystemWritableFileStream`
//     that routes every `write(chunk)` / `truncate()` / `close()` /
//     `abort()` through a server-side binding (`__browx_fs_picker_write`),
//     which append-writes to the workspace path. Workspace-escape on the
//     path is rejected at `fs_picker_respond` time (the agent never
//     supplies a path to the page-side stub directly).
//   - In `allow` mode for `showOpenFilePicker`, the agent supplies either
//     inline `{contents, name}` (base64 file bytes the page reads back
//     via `getFile()`) or a workspace-rooted `{path}` (server reads the
//     file once at respond time and inlines the bytes). The handle's
//     `createWritable()` returns a no-op stub — open-pickers are
//     read-side; the agent didn't supply a destination.
//   - `showDirectoryPicker` returns a minimal directory handle: `.name`
//     is the basename of the agent-supplied path (or "browxai-virtual"
//     when synthetic); `entries()` / `values()` / `keys()` iterate empty.
//     Best-effort by construction — a real directory tree would require
//     either reading the workspace path recursively (heavy + a footgun
//     when the workspace holds artefacts the page shouldn't see) or
//     synthesising one from agent input (complex). MVP scope is "the
//     picker dialog doesn't deadlock and the page can check that it got
//     a directory" — most modern editors will then re-prompt for
//     individual files.

/** Init script that replaces the page-side File System Access entry points
 *  with stubs that route through the per-session policy. Stringified so it
 *  can be passed to `addInitScript` and `page.evaluate`. Keep browser-only
 *  JS — no TS-only syntax. Re-injected on `framenavigated` (idempotent:
 *  guards on `window.__browx_fs_picker_installed`).
 *
 *  The stubs consult `window.__browx_fs_picker_check({api, suggestedName})`
 *  (an exposeBinding callable from page context) — it returns one of:
 *    - `{decision:"allow", files:[{handleId, name, mimeType, contents?}]}`:
 *      the agent staged file(s); the stub builds synthetic
 *      `FileSystemFileHandle` / `FileSystemDirectoryHandle` objects whose
 *      `getFile()` returns a synthetic `File` and `createWritable()` returns
 *      a synthetic writable stream routed through
 *      `__browx_fs_picker_write({handleId, op, data?})`.
 *    - `{decision:"deny"}`: the stub throws `NotAllowedError`.
 *
 *  Stubs are written to be browser-only JS (no TS-only syntax). The
 *  install guards on `window.__browx_fs_picker_installed`. */
export const FS_PICKER_PAGE_SCRIPT = `(() => {
  if (window.__browx_fs_picker_installed) return;
  window.__browx_fs_picker_installed = true;

  function check(api, suggestedName) {
    try {
      if (typeof window.__browx_fs_picker_check === "function") {
        return Promise.resolve(window.__browx_fs_picker_check(JSON.stringify({
          api: api, suggestedName: suggestedName,
        })));
      }
    } catch (_) {}
    // Binding missing — safe-by-default deny so the page never deadlocks.
    return Promise.resolve(JSON.stringify({ decision: "deny" }));
  }

  function notAllowed(msg) {
    var e = new Error(msg || "The user aborted a request.");
    try { e.name = "NotAllowedError"; } catch (_) {}
    return e;
  }

  function b64ToBytes(b64) {
    try {
      var binary = atob(b64);
      var len = binary.length;
      var bytes = new Uint8Array(len);
      for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch (_) {
      return new Uint8Array(0);
    }
  }

  function syntheticFile(spec) {
    var name = spec.name || "browxai-virtual";
    var mimeType = spec.mimeType || "application/octet-stream";
    var bytes = spec.contents ? b64ToBytes(spec.contents) : new Uint8Array(0);
    try {
      return new File([bytes], name, { type: mimeType });
    } catch (_) {
      // Fallback Blob-shaped object for environments without File (test
      // pages); the constructor is universally available on real browsers.
      var blob = new Blob([bytes], { type: mimeType });
      blob.name = name;
      return blob;
    }
  }

  function syntheticWritable(handleId) {
    // Route every operation through the server-side binding. Each call is
    // ack'd by the binding so we surface back-pressure to a determined page
    // (await stream.write(buf) resolves only after the write hit disk).
    function call(op, data) {
      try {
        if (typeof window.__browx_fs_picker_write === "function") {
          return Promise.resolve(window.__browx_fs_picker_write(JSON.stringify({
            handleId: handleId, op: op, data: data == null ? null : data,
          })));
        }
      } catch (_) {}
      return Promise.resolve(undefined);
    }
    return {
      write: function (data) {
        // Accept BufferSource | Blob | string | { type:"write"|"seek"|"truncate", … }
        if (data == null) return Promise.resolve(undefined);
        if (typeof data === "string") return call("write", data);
        if (data.type === "seek") return call("seek", String(data.position || 0));
        if (data.type === "truncate") return call("truncate", String(data.size || 0));
        if (data.type === "write" && data.data != null) return call("write", encodeForBinding(data.data));
        return call("write", encodeForBinding(data));
      },
      seek: function (position) { return call("seek", String(position || 0)); },
      truncate: function (size) { return call("truncate", String(size || 0)); },
      close: function () { return call("close"); },
      abort: function () { return call("abort"); },
    };
  }

  function encodeForBinding(data) {
    // base64-encode any BufferSource / Blob / string for binding transport.
    // exposeBinding payloads are strings; we wrap as "b64:<base64>" so the
    // server side can distinguish from a literal text write.
    function bytesToB64(bytes) {
      var s = "";
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      try { return "b64:" + btoa(s); } catch (_) { return "b64:"; }
    }
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return bytesToB64(new Uint8Array(data));
    if (ArrayBuffer.isView && ArrayBuffer.isView(data)) {
      return bytesToB64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    if (data instanceof Blob) {
      // Synchronous-from-page Promise; the binding awaits.
      return data.arrayBuffer().then(function (ab) { return bytesToB64(new Uint8Array(ab)); });
    }
    return String(data);
  }

  function syntheticFileHandle(spec) {
    var handleId = spec.handleId;
    var name = spec.name || "browxai-virtual";
    return {
      kind: "file",
      name: name,
      getFile: function () { return Promise.resolve(syntheticFile(spec)); },
      createWritable: function () { return Promise.resolve(syntheticWritable(handleId)); },
      // Minimal queryPermission / requestPermission — the page often probes
      // before reading. Always "granted" for our virtual handles.
      queryPermission: function () { return Promise.resolve("granted"); },
      requestPermission: function () { return Promise.resolve("granted"); },
      // Comparison helper expected by some libraries.
      isSameEntry: function (other) { return Promise.resolve(other === this); },
    };
  }

  function syntheticDirectoryHandle(spec) {
    var name = spec.name || "browxai-virtual";
    // MVP scope: empty directory. Most editors will fall back to per-file
    // pickers when iteration yields nothing.
    var empty = {
      next: function () { return Promise.resolve({ value: undefined, done: true }); },
      return: function () { return Promise.resolve({ value: undefined, done: true }); },
    };
    var emptyIter = { __asyncIterator__: true };
    emptyIter[Symbol.asyncIterator] = function () { return empty; };
    return {
      kind: "directory",
      name: name,
      entries: function () { return emptyIter; },
      values: function () { return emptyIter; },
      keys: function () { return emptyIter; },
      getFileHandle: function () { return Promise.reject(notAllowed("Not found in virtual directory")); },
      getDirectoryHandle: function () { return Promise.reject(notAllowed("Not found in virtual directory")); },
      removeEntry: function () { return Promise.resolve(undefined); },
      resolve: function () { return Promise.resolve(null); },
      queryPermission: function () { return Promise.resolve("granted"); },
      requestPermission: function () { return Promise.resolve("granted"); },
      isSameEntry: function (other) { return Promise.resolve(other === this); },
      [Symbol.asyncIterator]: function () { return empty; },
    };
  }

  function installStub(apiName, isDirectory, isMulti) {
    Object.defineProperty(window, apiName, {
      configurable: true,
      writable: true,
      value: function (options) {
        var suggestedName = options && options.suggestedName ? String(options.suggestedName) : undefined;
        return check(apiName, suggestedName).then(function (raw) {
          var resp;
          try { resp = typeof raw === "string" ? JSON.parse(raw) : (raw || {}); } catch (_) { resp = { decision: "deny" }; }
          if (resp.decision !== "allow") {
            throw notAllowed("The user aborted a " + apiName + " request.");
          }
          var files = Array.isArray(resp.files) ? resp.files : [];
          if (isDirectory) {
            var dirSpec = files[0] || { handleId: resp.handleIdFallback || "dir-0", name: "browxai-virtual" };
            return syntheticDirectoryHandle(dirSpec);
          }
          if (isMulti) {
            return files.map(function (f) { return syntheticFileHandle(f); });
          }
          var spec = files[0] || { handleId: resp.handleIdFallback || "file-0", name: "browxai-virtual" };
          return syntheticFileHandle(spec);
        });
      },
    });
  }

  // showOpenFilePicker: returns Array<FileSystemFileHandle> (multi by default).
  installStub("showOpenFilePicker", false, true);
  // showSaveFilePicker: returns FileSystemFileHandle (single).
  installStub("showSaveFilePicker", false, false);
  // showDirectoryPicker: returns FileSystemDirectoryHandle (single).
  installStub("showDirectoryPicker", true, false);
})();`;
