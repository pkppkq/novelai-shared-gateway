FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts
RUN npm run check
ENV NODE_ENV=production DATA_DIR=/data HOST=0.0.0.0 PORT=8080
USER 1000:1000
EXPOSE 8080
CMD ["node", "server/index.js"]
