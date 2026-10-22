# Mischer-App: web app + server in one small image.
#   docker build -t mischer-app .
#   docker run -p 8080:8080 -v ./config:/config:ro -v ./data:/data mischer-app
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 CONFIG_FILE=/config/config.json DATA_DIR=/data STATIC_DIR=/app/dist
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1
USER node
CMD ["node", "dist-server/main.mjs"]
