FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/assets/package.json ./apps/assets/package.json
COPY apps/multiplayer/package.json ./apps/multiplayer/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/room-schema/package.json ./packages/room-schema/package.json
COPY packages/scene/package.json ./packages/scene/package.json
COPY packages/sync/package.json ./packages/sync/package.json
RUN npm install --global npm@11.19.1 \
    && npm ci --omit=dev --workspace @hearth/multiplayer --include-workspace-root=false \
    && npm cache clean --force

COPY apps/multiplayer/src ./apps/multiplayer/src
COPY packages/domain/src ./packages/domain/src
COPY packages/room-schema/src ./packages/room-schema/src
COPY packages/scene/src ./packages/scene/src

USER node
EXPOSE 2567
CMD ["npm", "run", "start", "--workspace", "@hearth/multiplayer"]
