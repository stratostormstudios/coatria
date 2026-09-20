# Same reviewed linux/amd64 Node 24.19.0 image as the managed-worker CI runtime.
FROM node@sha256:e5a8dee7bc1e6a215d224a7ef8206f7e77271bc3cabd5febf2beafac0674f174
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts && npm cache clean --force
COPY src/lib ./src/lib
COPY scripts/storage-gateway.ts ./scripts/storage-gateway.ts
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4190
EXPOSE 4190
CMD ["node","--import","tsx","scripts/storage-gateway.ts"]
