/**
 * Hono 应用：OpenAI 兼容 TTS 服务。
 * 一套路由，src/server.ts（Docker）与 api/index.ts（Vercel）共用。
 */
import { Hono } from "hono";
import { API_KEY, MAX_INPUT_CHARS, KEEPALIVE_ENABLED } from "./lib/config.js";
import { loadCookie, cookieExpiryDays } from "./lib/cookie.js";
import { checkRateLimit, RATE_MAX } from "./lib/ratelimit.js";
import { synthesize, type AudioFormat } from "./lib/tts.js";
import { acquire } from "./lib/semaphore.js";
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
  console.log(
    `[REQ] voice=${speaker} format=${fmtRaw} speed=${body.speed ?? 1.0}(→${speed}) pitch=${pitch} chars=${input.length}`,
  );

  // 是否含可诵内容（CJK/假名/谚文/字母/数字）。无任何可读字符的纯标点/符号段才该静音。
  // 实测：豆包对纯标点返回 bytes=0；有字母/数字/文字的则正常出音。
  const hasSpeakable = /[\p{L}\p{N}]/u.test(input);

  // 合成策略（多方向实测得出）：
  // • 缓冲原子返回（对齐 read-aloud）：收齐完整音频再发，绝不发“半截流”。
  // • 并发信号量（对齐 Python）：限同时连豆包数，消除 ETIMEDOUT 连接风暴。
  //   （豆包协议一条连接只能合成一次，无法像微软那样多路复用，实测证实。）
  // • 静音兑底：仅当输入无可诵内容（纯标点/符号）且豆包返 0 字节/TTSInvalidText 时才用静音。
  //   有可诵内容却零字节/报错 = 瞬时失败，必须重试，最终失败返回错误（让客户端重试）。
  // • 失败策略：确定性错误不重试；瞬时失败（含有内容却零字节）重试最多 3 次。
  const MAX_ATTEMPTS = 3;
  const HARD_TIMEOUT_MS = 25000; // 整段合成硬超时，卡住快速失败不无限等
  const release = await acquire(); // 占一个并发槽（满则排队）
  let audio: Buffer | null = null;
  let lastErr: unknown = null;
  let punctuation = false; // 零内容/无效文本→走静音兑底
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const parts: Buffer[] = await Promise.race([
          (async () => {
            const acc: Buffer[] = [];
            for await (const chunk of synthesize(input, {
              speaker,
              format: doubaoFormat as AudioFormat,
              speechRate: speed,
              pitch,
              cookie,
            })) {
              if (chunk.audio && chunk.audio.length > 0) acc.push(chunk.audio);
            }
            return acc;
          })(),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error(`合成硬超时 ${HARD_TIMEOUT_MS}ms`)), HARD_TIMEOUT_MS),
          ),
        ]);
        if (parts.length === 0) {
          if (!hasSpeakable) {
            // 无可诵内容（纯标点）+ 零音频 → 静音兑底
            punctuation = true;
            audio = null;
            lastErr = null;
            break;
          }
          // 有可诵内容却零字节 = 瞬时失败，重试
          audio = null;
          lastErr = new Error("零音频（含可诵内容，视为瞬时失败）");
          if (attempt < MAX_ATTEMPTS) {
            await new Promise((r) => setTimeout(r, 200 * attempt));
            continue;
          }
          break; // 用尽重试仍零字节 → 返回错误
        }
        audio = Buffer.concat(parts);
        lastErr = null;
        break; // 正常结束
      } catch (e) {
        lastErr = e;
        audio = null;
        const m = (e as Error)?.message || "";
        // 无可诵内容的 TTSInvalidText（纯标点）→ 静音兑底，不重试
        if (m.includes("TTSInvalidText") && !hasSpeakable) {
          punctuation = true;
          lastErr = null;
          break;
        }
        // 其他确定性错误（SessionFailed/TaskFailed，非标点）重试无意义，立即失败
        // （注：含可诵内容的 TTSInvalidText 不在此拦截，归入下方瞬时重试）
        if (
          !m.includes("TTSInvalidText") &&
          (m.includes("SessionFailed") || m.includes("TaskFailed"))
        ) {
          break;
        }
        // 瞬时错误（超时/截断/ETIMEDOUT/含内容的 InvalidText）：退避后重试
        if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  } finally {
    release();
  }

  // 标点/零内容段：返回静音，客户端顺畅播过（不卡、不触发重试）
  if (punctuation) {
    audio = silentAudio(doubaoFormat as AudioFormat);
    console.log(`[RESP] status=200 bytes=${audio.length} (silence)`);
    c.header("Content-Type", MEDIA_TYPES[doubaoFormat]);
    c.header("X-Doubao-Speaker", speaker);
    return c.body(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer);
  }

  if (lastErr || !audio || audio.length === 0) {
    const err = lastErr as (Error & { code?: string }) | null;
    if (err) {
      console.error(
        `[synthesize error] ` +
          `name=${err?.name ?? "?"} code=${err?.code ?? ""} msg=${err?.message || String(lastErr) || "(empty)"}`,
      );
    }
    return c.json(
      { error: { message: `Doubao synthesis failed: ${err?.message || "no audio"}`, type: "upstream_error" } },
      502,
    );
  }

  c.header("Content-Type", MEDIA_TYPES[doubaoFormat]);
  c.header("X-Doubao-Speaker", speaker);
  console.log(`[RESP] status=200 bytes=${audio.length}`);
  // Content-Length 交给 node-server 自动设（对齐 read-aloud，不手动干预）。
  // Buffer 是共享内存池视图，按 offset/length 切出精确 ArrayBuffer。
  return c.body(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer);
});

// Vercel 原生 Hono 检测会把本文件当函数入口，需要 default export（函数/server）。
// Hono 实例本身可作 fetch handler；同时保留命名 export 供 server.ts / 打包入口使用。
export default app;
