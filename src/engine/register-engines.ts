// The engine-registration barrel (RFC 0004 D1). Importing this module runs every
// engine's `registerEngine(...)` call exactly once, populating the EngineRegistry.
// The composition root (createServer / the session factories) imports it for its
// side effect so the registry is fully populated before any session opens.
//
// Adding a sixth engine = one new `adapters/<engine>.engine.ts` module + one line
// here. No edit to any session factory, the session registry, or host-build —
// which is the open-closed claim the ocp-engine-contract keystone proves.
//
// Each import is side-effect-only (the module body calls registerEngine at load);
// `import "./…"` form makes that explicit and keeps the barrel a pure wiring point.

import "./adapters/chromium.engine.js";
import "./adapters/firefox.engine.js";
import "./adapters/webkit.engine.js";
import "./adapters/android.engine.js";
import "./adapters/safari.engine.js";
