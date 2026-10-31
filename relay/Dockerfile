# Build from the repository root: docker build -f relay/Dockerfile .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY relay relay
RUN npm ci --workspace @tb/protocol --workspace @tb/relay --include-workspace-root \
 && npm run build -w @tb/protocol && npm run build -w @tb/relay \
 && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/protocol/package.json packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist packages/protocol/dist
COPY --from=build /app/relay/package.json relay/package.json
COPY --from=build /app/relay/dist relay/dist
COPY --from=build /app/relay/schema.sql relay/schema.sql
USER node
EXPOSE 8080
CMD ["node", "relay/dist/server.js"]
