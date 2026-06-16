// Registers every surface. This is the ONLY module that imports them all — the
// HTTP server imports this for its side effect. Adding a surface = add the file
// + one line here.
import { register } from "../registry.js";
import { core } from "./core.js";
import { forms } from "./forms.js";
import { dialogs } from "./dialogs.js";
import { frames } from "./frames.js";
import { shadow } from "./shadow.js";
import { scroll } from "./scroll.js";
import { network } from "./network.js";
import { workers } from "./workers.js";
import { storage } from "./storage.js";
import { mediaFiles } from "./media-files.js";
import { permissions } from "./permissions.js";
import { canvas } from "./canvas.js";
import { gestures } from "./gestures.js";
import { devices } from "./devices.js";
import { consoleSurface } from "./console.js";
import { perf } from "./perf.js";

for (const surface of [
  core,
  forms,
  dialogs,
  frames,
  shadow,
  scroll,
  network,
  workers,
  storage,
  mediaFiles,
  permissions,
  canvas,
  gestures,
  devices,
  consoleSurface,
  perf,
]) {
  register(surface);
}
