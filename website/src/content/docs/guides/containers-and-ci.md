---
title: Run browxai in a container and in CI
description: Build the reference Docker image, keep a workspace volume, share one server between containers over a socket, run a script in a CI job, and leave the right capabilities off.
---

This page gets browxai running headless in a container, then in a CI job. It
starts from the reference
[`deploy/Dockerfile`](https://github.com/kalebteccom/browxai/blob/main/deploy/Dockerfile)
in the repository. Nothing here opens a TCP port, and the
[security section](#security-for-a-pipeline) at the end says what to leave off.

## The reference image

The Dockerfile starts from Playwright's own image, `mcr.microsoft.com/playwright`.
That base gives you Chromium with the system libraries it needs and a non-root
user called `pwuser`. The Dockerfile then installs browxai into that user's home
directory with `npm install --ignore-scripts`, sets three environment variables
and declares `/workspace` as a volume.

### Why the tag has to match

browxai pins `playwright-core` to one exact version, and the base image tag names
the same version (`v1.65.1-noble` for browxai 0.19.0). The browser inside the
image is the build that Playwright version expects. With any other tag the
browser and the driver disagree, and the first session fails with Playwright's
"Executable doesn't exist" error.

The Dockerfile installs `browxai@latest`, which can move ahead of the tag. For an
image you rebuild later, pin the release in the `npm install` line, and read its
Playwright version from the registry:

```bash
npm view browxai@0.19.0 dependencies.playwright-core
```

When you move to a newer browxai, change the tag to that version in the same edit.

### Build and check it

```bash
docker build -t browxai-ref deploy/
docker run --rm browxai-ref doctor
```

The entrypoint is `npx browxai`, so anything after the image name is a browxai
subcommand. `doctor` prints one line per area and exits 0 when nothing failed.

### What the image sets

| Setting                      | Why                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `BROWX_HEADLESS=1`           | A container has no display. browxai launches headed unless told otherwise, and the first session fails without a display.           |
| `BROWX_WORKSPACE=/workspace` | All browxai file IO is rooted here, never in the working directory. Profiles, screenshots and downloads land in this directory.     |
| `USER pwuser`                | browxai and Chromium run as a non-root user. `/workspace` is created and owned by that user in the image.                           |
| `VOLUME ["/workspace"]`      | Mount a volume here to keep the workspace out of the container's writable layer, so you can inspect it or throw it away on its own. |

A named volume that starts empty takes its ownership from the image, so
`pwuser` can write to it. A bind mount hides the image's directory. The host
directory has to be writable by the uid `pwuser` has inside the image.

Run it as a stdio MCP server, which is what the entrypoint does with no arguments.
Keep stdin open with `-i`:

```bash
docker run -i --rm --init -v browxai-workspace:/workspace browxai-ref
```

`--init` adds a small init process, so Chromium's child processes get reaped and
signals reach browxai.

### Which browser it launches

With no `BROWX_CHANNEL`, browxai first looks for an installed Google Chrome. The
Playwright image has none, so it logs a warning and falls back to the bundled
Chromium. Set `BROWX_CHANNEL=chromium` to go straight to the bundled build and
skip the warning.

### Sandbox flags and shared memory

browxai adds no `--disable-dev-shm-usage` to the Chromium launch, and it never
writes `--no-sandbox` itself. The flags it builds itself are few:
`--disable-web-security` and `--disable-site-isolation-trials` only when
`BROWX_DISABLE_WEB_SECURITY` is set, the extension flags when you load an
extension, and three background-throttling flags when `open_session` gets
`backgroundThrottling: "disabled"`. It also drops Playwright's
`--enable-automation` switch. See `src/session/launch-options.ts` and
`src/session/chromium-launch-posture.ts`.

Chromium's own OS sandbox is a separate setting, `BROWX_CHROMIUM_SANDBOX`
(config key `chromiumSandbox`). In the Playwright source browxai builds on,
Chromium gets `--no-sandbox` unless a launch sets `chromiumSandbox: true`, and
`--disable-dev-shm-usage` is among Playwright's default switches. The setting
decides whether browxai passes `chromiumSandbox: true`:

| Value            | What a launched browser does                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auto` (default) | Asks for the sandbox when the process is not root, not in a container, and the host can run it. Otherwise launches with `--no-sandbox` and logs one warning. |
| `on`             | Always asks for the sandbox. A launch that cannot start it fails, and the error names `BROWX_CHROMIUM_SANDBOX=off`.                                          |
| `off`            | Playwright's default: `--no-sandbox`, with no warning.                                                                                                       |

A container is detected from `/.dockerenv`, `/run/.containerenv` or a container
name in `/proc/1/cgroup`. A container running the reference image needs no
setting: `auto` launches Chromium with `--no-sandbox` and the container is the
boundary around page content, as it was before this setting existed. The warning
prints once per process. Set `BROWX_CHROMIUM_SANDBOX=off` (for example
`-e BROWX_CHROMIUM_SANDBOX=off` on `docker run`) to say that is on purpose and
drop the warning. CI runners that run as root get the same result for the same
reason, because Chromium does not start its sandbox as root.

Container detection reads marker files and cgroup hints, and a host on cgroup v2
with no marker file (some containerd and Kubernetes setups) shows neither. There
the first launch asks for the sandbox, fails, retries once without it and logs
one warning. Later launches in the same process remember that and skip the sandbox
with no second failed start. `BROWX_CHROMIUM_SANDBOX=off` skips the first attempt
too.

On Windows `auto` tries the sandbox and has no launch-time failure signal for a
restricted environment, such as a Server Core container or a service account. If
pages crash there, set `BROWX_CHROMIUM_SANDBOX=off`. Windows is not verified.

`on` in a container needs an environment that supports Chromium's sandbox. When
a launch fails on it, Playwright's own message says to "Configure your environment
to support sandboxing". This guide does not state which flags or capabilities a
given container runtime needs: see Chromium's sandbox documentation for that. To
see what `auto` decided on a host and why, run `browxai doctor` there. Its
`chromium-sandbox` row says.

A Chrome you start yourself and attach to keeps its own sandbox, including one
started with `browxai chrome start`. With the sandbox off, the container is the
boundary around page content, and the capability gates and origin lists are
policy. That makes the non-root user and the security section below matter.

## One server, several containers

`browxai serve --socket PATH` runs one long-lived server on a Unix socket. Every
client that connects shares its sessions, its config and its capability set. Each
session still launches its own browser process. Put the socket
on the workspace volume and a second container can reach it.

```bash
docker volume create browxai-workspace

docker run -d --init --name browxai-daemon \
  -v browxai-workspace:/workspace \
  browxai-ref serve --socket /workspace/browxai.sock
```

A second container from the same image runs the shell commands against it.
[Drive browxai from a shell](/guides/shell-route/) covers `browxai tools`,
`browxai call`, the JSON output and the exit codes.

```bash
docker run --rm -v browxai-workspace:/workspace browxai-ref \
  tools --socket /workspace/browxai.sock

docker run --rm -v browxai-workspace:/workspace browxai-ref \
  call open_session '{"session":"work","mode":"incognito"}' --socket /workspace/browxai.sock

docker run --rm -v browxai-workspace:/workspace browxai-ref \
  call navigate '{"session":"work","url":"https://example.com"}' --socket /workspace/browxai.sock
```

The SDK attaches the same way, from a script in a project that has browxai
installed:

```ts
import { createBrowxai } from "browxai";

const browxai = await createBrowxai({ endpoint: "unix:///workspace/browxai.sock" });
await browxai.snapshot({ session: "work" });
await browxai.close(); // ends this connection only, the server keeps running
```

The capability set belongs to the server. Pass `-e BROWX_CAPABILITIES=...` to the
`docker run` that starts the daemon, because a client cannot widen it.

### The socket file and user ids

The daemon creates the socket with mode `0600`. It sets the umask before the
socket exists, so the file is never wider. Only the user that runs the daemon (and
root) can connect, and Linux checks the numeric uid.

- A second container from the same image runs as `pwuser` too, so the uid matches
  and it connects.
- A process with another uid gets a permission error. `browxai call` reports it
  as exit code 3, and `createBrowxai` throws.
- To reach the daemon from the host, run the daemon with `--user "$(id -u):$(id -g)"`
  and a bind mount the host user owns, so the socket belongs to you. That setup is
  not tested here. On Docker Desktop the containers run inside a VM, and a socket
  on a bind mount may not be reachable from the host side, so use a second
  container there.

The daemon removes a stale socket at its path when it starts, so
`docker restart browxai-daemon` works. The daemon handles SIGTERM by closing its
connections and removing the socket, so `docker stop` is the way to end it.

## A CI job

A pipeline job needs four things: browxai installed, the machine checked, a
script that does the work, and an exit code the runner can read. Both examples
below run the same script. Save it as `ci/check.mjs` in your repository:

```js
import { createBrowxai } from "browxai";

const browxai = await createBrowxai(); // in-process, headless from BROWX_HEADLESS=1
const session = "ci";
let code = 0;
try {
  const opened = await browxai.open_session({ session, mode: "incognito" });
  if (!opened.ok) throw new Error(opened.error ?? "open_session failed");

  const nav = await browxai.navigate({ session, url: "https://example.com", timeoutMs: 30000 });
  if (!nav.ok) throw new Error(`navigate failed: ${JSON.stringify(nav.failure)}`);

  const check = await browxai.verify_count({ session, selector: "h1", n: 1 });
  if (!check.ok) throw new Error(`check failed: ${JSON.stringify(check.failure)}`);
} catch (err) {
  console.error(err);
  code = 1;
} finally {
  await browxai.close();
}
process.exit(code);
```

`mode: "incognito"` gives the job a clean browser context with nothing on disk.
The default session is a persistent profile in the workspace, and only one live
session can hold a profile.

### GitHub Actions, in the reference image

This job builds the reference image and runs the script inside it, so the
browser is never on the runner itself. It copies the script into the image's home
directory, where `import "browxai"` resolves.

```yaml
name: browser-check
on: [pull_request]
permissions: {}

jobs:
  browser-check:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
        with:
          persist-credentials: false
      - name: Build the reference image
        run: docker build -t browxai-ref deploy/
      - name: Check the environment
        run: docker run --rm browxai-ref doctor
      - name: Run the script
        run: |
          docker run --rm --init --entrypoint node \
            -e BROWX_CAPABILITIES=read,navigation,action,human \
            -v "$PWD/ci/check.mjs:/home/pwuser/check.mjs:ro" \
            browxai-ref check.mjs
```

The step fails when the container exits non-zero, and `docker run` passes the
script's exit code through. `timeout-minutes` stops a job that hangs somewhere a
per-call deadline cannot see.

### Generic shell, on the runner

Without Docker, install browxai and a browser on the machine. This version also
shows the daemon route, where each step is one `browxai call` and `set -e` stops
at the first failure.

```bash
#!/bin/sh
set -eu

npm ci --ignore-scripts
npx playwright-core@1.65.1 install --with-deps chromium

export BROWX_HEADLESS=1
export BROWX_CHANNEL=chromium
export BROWX_WORKSPACE="$(mktemp -d)"

npx browxai doctor          # exit 0 when no check failed, 1 otherwise

node ci/check.mjs           # the SDK script above, exit 0 or 1
```

For the daemon route, replace the last line with:

```bash
sock="$BROWX_WORKSPACE/browxai.sock"
npx browxai serve --socket "$sock" &
daemon=$!
trap 'kill "$daemon"' EXIT

i=0
until [ -S "$sock" ]; do
  i=$((i + 1))
  [ "$i" -le 100 ] || { echo "daemon did not start" >&2; exit 3; }
  sleep 0.2
done

export BROWX_SOCKET="$sock" BROWX_SESSION=ci
npx browxai call open_session '{"mode":"incognito"}'
npx browxai call navigate '{"url":"https://example.com","timeoutMs":30000}'
npx browxai call verify_count '{"selector":"h1","n":1}'
npx browxai call close_session
```

`mktemp -d` creates a directory only the job's user can enter, which suits the
socket. Exit codes from `browxai call`: 0 ok, 1 the tool failed or its result
has `ok: false` (a failed `verify_count` is one), 2 usage, 3 the daemon could not
be reached, 4 a capability gate refused the call. A step that gets 4 won't pass
on retry. The capability set has to change and the daemon has to restart.

On a GitHub-hosted runner the browser install adds the download described below to
each run unless you cache it. The Docker version above builds an image instead.

## Resources

- **Per-call deadline.** Every action and read tool runs under a hard deadline,
  `actionTimeoutMs`, 5000 ms by default. A stuck page returns an `ok:false`
  anti-wedge failure within that time, so a call can't hang the job. Each tool
  takes a `timeoutMs` for one call that you know is slow, and the script above
  passes 30000 for a first `navigate`. The deadline cannot cancel the work that
  got stuck. If `snapshot`, `navigate` or `screenshot` keep timing out on one
  session, close it and open a new one. The deadline applies to each call. A script
  can still run long, so keep a job timeout too.
- **Browser download.** On a machine with no Google Chrome, the bundled Chromium
  is about 300 MB to download and about 700 MB on disk, per the
  [getting started](/getting-started/) page. The reference image already holds the
  browser, so a container run downloads nothing.
- **One daemon, one browser per session.** Clients that attach to the same
  `serve --socket` server share its sessions, and each session is its own
  browser process. Give each client its own session id, run calls on a single
  session one at a time, and close sessions when a job is done.
- **The workspace.** Profiles, screenshots, downloads and diagnostics all land in
  `BROWX_WORKSPACE`. Use a fresh directory or volume per job, and delete it
  afterwards.
- **Navigation confirmation.** With `BROWX_ALLOWED_ORIGINS` set, a `navigate` to
  an origin off the list asks for a person to confirm, and a headless job has no
  one to answer. The call waits five minutes, then fails. List every origin the
  script visits. See [Configuration](/guides/configuration/).

## Security for a pipeline

The capability gate and the origin list are policy for what the tools do when
asked. The container is the boundary around the process. The
[best practices](/security/best-practices/) page has the full list, including the
deployment checklist. For a pipeline job:

- Start from the default capabilities and add only what the script needs.
  `BROWX_CAPABILITIES` replaces the default set, so a list has to keep
  `read,navigation,action,human`.
- Leave `eval`, `network-body`, `secrets`, `credentials`, `captcha`, `stealth`,
  `extensions`, `byob-attach`, `self-approval`, `human-gate-override`,
  `operator-channel` and `live-view` off. A job that saves screenshots needs only
  `file-io`:

  ```bash
  BROWX_CAPABILITIES=read,navigation,action,human,file-io
  ```

  Output stays inside `BROWX_WORKSPACE`.

- Set `BROWX_ALLOWED_ORIGINS` to the sites the job tests, as a comma-separated
  list. `https://*.example.com` matches subdomains.
- Give the container only the network routes the job needs, and keep your
  internal services out of reach. The pipeline runner holds credentials, which is
  why the browser goes in a container.
- Don't bake a logged-in profile into an image. A profile holds live credentials.
- Pin the browxai version and commit your lockfile. Read
  [the threat model](/security/threat-model/) before enabling any capability that
  isn't in the default set.
