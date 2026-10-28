FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src ./src
COPY docs/openapi.yaml ./docs/openapi.yaml
COPY node.example.json ./node.example.json
ENV NODE_ENV=production NODE_DATA_DIR=/data PORT=3100 HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 3100
CMD ["node", "src/server.js"]
