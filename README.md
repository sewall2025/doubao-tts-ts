# 豆包 TTS · TypeScript 版

逆向豆包网页端 VoiceGenie 语音合成的 Node/TS 客户端 + OpenAI 兼容服务。
**一套代码，两处部署**：Docker/VPS（长驻进程）或 Vercel（serverless）。

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
cp .env.example .env      # 填 DOUBAO_TTS_API_KEY 和 DOUBAO_TTS_COOKIE
npm run dev               # 或 npm start
```

`DOUBAO_TTS_COOKIE` 从浏览器登录豆包后，DevTools → Network → 任意请求
复制完整 Cookie 头。打开 `http://localhost:8000/ui` 预览音色。

### Docker

```bash
docker build -t doubao-tts-ts .
docker run -d -p 8000:8000 \
  -e DOUBAO_TTS_API_KEY=sk-xxx \
  -e DOUBAO_TTS_COOKIE="浏览器复制的 Cookie 头" \
  -v $(pwd)/data:/data \
  doubao-tts-ts
```

cookie 落盘到挂载的 `/data`，保温续期会回写，重启不丢。

## 部署到 Vercel

```bash
vercel
```

需要在 Vercel 项目设置里配环境变量：
- `DOUBAO_TTS_API_KEY` — 鉴权密钥
- `STORAGE_BACKEND=redis`
- `KV_REST_API_URL` / `KV_REST_API_TOKEN` — Vercel KV（或 Upstash）
- `DOUBAO_TTS_COOKIE` — 首次播种 cookie（之后存 KV）
- `CRON_SECRET`（可选）— 保护定时续期端点

`vercel.json` 已配好：所有请求路由到 Hono app，Cron 每天 04:00 续期 cookie。

> ⚠️ Vercel serverless 有两个限制：函数执行时长上限（Hobby 10s / Pro 60s），
> 长文本合成可能超时；以及并发靠 Redis 分布式限流，比单机信号量粗。
> 高并发 / 长文本场景，Docker/VPS 部署更稳。

## 环境变量

见 [`.env.example`](.env.example)。关键项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DOUBAO_TTS_API_KEY` | 无 | Bearer 鉴权；未设则仅回环可达 |
| `DOUBAO_TTS_COOKIE` | 无 | 首次播种的 Cookie 头 |
| `STORAGE_BACKEND` | `file` | `file`（Docker）/ `redis`（Vercel） |
| `DOUBAO_TTS_RATE_MAX` | `8` | 限流窗口内最大请求数 |
| `DOUBAO_TTS_MAX_INPUT` | `4096` | 单次文本长度上限 |

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
