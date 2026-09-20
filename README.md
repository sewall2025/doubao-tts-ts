# 豆包 TTS · TypeScript 版

逆向豆包网页端 VoiceGenie 语音合成的 Node/TS 客户端 + OpenAI 兼容服务。
**一套代码，两处部署**：Docker/VPS（长驻进程）或 Vercel（serverless）。

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new) · 先 Fork 本仓库，再在 Vercel 导入你的 Fork（见[部署到 Vercel](#部署到-vercel)）

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
cp .env.docker.example .env      # 填 DOUBAO_TTS_API_KEY
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

### 完整步骤

**1. Fork 本仓库并导入 Vercel**

先点 GitHub 右上角 **Fork** 把本仓库复制到你自己账号。
然后打开 [vercel.com/new](https://vercel.com/new) → **Import Git Repository** → 选你刚 Fork 的 `doubao-tts-ts` → Import。
构建配置保持默认即可（Vercel 自动识别 Hono，直接编译运行 `src/app.ts`）。

> 导入时 Vercel 只会从 `.env.example` 列出 `DOUBAO_TTS_API_KEY` 一个字段（Docker 专用变量已拆到 `.env.docker.example`）。
> 填上鉴权密钥先 Deploy，KV 连接和 cookie 写入见下面步骤。

**2. 连上 KV（Redis）——存 cookie 与限流计数**

Vercel 面板 → 项目 → **Storage** 选项卡 → **Create Database** → 选 **Upstash for Redis** → Connect 到本项目。
连好后 Vercel 会自动注入 `KV_REST_API_URL` / `KV_REST_API_TOKEN` 两个环境变量，**你不用手填**。
代码检测到这两个变量就自动切到 redis 后端，`STORAGE_BACKEND` 也不用设。

**3. 设鉴权密钥**

面板 → **Settings → Environment Variables** 加 `DOUBAO_TTS_API_KEY`（一串自定义密码，客户端用它鉴权）。
改了环境变量后重新 Deploy 一次生效。（`CRON_SECRET` 见下面步骤 5）

**4. 写入 cookie（关键，一锁一次）**

cookie 是敏感登录态，不能预填进按钮/环境变量，需部署后手动写进 KV。
在 Upstash 控制台的 **Data Browser**（或 CLI）执行：

```
SET cookie "浏览器 DevTools 复制的完整 Cookie 头"
```

完成后访问 `https://你的域名/health`，能看到 cookie 剩余天数就通了。

**5. 确认 cookie 保温（Cron 定时续期）**

cookie 约 30 天过期。Docker 用常驻定时器，Vercel 没有常驻进程，改用 **Cron Job** 定时打续期端点。

仓库的 [`vercel.json`](vercel.json) 已经声明好了，**部署后自动生效，你不用在面板里手建**：

```json
"crons": [{ "path": "/api/cron/renew", "schedule": "0 4 * * *" }]
```

每天 UTC 4:00（北京时间 12:00）打一次；剩余天数低于 `DOUBAO_TTS_KEEPALIVE_THRESHOLD_D`（默认 25）才真去续，否则空跑。

**验证已生效**：面板 → 项目 → **Settings → Cron Jobs**，应能看到 `/api/cron/renew` 和下次执行时间。
也可手动试一下（未设 `CRON_SECRET` 时直接访问）：

```bash
curl https://你的域名/api/cron/renew
# {"renewed":false,"reason":"剩余 28.8 天，无需续期"}  ← 这样就是通的
```

**设 `CRON_SECRET`（推荐）**

不设的话 `/api/cron/renew` 是公开的，任何人能反复触发续期。设法：

1. **生成一个随机字符串**（任意长度都行，建议 32 位以上）：

   ```bash
   openssl rand -hex 32
   # 或 node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

2. **填进 Vercel**：面板 → 项目 → **Settings → Environment Variables** → Add New
   - Key：`CRON_SECRET`
   - Value：刚生成的字符串
   - Environments：勾上 **Production**（其他环境可选）

3. **重新 Deploy 一次**（环境变量改动需重新部署才生效）。

设完就行了，**客户端和 Cron 都不用再配**：Vercel Cron 调自己的函数时会自动带上 `Authorization: Bearer <CRON_SECRET>`。

**验证**：再试上面那条 curl，应该返 `{"error":"unauthorized"}`（401）——**这说明保护生效了**。想手动触发得自己带头：

```bash
curl -H "Authorization: Bearer 你的CRON_SECRET" https://你的域名/api/cron/renew
```

> ⚠️ Vercel **Hobby 套餐的 Cron 每天只能跑 1 次且执行时间不保证精准**（可能漂几小时），对保温这种“剩 25 天才续”的场景完全够用。
> 若 cookie 已经过期，Cron 救不回来，需重新执行步骤 4 写入新 cookie。

> 音色表 `voices.json` 与源码一同被 Vercel 编译打包（只读），无需配置；与 Docker 共用同一份。
> Vercel 原生支持 Hono：自动编译 `src/`（import 用 `.js` 扩展名指向 `.ts`，符合 TS ESM 约定），
> `src/app.ts` 用 `handle(app)`（hono/vercel）导出 Function 入口，无需额外构建步骤。

> ⚠️ Vercel serverless 有两个限制：函数执行时长上限（Hobby 10s / Pro 60s），
> 长文本合成可能超时；以及并发靠 Redis 分布式限流，比单机信号量粗。
> 高并发 / 长文本场景，Docker/VPS 部署更稳。

## 环境变量

配置示例：Vercel 用 [`.env.example`](.env.example)，Docker/VPS 用 [`.env.docker.example`](.env.docker.example)。完整关键项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DOUBAO_TTS_API_KEY` | 无 | Bearer 鉴权；未设则仅回环可达 |
| `STORAGE_BACKEND` | 自动 | 缺省自动检测：有 KV 变量→`redis`，否则`file`；可显式覆盖 |
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
