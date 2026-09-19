/**
 * Hono 应用：OpenAI 兼容 TTS 服务。
 * 一套路由，src/server.ts（Docker）与 api/index.ts（Vercel）共用。
 */
import { Hono } from "hono";
import { stream } from "hono/streaming";
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
  console.log(
    `[REQ] voice=${speaker} format=${fmtRaw} speed=${body.speed ?? 1.0}(→${speed}) pitch=${pitch} chars=${input.length}`,
  );

  // 流式返回：边合成边推
  c.header("Content-Type", MEDIA_TYPES[doubaoFormat]);
  c.header("X-Doubao-Speaker", speaker);
  return stream(c, async (s) => {
    // 首字节发出前失败可安全重试（豆包瞬时并发会拒掉部分 session）。
    // 一旦已写出音频就无法改状态/重发，只能中断。
    const MAX_ATTEMPTS = 3;
    let sent = false;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !sent; attempt++) {
      try {
        for await (const chunk of synthesize(input, {
          speaker,
          format: doubaoFormat as AudioFormat,
          speechRate: speed,
          pitch,
          cookie,
        })) {
          if (chunk.audio) {
            sent = true;
            await s.write(chunk.audio);
          }
        }
        lastErr = null;
        break; // 正常结束
      } catch (e) {
        lastErr = e;
        if (sent) break; // 已发首字节，无法重试
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, 200 * attempt)); // 退避后重试
        }
      }
    }
    if (lastErr) {
      const err = lastErr as Error & { code?: string };
      console.error(
        `[synthesize error] attempts=${MAX_ATTEMPTS} sent=${sent} ` +
          `name=${err?.name ?? "?"} code=${err?.code ?? ""} msg=${err?.message || String(lastErr) || "(empty)"}`,
      );
    }
  });
});
