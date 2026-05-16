# Multi-stage build for the CoTrackPro Voice Center.
# Build tier compiles TypeScript; runtime tier ships only what's needed
# to run the compiled output. Keeps the final image under ~200MB.

# ── Build stage ──────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY src ./src
COPY api ./api
COPY scripts ./scripts
RUN npm run build

# Prune devDependencies so the runtime stage only copies what it needs.
RUN npm prune --omit=dev

# ── Runtime stage ────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# tini is a tiny init that forwards signals correctly — important for
# clean WebSocket shutdowns when Fly redeploys the machine.
RUN apk add --no-cache tini

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

USER node
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
