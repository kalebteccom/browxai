# browxai in a container — the isolation the plugin and capability model does not provide.
#
# browxai runs plugins in-process with full Node access and, once you enable a
# posture-broadening capability, hands the agent real reach. The capability gate
# says what a tool is allowed to reach; it is not a boundary around the process.
# The boundary is this file.
#
# Base image ships Chromium plus its system dependencies and a non-root `pwuser`.
# Keep the tag's Playwright version aligned with the `playwright-core` range in
# package.json — a mismatch means the bundled browser and the driver disagree.
FROM mcr.microsoft.com/playwright:v1.62.0-noble

ENV NODE_ENV=production \
    BROWX_WORKSPACE=/workspace

# All browxai file IO is workspace-rooted. Mount a volume here to keep profiles,
# screenshots and downloads outside the container's writable layer.
RUN mkdir -p /workspace && chown pwuser:pwuser /workspace

USER pwuser
WORKDIR /home/pwuser

# No install scripts: browxai has none, and the flag makes that a property of the
# build rather than a claim. Pin an exact version for a reproducible image.
RUN npm install --ignore-scripts --no-save browxai@latest

VOLUME ["/workspace"]

# stdio MCP transport by default. For the shared-server lane, override with
# ["npx","browxai","serve","--socket","/workspace/browxai.sock"].
ENTRYPOINT ["npx", "browxai"]
