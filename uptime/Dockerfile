FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends iputils-ping \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production \
    DATA_DIR=/data \
    CONFIG_FILE=/config/monitors.json \
    PORT=3000
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=60s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.js"]
