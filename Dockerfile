# Remote (HTTP) mode image. The Playwright base image ships Chromium with every
# system dependency and a non-root user; its tag must match the playwright version
# in package.json.
FROM mcr.microsoft.com/playwright:v1.64.1-noble AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM mcr.microsoft.com/playwright:v1.64.1-noble
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Google Chrome for BROWSER_MCP_CHANNEL=chrome: some sites refuse Playwright's Chromium build
# and every headless browser (coupang.com answers 403). Together with BROWSER_MCP_HEADLESS=0 the
# entrypoint starts the server under Xvfb (part of the base image) so Chrome runs with a window.
# Build with --build-arg INSTALL_CHROME=0 to skip the ~300 MB download.
ARG INSTALL_CHROME=1
RUN set -eu; \
    if [ "$INSTALL_CHROME" = "1" ]; then \
      if [ "$(dpkg --print-architecture)" = "amd64" ]; then npx playwright install chrome; \
      else echo "INSTALL_CHROME: Google Chrome has no Linux arm64 build; keeping Playwright's Chromium" >&2; fi; \
    fi; \
    if ! command -v xvfb-run > /dev/null; then \
      apt-get update && apt-get install -y --no-install-recommends xvfb && rm -rf /var/lib/apt/lists/*; \
    fi
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint
RUN chmod +x /usr/local/bin/docker-entrypoint

# Per-user state (logins, downloads, uploads, screenshots) lives here; mount a volume.
RUN mkdir -p /data && chown pwuser:pwuser /data
USER pwuser
VOLUME ["/data"]

ENV BROWSER_MCP_HTTP=1 \
    BROWSER_MCP_HOST=0.0.0.0 \
    BROWSER_MCP_PORT=3000 \
    BROWSER_MCP_DATA_DIR=/data \
    NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

ENTRYPOINT ["docker-entrypoint"]
CMD ["node", "dist/index.js"]
