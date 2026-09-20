FROM node:22-alpine

ENV NODE_ENV=production \
    DOUBAO_TTS_HOST=0.0.0.0 \
    DOUBAO_TTS_PORT=8000 \
    STORAGE_BACKEND=file \
    DOUBAO_TTS_DATA_DIR=/data

WORKDIR /app

# 先装依赖（命中缓存层）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# 再拷源码与音色表
COPY src ./src
COPY voices.json ./voices.json

# cookie 持久化目录（挂卷到这里）
RUN mkdir -p /data
VOLUME /data

EXPOSE 8000

# /health 探活
HEALTHCHECK --interval=60s --timeout=10s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.DOUBAO_TTS_PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "src/server.ts"]
