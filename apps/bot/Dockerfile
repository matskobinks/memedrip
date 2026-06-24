# ============================================================
# MemeDrip Backend — Multi-stage Dockerfile
# Stage 1: build the shared-types + bot TypeScript
# Stage 2: lean runtime image with only production deps
# ============================================================

# ---------- Stage 1: builder ----------
FROM node:20-slim AS builder

WORKDIR /app

# Copy workspace manifests first to leverage Docker layer caching
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY apps/bot/package.json ./apps/bot/

# Install ALL deps (including devDeps needed for compilation)
RUN npm install --workspaces --include-workspace-root

# Copy source
COPY packages/shared-types ./packages/shared-types
COPY apps/bot ./apps/bot

# Build shared types first, then the bot
RUN npm run build:shared && npm run build:bot

# Prune to production deps for the runtime stage
RUN npm prune --omit=dev

# ---------- Stage 2: runtime ----------
FROM node:20-slim AS runtime

WORKDIR /app

# Copy production node_modules, package metadata, and compiled output
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared-types/package.json ./packages/shared-types/
COPY --from=builder /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=builder /app/packages/shared-types/node_modules ./packages/shared-types/node_modules
COPY --from=builder /app/apps/bot/package.json ./apps/bot/
COPY --from=builder /app/apps/bot/dist ./apps/bot/dist
COPY --from=builder /app/apps/bot/node_modules ./apps/bot/node_modules

# Non-root user for security
USER node

# WebSocket relay port (configurable at runtime)
ENV WS_PORT=7878
EXPOSE 7878

# Graceful shutdown via tini
CMD ["node", "apps/bot/dist/index.js"]
