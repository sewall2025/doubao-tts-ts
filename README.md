# 豆包 TTS · TypeScript 版

逆向豆包网页端 VoiceGenie 语音合成的 Node/TS 客户端 + OpenAI 兼容服务。
**一套代码，两处部署**：Docker/VPS（长驻进程）或 Vercel（serverless）。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsewall2025%2Fdoubao-tts-ts&env=DOUBAO_TTS_API_KEY,STORAGE_BACKEND,KV_REST_API_URL,KV_REST_API_TOKEN,CRON_SECRET&envDescription=STORAGE_BACKEND%20填%20redis%EF%BC%9BKV_REST_API_*%20来自%20Vercel%20KV%2FUpstash%EF%BC%9B部署后往%20KV%20写%20cookie%20键&envLink=https%3A%2F%2Fgithub.com%2Fsewall2025%2Fdoubao-tts-ts%23部署到-vercel)

## 特性

- OpenAI 兼容 `POST /v1/audio/speech`（流式返回，mp3/opus/wav/pcm）
- 304 个音色，白名单校验（简称 / speaker_id / 中文名）
- 音色预览页面 `/ui`（女声/男声分组，填 API Key 试听）
- cookie 自动保温（心跳端点滚动续期，Docker 用定时器 / Vercel 用 Cron）
- 并发限流（Docker 内存 / Vercel 分布式）
- 零 protobuf 依赖，手写编解码

## 快速开始（本地 / Docker）

```bash
npm install
cp .env.example .env      # 填 DOUBAO_TTS_API_KEY
mkdir -p data
# 把浏览器登录豆包后 DevTools → Network → 任意请求复制的完整 Cookie 头写进去：
echo "完整 Cookie 头" > data/.store_cookie
npm run dev               # 或 npm start
```

cookie 不走环境变量，直接写进 `data/.store_cookie`（目录由 `DOUBAO_TTS_DATA_DIR` 控制）。
保温续期会自动回写这个文件。打开 `http://localhost:8000/ui` 预览音色。

### Docker

```bash
docker build -t doubao-tts-ts .
mkdir -p data && echo "浏览器复制的 Cookie 头" > data/.store_cookie
docker run -d -p 8000:8000 \
  -e DOUBAO_TTS_API_KEY=sk-xxx \
  -v $(pwd)/data:/data \
  doubao-tts-ts
```

cookie 落盘到挂载的 `/data`，保温续期会回写，重启不丢。

## 部署到 Vercel

点一下按钮一键克隆部署（会引导你填环境变量）：

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fsewall2025%2Fdoubao-tts-ts&env=DOUBAO_TTS_API_KEY,STORAGE_BACKEND,KV_REST_API_URL,KV_REST_API_TOKEN,CRON_SECRET&envDescription=STORAGE_BACKEND%20填%20redis%EF%BC%9BKV_REST_API_*%20来自%20Vercel%20KV%2FUpstash%EF%BC%9B部署后往%20KV%20写%20cookie%20键)

或命令行：

```bash
vercel
```

需要在 Vercel 项目设置里配环境变量：
- `DOUBAO_TTS_API_KEY` — 鉴权密钥
- `STORAGE_BACKEND=redis`
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` — Vercel KV（或 Upstash）
- `CRON_SECRET`（可选）— 保护定时续期端点

cookie 不走环境变量，存在 KV 里。部署后往 KV 写入 `cookie` 键（值为浏览器复制的完整 Cookie 头）：

```bash
# Upstash CLI 或控制台
redis-cli -u "$KV_REST_API_URL" SET cookie "浏览器复制的完整 Cookie 头"
```

音色表 `voices.json` 在构建时被打包进函数（只读），无需文件系统；与 Docker 共用同一份。

`vercel.json` 已配好：非 `/api/*` 请求路由到 Hono app，Cron 每天 04:00 续期 cookie。
部署时 `vercel-build` 脚本用 esbuild 把 TS 源（含 `.ts` 扩展名 import 与 voices.json）打包成 `dist-vercel/`，
`api/*.mjs` 薄壳引用产物作为 Function 入口（Vercel 默认 runtime 不认 .ts 源）。

> ⚠️ Vercel serverless 有两个限制：函数执行时长上限（Hobby 10s / Pro 60s），
> 长文本合成可能超时；以及并发靠 Redis 分布式限流，比单机信号量粗。
> 高并发 / 长文本场景，Docker/VPS 部署更稳。

## 环境变量

见 [`.env.example`](.env.example)。关键项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DOUBAO_TTS_API_KEY` | 无 | Bearer 鉴权；未设则仅回环可达 |
| `STORAGE_BACKEND` | `file` | `file`（Docker）/ `redis`（Vercel） |
| `DOUBAO_TTS_DATA_DIR` | `./data` | file 后端 cookie 目录（Docker 内为 `/data`） |
| `DOUBAO_TTS_HOST` | `0.0.0.0`/`127.0.0.1` | 监听地址；未设 key 时强制回环 |
| `DOUBAO_TTS_PORT` | `8000` | 监听端口（仅 Docker/本地） |
| `DOUBAO_TTS_MAX_INPUT` | `4096` | 单次文本长度上限 |
| `DOUBAO_TTS_RATE_MAX` | `8` | 限流窗口内最大请求数 |
| `DOUBAO_TTS_RATE_WINDOW` | `1` | 限流窗口秒数 |
| `DOUBAO_TTS_CONCURRENCY` | `8` | 同时连豆包的最大并发数（信号量） |
| `DOUBAO_TTS_KEEPALIVE` | `1` | cookie 保温开关，`0/false/off` 关闭 |
| `DOUBAO_TTS_KEEPALIVE_INTERVAL_H` | `12` | 保温检查间隔（小时，仅 Docker） |
| `DOUBAO_TTS_KEEPALIVE_THRESHOLD_D` | `25` | 剩余天数低于此值才续期 |
| `KV_REST_API_URL` / `_TOKEN` | 无 | redis 后端（Vercel KV / Upstash），也认 `UPSTASH_REDIS_REST_*` |
| `CRON_SECRET` | 无 | （可选）保护 Vercel Cron 续期端点 |

## 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/v1/audio/speech` | 语音合成，OpenAI 兼容，流式 |
| GET | `/v1/audio/voices` | 音色列表（鉴权，支持 `?q= &tab= &limit=`） |
| GET | `/v1/models` | 模型列表（鉴权） |
| GET | `/ui` | 音色预览页面（免鉴权） |
| GET | `/ui/voices` | UI 音色分组（免鉴权） |
| GET | `/health` | 健康检查 |

## 用 OpenAI 客户端调用

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8000/v1", api_key="sk-xxx")
client.audio.speech.create(
    model="tts-1", voice="taozi", input="你好，世界",
).stream_to_file("out.mp3")
```

`voice` 可传简称（`taozi`）、speaker_id（`zh_male_chaawangqiang`、`ICL_xxx`）
或中文名（`成都妹妹`）。不在音色表中返回 422。

## 更新音色表

`voices.json` 由 Python 版 `fetch_voices.py` 从豆包拉取。音色变动时重新拉取覆盖即可。

## License

MIT
