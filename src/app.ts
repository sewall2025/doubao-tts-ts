/**
 * Hono 应用：OpenAI 兼容 TTS 服务。
 * 一套路由，src/server.ts（Docker）与 api/index.ts（Vercel）共用。
 */
import { Hono } from "hono";
import { API_KEY, MAX_INPUT_CHARS, KEEPALIVE_ENABLED } from "./lib/config.ts";
import { loadCookie, cookieExpiryDays } from "./lib/cookie.ts";
import { checkRateLimit, RATE_MAX } from "./lib/ratelimit.ts";
import { synthesize, type AudioFormat } from "./lib/tts.ts";
import { UI_HTML } from "./lib/ui.ts";
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
} from "./lib/voices.ts";

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
  const reqRange = c.req.header("Range") ?? "";
  const reqUA = c.req.header("User-Agent") ?? "";
  const reqConn = c.req.header("Connection") ?? "";
  const reqAccept = c.req.header("Accept") ?? "";
  const reqAcceptEnc = c.req.header("Accept-Encoding") ?? "";
  console.log(
    `[REQ] voice=${speaker} format=${fmtRaw} speed=${body.speed ?? 1.0}(→${speed}) pitch=${pitch} chars=${input.length}\n` +
      `      Range="${reqRange}" Connection="${reqConn}" Accept="${reqAccept}" Accept-Encoding="${reqAcceptEnc}"\n` +
      `      User-Agent="${reqUA}"`,
  );

  // 缓冲返回：收完整段再带 Content-Length 一次性发出。
  // 音频段都很短，流式无收益；chunked 传输经反向代理易被缓冲/截断。
  // 未发出任何字节前，失败可重试（豆包瞬时并发会拒掉部分 session）且能返回正确状态码。
  const MAX_ATTEMPTS = 3;
  let audio: Buffer | null = null;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const parts: Buffer[] = [];
      for await (const chunk of synthesize(input, {
        speaker,
        format: doubaoFormat as AudioFormat,
        speechRate: speed,
        pitch,
        cookie,
      })) {
        if (chunk.audio) parts.push(chunk.audio);
      }
      audio = Buffer.concat(parts);
      lastErr = null;
      break; // 正常结束
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 200 * attempt)); // 退避后重试
      }
    }
  }

  if (lastErr || !audio || audio.length === 0) {
    const err = lastErr as (Error & { code?: string }) | null;
    if (err) {
      console.error(
        `[synthesize error] attempts=${MAX_ATTEMPTS} ` +
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
  // Connection: close — 每个请求独占 nginx↔node 连接，避免慢请求在复用
  // keep-alive 连接上阻住后续响应（HTTP/1.1 响应按请求顺序返回的队头阻塞）。
  // TTS 是一次性请求，不复用连接损失极小。
  c.header("Connection", "close");
  console.log(`[RESP] status=200 bytes=${audio.length} ctype=${MEDIA_TYPES[doubaoFormat]} range="${reqRange}"`);
  // Content-Length / 传输编码交给 node-server 处理（对齐参考项目 read-aloud，不手动干预）。
  // Buffer 是共享内存池视图，按 offset/length 切出精确 ArrayBuffer
  return c.body(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength) as ArrayBuffer);
});
