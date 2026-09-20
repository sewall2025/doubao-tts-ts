/**
 * Hono 应用：OpenAI 兼容 TTS 服务。
 * 一套路由，src/server.ts（Docker）与 Vercel（原生 Hono 检测，直接 serve 本文件）共用。
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { handle } from "hono/vercel";
import { API_KEY, MAX_INPUT_CHARS, KEEPALIVE_ENABLED, KEEPALIVE_THRESHOLD_D } from "./lib/config.js";
import { loadCookie, cookieExpiryDays, renewCookie } from "./lib/cookie.js";
import { checkRateLimit, RATE_MAX } from "./lib/ratelimit.js";
import { synthesize, type AudioFormat } from "./lib/tts.js";
import { acquire, MAX_CONCURRENCY } from "./lib/semaphore.js";
import { silentAudio } from "./lib/silence.js";
import { UI_HTML } from "./lib/ui.js";
import {
  SPEAKERS,
  OPENAI_VOICES,
  FORMAT_MAP,
  UNSUPPORTED_FORMATS,
  MEDIA_TYPES,
  resolveSpeaker,
  voiceCatalog,
  clampSpeed,
  clampPitch,
} from "./lib/voices.js";

export const app = new Hono();

// ---------------- 鉴权 ----------------
function checkAuth(authHeader: string | undefined): boolean {
  if (!API_KEY) return true; // 未配置 key = 不鉴权（仅回环场景）
  const token = authHeader?.replace(/^Bearer\s+/i, "").trim() ?? "";
  return token.length > 0 && token === API_KEY;
}

function authError() {
  return {
    error: {
      message: "Incorrect API key provided.",
      type: "invalid_request_error",
      code: "invalid_api_key",
    },
  };
}

// ---------------- 免鉴权：UI ----------------
app.get("/ui", (c) => c.html(UI_HTML));

app.get("/ui/voices", (c) => {
  // 按女声/男声分组，只返回元数据（不触网、不消耗账号）
  const female: unknown[] = [];
  const male: unknown[] = [];
  const aliasOf = new Map(Object.entries(SPEAKERS).map(([a, s]) => [s, a]));
  for (const v of voiceCatalog()) {
    const tags = v.tags ?? [];
    if (tags.length === 0) continue;
    const entry = {
      speaker_id: v.speaker_id,
      name: v.name ?? "",
      tags,
      alias: aliasOf.get(v.speaker_id) ?? null,
    };
    if (tags[0] === "女") female.push(entry);
    else if (tags[0] === "男") male.push(entry);
  }
  return c.json({ female, male });
});

// ---------------- 健康检查 ----------------
app.get("/health", async (c) => {
  const cookie = await loadCookie();
  const days = await cookieExpiryDays(cookie);
  return c.json({
    status: "ok",
    cookie_loaded: !!cookie,
    cookie_expires_in_days: days !== null ? Math.round(days * 100) / 100 : null,
    keepalive_enabled: KEEPALIVE_ENABLED && !!cookie,
    auth_required: !!API_KEY,
    rate_max: RATE_MAX,
    voices_loaded: voiceCatalog().length,
  });
});

// ---------------- OpenAI: 模型列表 ----------------
app.get("/v1/models", (c) => {
  if (!checkAuth(c.req.header("Authorization"))) return c.json(authError(), 401);
  return c.json({
    object: "list",
    data: ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"].map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "doubao",
    })),
  });
});

// ---------------- 音色列表（鉴权）----------------
app.get("/v1/audio/voices", (c) => {
  if (!checkAuth(c.req.header("Authorization"))) return c.json(authError(), 401);
  const q = (c.req.query("q") ?? "").trim().toLowerCase();
  const tab = (c.req.query("tab") ?? "").trim().toLowerCase();
  const limit = parseInt(c.req.query("limit") ?? "0", 10) || 0;
  const aliasOf = new Map(Object.entries(SPEAKERS).map(([a, s]) => [s, a]));

  let items = voiceCatalog();
  if (q) {
    items = items.filter(
      (v) =>
        v.speaker_id.toLowerCase().includes(q) ||
        (v.name ?? "").toLowerCase().includes(q) ||
        (v.tags ?? []).some((t) => t.toLowerCase().includes(q)),
    );
  }
  if (tab) items = items.filter((v) => (v.tab ?? "").toLowerCase().includes(tab));
  const total = items.length;
  if (limit > 0) items = items.slice(0, limit);
  return c.json({
    object: "list",
    total,
    data: items.map((v) => ({
      id: v.speaker_id,
      speaker_id: v.speaker_id,
      name: v.name ?? "",
      alias: aliasOf.get(v.speaker_id) ?? null,
      tags: v.tags ?? [],
      tab: v.tab ?? "",
    })),
  });
});

// ---------------- 语音合成（鉴权 + 限流 + 流式）----------------
interface SpeechBody {
  model?: string;
  input?: string;
  voice?: string;
  response_format?: string;
  speed?: number;
  pitch?: number;
}

// 输入取证：把请求文本渲染成可排查形式——JSON 转义（\n 等可见）后截断 40 字符、前 12 个码位。
// 仅用于日志定位 TTSInvalidText 之类的异常输入，不参与任何判定。
function inputForensics(text: string): string {
  const escaped = JSON.stringify(text);
  const preview = escaped.length > 40 ? `${escaped.slice(0, 40)}…` : escaped;
  const cps: string[] = [];
  for (const ch of text) {
    if (cps.length >= 12) break; // for...of 按码位遍历，代理对不会被截半
    cps.push(`U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`);
  }
  return `text=${preview} cp=[${cps.join(" ")}]`;
}

app.post("/v1/audio/speech", async (c) => {
  if (!checkAuth(c.req.header("Authorization"))) return c.json(authError(), 401);

  let body: SpeechBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "invalid JSON body", type: "invalid_request_error" } }, 400);
  }

  const input = (body.input ?? "").trim();
  if (!input) {
    return c.json({ error: { message: "input is required", type: "invalid_request_error" } }, 400);
  }
  if (input.length > MAX_INPUT_CHARS) {
    return c.json(
      { error: { message: `input too long: ${input.length} chars (max ${MAX_INPUT_CHARS})`, type: "invalid_request_error" } },
      400,
    );
  }

  // 格式
  const fmtRaw = (body.response_format ?? "mp3").toLowerCase();
  if (UNSUPPORTED_FORMATS.has(fmtRaw)) {
    return c.json(
      { error: { message: `response_format '${fmtRaw}' is not supported by the Doubao backend. Use one of: mp3, opus, wav, pcm`, type: "invalid_request_error" } },
      400,
    );
  }
  const doubaoFormat = FORMAT_MAP[fmtRaw];
  if (!doubaoFormat) {
    return c.json(
      { error: { message: `unknown response_format '${fmtRaw}'. Use one of: mp3, opus, wav, pcm`, type: "invalid_request_error" } },
      400,
    );
  }

  // 音色白名单
  const voiceRaw = (body.voice ?? "taozi").trim();
  const speaker = resolveSpeaker(voiceRaw);
  if (!speaker) {
    const aliases = Object.keys(SPEAKERS).join(", ");
    const hint = OPENAI_VOICES.has(voiceRaw.toLowerCase())
      ? `voice '${voiceRaw}' is an OpenAI preset with no Doubao equivalent.`
      : `unknown voice '${voiceRaw}'.`;
    return c.json(
      { error: { message: `${hint} Query GET /v1/audio/voices for the ${voiceCatalog().length} available voices, or use an alias: ${aliases}.`, type: "invalid_request_error" } },
      422,
    );
  }

  // 限流
  const rl = await checkRateLimit();
  if (!rl.allowed) {
    return c.json(
      { error: { message: `rate limit exceeded (${rl.current}/${rl.max} per window), retry shortly`, type: "rate_limit_error" } },
      429,
    );
  }

  const cookie = await loadCookie();
  if (!cookie) {
    return c.json({ error: { message: "Doubao cookie not configured on server.", type: "server_error" } }, 503);
  }

  const speed = clampSpeed(body.speed ?? 1.0);
  const pitch = clampPitch(body.pitch ?? 0);
  const tReq = Date.now(); // 请求到达时间（用于计时排查卡顿）
  // rid: 诊断用短 ID。客户端超时重发时会出现两条 rid 不同但 text 相同的请求，
  // 靠它才能把「同一请求的 3 次 attempt」和「两个并行请求各自重试」区分开。
  const rid = randomUUID().slice(0, 4);
  console.log(
    `[REQ] rid=${rid} voice=${speaker} format=${fmtRaw} speed=${body.speed ?? 1.0}(→${speed}) pitch=${pitch} chars=${input.length}`,
  );

  // 合成策略（多方向实测得出）：
  // • 缓冲原子返回（对齐 read-aloud）：收齐完整音频再发，绝不发“半截流”。
  // • 并发信号量（对齐 Python）：限同时连豆包数，消除 ETIMEDOUT 连接风暴。
  //   （豆包协议一条连接只能合成一次，无法像微软那样多路复用，实测证实。）
  // • 超时下沉到 tts.ts（连接所有者）：首字节 6s + 块间 8s 两层，不卡整段总时长。
  //   此处只管重试策略，绝不用 Promise.race——详见下方循环里的注释。
  // • 失败一律静音降级：任何合成失败都返回静音 200，绝不返回 502——客户端顺序播放，
  //   任何一段 502 都会让它永久卡死（不跳过、不重试）；静音让它无声播过、继续推进。
  // • TTSInvalidText(40402002) 经实测是确定性拒绝（7 个纯标点候选 × 3 次串行 = 21/21 全复现），
  //   重试对它完全无效，只白等 3-8 秒 → 不重试，直接降级。
  // • 纯标点输入返回的是 SessionFailed(40402002)，不是零字节（当前 speaker 下实测）；
  //   真出现零字节又无异常时按瞬时失败退避重试。
  // ponytail: 静音降级是有意简化。天花板：这一段内容静默丢失，只能靠日志 [FALLBACK silence] 发现。
  //   升级路径：需要感知时由客户端读响应头 X-Doubao-Fallback: silence 自行提示或重试。

  const MAX_ATTEMPTS = 3;
  // 超时不在这里管：由 synthesize 内部的首字节(6s)/块间(8s)两层超时负责，它拥有 ws
  // 生命周期，能真正关掉连接。原来这里的 HARD_TIMEOUT_MS=18000 有两个错：
  // ① 它卡的是合成总时长，而总时长随文本长度线性增长（47 字≈ 12-16s 是正常值），必然误判长文本；
  // ② 它靠 Promise.race 实现，超时只丢弃迭代器而不关 ws → 每次超时泄露一条连接。
  const release = await acquire(); // 占一个并发槽（满则排队）
  const waitMs = Date.now() - tReq; // 排队等待信号量的耗时
  let audio: Buffer | null = null;
  let lastErr: unknown = null;
  let usedAttempt = 0; // 最终成功（或最后一次失败）用的是第几次尝试
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const tTry = Date.now(); // 本次尝试起点（catch 里要用，故放在 try 外）
      try {
        // 直接消费迭代器，结束/抛错都走到 synthesize 的 finally（ws 必关）。
        // 切勿再包 Promise.race 加总时长超时：race 只能「不等」，管不住被丢弃的迭代器，
        // finally 不执行 → ws 泄露继续占豆包配额，重试再叠一条，越重试越挤。
        const parts: Buffer[] = [];
        for await (const chunk of synthesize(input, {
          speaker,
          format: doubaoFormat as AudioFormat,
          speechRate: speed,
          pitch,
          cookie,
          onConnInfo: ({ devIdx, deviceId }) => {
            // slot=占槽后的活跃数/上限，q=仍在排队数 —— 判断并发是否真的并行
            // dev 每次重试都会变（_rrCounter 在 buildWsUrl 里自增），这里如实记录
            console.log(
              `[TRY] rid=${rid} attempt=${attempt}/${MAX_ATTEMPTS} slot=${release.slotNo}/${MAX_CONCURRENCY} ` +
                `q=${release.queued} dev=${devIdx} devId=${deviceId.slice(-6)} +${Date.now() - tReq}ms`,
            );
          },
        })) {
          if (chunk.audio && chunk.audio.length > 0) parts.push(chunk.audio);
        }
        if (parts.length === 0) {
          // 零音频且无异常：当瞬时失败，退避重试；用尽仍零字节则走静音降级
          audio = null;
          lastErr = new Error("零音频（无异常，视为瞬时失败）");
          console.error(
            `[attempt ${attempt}/${MAX_ATTEMPTS} failed] rid=${rid} took=${Date.now() - tTry}ms ` +
              `msg=${(lastErr as Error).message} ${inputForensics(input)}`,
          );
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 200 * attempt));
            continue;
          }
          break;
        }
        audio = Buffer.concat(parts);
        lastErr = null;
        usedAttempt = attempt;
        break; // 正常结束
      } catch (e) {
        lastErr = e;
        audio = null;
        const m = (e as Error)?.message || "";
        usedAttempt = attempt;
        console.error(
          `[attempt ${attempt}/${MAX_ATTEMPTS} failed] rid=${rid} took=${Date.now() - tTry}ms ` +
            `msg=${m || String(e)} ${inputForensics(input)}`,
        );
        // TTSInvalidText(40402002) 是豆包的确定性拒绝（实测 21/21 全复现）：不重试，直接降级。
        if (m.includes("TTSInvalidText")) break;
        // 其余失败（超时/截断/ETIMEDOUT/SessionFailed/TaskFailed）当瞬时错误：实测并发下豆包会拒掉
        // 部分 session，手动重试即成，所以退避后重试。
        if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  } finally {
    release();
  }

  // 统一降级出口：任何合成失败（异常 / 零字节 / 重试用尽）都返回静音 200，客户端无声播过。
  if (lastErr || !audio || audio.length === 0) {
    const err = lastErr as (Error & { code?: string }) | null;
    const silence = silentAudio(doubaoFormat as AudioFormat);
    console.error(
      `[FALLBACK silence] 该段内容已丢失 rid=${rid} status=200 bytes=${silence.length} ` +
        `wait=${waitMs}ms total=${Date.now() - tReq}ms ` +
        `name=${err?.name ?? "?"} code=${err?.code ?? ""} ` +
        `msg=${err?.message || String(lastErr ?? "") || "no audio"} ` +
        inputForensics(input),
    );
    c.header("Content-Type", MEDIA_TYPES[doubaoFormat]);
    c.header("X-Doubao-Speaker", speaker);
    c.header("X-Doubao-Fallback", "silence");
    return c.body(
      silence.buffer.slice(silence.byteOffset, silence.byteOffset + silence.byteLength) as ArrayBuffer,
    );
  }

  c.header("Content-Type", MEDIA_TYPES[doubaoFormat]);
  c.header("X-Doubao-Speaker", speaker);
  console.log(
    `[RESP] rid=${rid} status=200 bytes=${audio.length} attempt=${usedAttempt}/${MAX_ATTEMPTS} ` +
      `wait=${waitMs}ms total=${Date.now() - tReq}ms`,
  );
  // Content-Length 交给 node-server 自动设（对齐 read-aloud，不手动干预）。
  // Buffer 是共享内存池视图，按 offset/length 切出精确 ArrayBuffer。
  return c.body(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer);
});

// Vercel Cron 端点（serverless 无常驻进程，用 cron 替代 setInterval 定时续期）。
// vercel.json 的 crons 每天打这个路径；可选 CRON_SECRET 校验防外部误触发。
app.get("/api/cron/renew", async (c) => {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = c.req.header("Authorization") ?? "";
    if (auth !== `Bearer ${secret}`) return c.json({ error: "unauthorized" }, 401);
  }
  const days = await cookieExpiryDays();
  if (days !== null && days >= KEEPALIVE_THRESHOLD_D) {
    return c.json({ renewed: false, reason: `剩余 ${days.toFixed(1)} 天，无需续期` });
  }
  const r = await renewCookie();
  return c.json({ renewed: r.ok, msg: r.msg });
});

// Vercel Function 入口：导出命名 HTTP 方法（Web fetch 风格）。
// 不能用 default export——Vercel 把 default 当 Node 风格 (req,res)=>void 调用，会忽略返回的 Response。
// 名称 export const GET/POST 会被当 fetch handler（(req)=>Response）处理。
// 保留命名 export const app 供 server.ts（Docker）使用。
const vercelHandler = handle(app);
export const GET = vercelHandler;
export const POST = vercelHandler;
