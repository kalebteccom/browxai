/// <reference lib="dom" />
// The player entry point. Bundled by `./build.ts` into one self-contained HTML
// file that opens from `file://`: no server, no CDN, no fonts fetched at
// runtime, no network at all.
//
// An artifact arrives one of two ways. Either the file is embedded in the HTML
// (what a CI job hands a reviewer to double-click), or it is dropped onto the
// page. Both land in the same `load()`.

import { openArtifact, type OpenProgress } from "./artifact-open.js";
import {
  buildTimeline,
  findFirstFailure,
  healthOf,
  idleAt,
  stepIndexAt,
  type Step,
  type TimelineModel,
} from "./model.js";
import { ReplayStage } from "./replay-stage.js";
import {
  bindShell,
  highlightStep,
  renderBanners,
  renderError,
  renderMeta,
  renderPlayhead,
  renderProgress,
  renderStepDetail,
  renderSteps,
  renderStrip,
  setState,
  type Shell,
} from "./view.js";

export const EMBEDDED_ARTIFACT_ID = "browx-embedded-artifact";

interface Session {
  model: TimelineModel;
  stage: ReplayStage | undefined;
  t: number;
  skipIdle: boolean;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function embeddedArtifact(): Uint8Array | undefined {
  const node = document.getElementById(EMBEDDED_ARTIFACT_ID);
  const text = node?.textContent?.trim();
  return text ? decodeBase64(text) : undefined;
}

function progressText(p: OpenProgress): string {
  if (p.phase === "events") {
    return `Reading log — ${p.events.toLocaleString()} events, ${Math.round(p.bytes / 1024)} KB`;
  }
  return `Opening artifact — ${p.phase}`;
}

function seek(shell: Shell, session: Session, t: number, fromStrip = false): void {
  let target = Math.min(Math.max(0, t), session.model.duration);
  if (session.skipIdle && fromStrip) {
    const idle = idleAt(session.model, target);
    if (idle) target = idle.to;
  }
  session.t = target;
  session.stage?.seek(target);
  renderPlayhead(shell, target, session.model);
  const index = stepIndexAt(session.model, target);
  highlightStep(shell, index);
  renderStepDetail(shell, session.model.steps[index]);
}

function selectStep(shell: Shell, session: Session, step: Step, at: "before" | "after"): void {
  session.stage?.pause();
  shell.playPause.textContent = "Play";
  seek(shell, session, at === "before" ? step.before : step.after);
  highlightStep(shell, step.index);
  renderStepDetail(shell, step);
  shell.stepDetail.dataset.at = at;
}

function wireStrip(shell: Shell, session: Session): void {
  shell.strip.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const markStep = target.dataset.stepIndex;
    if (markStep !== undefined && markStep !== "") {
      const step = session.model.steps[Number(markStep)];
      if (step) {
        selectStep(shell, session, step, "after");
        return;
      }
    }
    const rect = shell.strip.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = (ev.clientX - rect.left) / rect.width;
    seek(shell, session, ratio * session.model.duration, true);
  });
}

function wireSteps(shell: Shell, session: Session): void {
  shell.steps.addEventListener("click", (ev) => {
    const li = (ev.target as HTMLElement).closest<HTMLElement>("li.step");
    const index = li?.dataset.stepIndex;
    if (index === undefined) return;
    const step = session.model.steps[Number(index)];
    if (!step) return;
    // A second click on the selected step flips to the other side of it, which
    // is the whole before/after question a reviewer is asking.
    const showAfter =
      shell.stepDetail.dataset.stepIndex === index && shell.stepDetail.dataset.at !== "after";
    selectStep(shell, session, step, showAfter ? "after" : "before");
  });
}

function wireTransport(shell: Shell, session: Session): void {
  shell.playPause.addEventListener("click", () => {
    if (!session.stage) return;
    if (session.stage.isPlaying) {
      session.stage.pause();
      shell.playPause.textContent = "Play";
      return;
    }
    session.stage.play(session.t >= session.model.duration ? 0 : session.t);
    shell.playPause.textContent = "Pause";
  });
  shell.speed.addEventListener("change", () => {
    session.stage?.setSpeed(Number(shell.speed.value) || 1);
  });
  shell.skipIdle.addEventListener("change", () => {
    session.skipIdle = shell.skipIdle.checked;
    session.stage?.setSkipInactive(session.skipIdle);
  });
  shell.jumpFailure.addEventListener("click", () => {
    const failure = findFirstFailure(session.model);
    if (!failure) return;
    selectStep(shell, session, failure, "after");
  });
}

function markFailurePresence(shell: Shell, session: Session): void {
  const failure = findFirstFailure(session.model);
  shell.jumpFailure.disabled = !failure;
  shell.jumpFailure.dataset.failureStep = failure ? String(failure.index) : "";
}

async function load(shell: Shell, bytes: Uint8Array): Promise<void> {
  setState(shell, "loading");
  renderProgress(shell, "Opening artifact…");
  const artifact = await openArtifact(bytes, {
    onProgress: (p) => renderProgress(shell, progressText(p)),
  });
  const model = buildTimeline(artifact.events, { malformed: artifact.malformed });
  const session: Session = { model, stage: undefined, t: 0, skipIdle: false };

  renderMeta(shell, artifact.manifest, model);
  renderBanners(shell, healthOf(artifact.manifest, model, artifact.digestVerified));
  renderSteps(shell, model);
  renderStrip(shell, model);
  markFailurePresence(shell, session);

  session.stage = ReplayStage.create(artifact.events, {
    root: shell.stage,
    clockOrigin: artifact.manifest.clockOrigin,
    onTime: (t) => {
      session.t = t;
      renderPlayhead(shell, t, model);
      highlightStep(shell, stepIndexAt(model, t));
    },
    onFinish: () => {
      shell.playPause.textContent = "Play";
    },
  });
  shell.stageEmpty.hidden = session.stage !== undefined;
  shell.playPause.disabled = session.stage === undefined;

  wireStrip(shell, session);
  wireSteps(shell, session);
  wireTransport(shell, session);
  seek(shell, session, 0);
  renderProgress(shell, `${artifact.events.length.toLocaleString()} events`);
  shell.dropzone.hidden = true;
  setState(shell, "ready");
}

function wireInput(shell: Shell): void {
  const take = (file: File | undefined): void => {
    if (!file) return;
    void file
      .arrayBuffer()
      .then((buf) => load(shell, new Uint8Array(buf)))
      .catch((err: unknown) =>
        renderError(shell, err instanceof Error ? err.message : String(err)),
      );
  };
  shell.filePicker.addEventListener("change", () => take(shell.filePicker.files?.[0]));
  for (const name of ["dragenter", "dragover"]) {
    document.addEventListener(name, (ev) => {
      ev.preventDefault();
      shell.dropzone.classList.add("is-over");
    });
  }
  document.addEventListener("dragleave", () => shell.dropzone.classList.remove("is-over"));
  document.addEventListener("drop", (ev) => {
    ev.preventDefault();
    shell.dropzone.classList.remove("is-over");
    take(ev.dataTransfer?.files?.[0]);
  });
}

export function start(): void {
  const shell = bindShell();
  wireInput(shell);
  const embedded = embeddedArtifact();
  if (!embedded) {
    setState(shell, "empty");
    renderProgress(shell, "Drop a .browx artifact to open it.");
    return;
  }
  void load(shell, embedded).catch((err: unknown) =>
    renderError(shell, err instanceof Error ? err.message : String(err)),
  );
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
}
