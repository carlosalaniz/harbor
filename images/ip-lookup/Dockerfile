# Harbor IP Lookup: one Node process, zero npm dependencies.
# node:24-alpine, multi-arch index (linux/amd64 + linux/arm64), pinned 2026-11-20.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

LABEL org.opencontainers.image.title="harbor-ip-lookup" \
      org.opencontainers.image.description="Looks up an IP address with ipinfo and AbuseIPDB for Harbor's Access Guard" \
      org.opencontainers.image.source="https://github.com/carlosalaniz/harbor" \
      org.opencontainers.image.url="https://github.com/carlosalaniz/harbor/tree/main/images/ip-lookup"

ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --chown=root:root --chmod=0644 package.json server.mjs app.js /app/
USER node
EXPOSE 8080
CMD ["node", "/app/server.mjs"]
