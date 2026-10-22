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

CMD ["node", "dist/index.js"]
