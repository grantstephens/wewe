# Stateless WebSocket relay — no database, holds rooms only in memory (see
# README.md). Multi-stage so the shipped image carries only the compiled JS
# and the one runtime dependency (ws), not TypeScript/jest/ts-node-dev.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Unprivileged: this process only ever parses small JSON WebSocket frames,
# no reason to run as root.
RUN addgroup -S wewe && adduser -S wewe -G wewe
USER wewe

EXPOSE 8787
CMD ["node", "dist/server.js"]
