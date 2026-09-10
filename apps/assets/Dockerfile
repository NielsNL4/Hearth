FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY apps/assets/package.json apps/assets/tsconfig.json ./
RUN npm install
COPY apps/assets/src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY apps/assets/package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3100
CMD ["node", "dist/index.js"]
