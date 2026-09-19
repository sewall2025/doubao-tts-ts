/**
 * 豆包 TTS 客户端（VoiceGenie 协议，TypeScript）
 * 逆向自豆包网页端，与 Python 版 doubao_tts.py 等价。
 */
import { randomUUID, createHash } from "node:crypto";
import { WebSocket } from "ws";
import { encodeRequest, decodeResponse } from "./protobuf.ts";

// ---------------- 协议常量 ----------------
export const APPKEY = "GOqQpfo1fO7slHv8";
export const NAMESPACE = "VoiceGenie";
export const WS_URL =
  "wss://frontier-audio-web-ws.doubao.com/api/v2/sami/voicegenie";

const REQUEST_TYPE_TEXT_TTS = 5;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

export type AudioFormat = "mp3" | "ogg_opus" | "wav" | "pcm";

export interface TTSConfig {
  speaker: string;
  format: AudioFormat;
  speechRate: number; // 倍率，1.0 正常
  pitch: number; // 半音，-12~12
  cookie: string;
}

export interface TTSChunk {
  audio?: Buffer; // 音频数据块
  sentence?: string; // 句子文本（TTSSentenceEnd）
}

/** 生成稳定设备 ID：同一 cookie 始终同一设备，避免被风控识别为大量新设备 */
function stableId(seed: string): string {
  const s = seed || String(Math.floor(Math.random() * 2 ** 53));
  const h = createHash("sha256").update(s).digest("hex").slice(0, 15);
  return String(7_600_000_000_000_000_000n + BigInt("0x" + h) % 99_999_999_999_999_999n);
}

function buildWsUrl(cookie: string): string {
  const deviceId = stableId(cookie);
  const webId = stableId(cookie + "_web");
  const params: Record<string, string> = {
    api_app_key: APPKEY,
    namespace: NAMESPACE,
    version_code: "20800",
    language: "zh",
    device_platform: "web",
    pkg_type: "release_version",
    pc_version: "3.37.5",
    region: "CN",
    sys_region: "CN",
    samantha_web: "1",
    "use-olympus-account": "1",
    doubao_device_platform: "web",
    aid: "497858",
    real_aid: "497858",
    device_id: deviceId,
    doubao_pc_version: "3.37.5",
    web_id: webId,
    tea_uuid: webId,
    web_platform: "browser",
    web_tab_id: randomUUID(),
  };
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return `${WS_URL}?${qs}`;
}

function sessionPayload(cfg: TTSConfig): string {
  const audioCfg: Record<string, unknown> = { format: cfg.format };
  if (cfg.format === "ogg_opus" || cfg.format === "mp3") audioCfg.bit_rate = 32000;
  if (cfg.format === "ogg_opus") audioCfg.sample_rate = 24000;

  const postProcess = { pitch: cfg.pitch, speech_rate: cfg.speechRate };
  const cacheConfig = { text_type: 1, use_cache: true };

  return JSON.stringify({
    business: 1,
    conversation_id: "",
    request_type: REQUEST_TYPE_TEXT_TTS,
    enable_text_reading: true,
    interrupt_type: 0,
    query_mode: 2,
    chat: {
      bot_id: "",
      conversation_id: "",
      question_id: "0",
      message_id: "",
      new_conversation: true,
      extra: {},
    },
    tts: {
      speaker: cfg.speaker,
      audio_config: audioCfg,
      extra: {
        cache_config: cacheConfig,
        network_level: 7,
        post_process: postProcess,
        music_ext_for_tts: "",
      },
    },
    extra: {
      disable_markdown_filter: true,
      extra: JSON.stringify({
        post_process: postProcess,
        cache_config: cacheConfig,
        music_ext_for_tts: "",
        network_level: 7,
      }),
    },
  });
}

const HEADERS = (cookie: string): Record<string, string> => ({
  "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  Origin: "https://www.doubao.com",
  "User-Agent": UA,
  Cookie: cookie,
});

/**
 * 合成语音，返回异步迭代器（边合成边产出音频块）。
 * 事件流: StartTask→TaskStarted, StartSession→SessionStarted,
 *         BidirectionalTTS+EndTTS, 然后 TTSResponse(音频)... TTSEnded。
 */
export async function* synthesize(
  text: string,
  cfg: TTSConfig,
): AsyncGenerator<TTSChunk, void, unknown> {
  const ws = new WebSocket(buildWsUrl(cfg.cookie), { headers: HEADERS(cfg.cookie) });

  // 收到的消息队列 + 等待器（把事件驱动转成 async 拉取）
  const queue: Buffer[] = [];
  let resolveMsg: (() => void) | null = null;
  let closed = false;
  let error: Error | null = null;

  ws.on("message", (data: Buffer) => {
    queue.push(data);
    resolveMsg?.();
    resolveMsg = null;
  });
  ws.on("error", (e: Error) => {
    error = e;
    resolveMsg?.();
    resolveMsg = null;
  });
  ws.on("close", () => {
    closed = true;
    resolveMsg?.();
    resolveMsg = null;
  });

  const waitOpen = () =>
    new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (e: Error) => reject(e));
    });

  async function recv(timeoutMs: number): Promise<Buffer | null> {
    while (queue.length === 0) {
      if (error) throw error;
      if (closed) return null;
      await new Promise<void>((resolve, reject) => {
        resolveMsg = resolve;
        const t = setTimeout(() => {
          resolveMsg = null;
          reject(new Error("recv timeout"));
        }, timeoutMs);
        // 收到消息时清掉超时
        const orig = resolveMsg;
        resolveMsg = () => {
          clearTimeout(t);
          orig();
        };
      });
    }
    return queue.shift()!;
  }

  const send = (event: string, payload = "", taskId = "") =>
    ws.send(
      encodeRequest({ appkey: APPKEY, namespace: NAMESPACE, event, payload, task_id: taskId }),
    );

  try {
    await waitOpen();

    // 1) StartTask
    send("StartTask");
    let r = decodeResponse((await recv(20000)) ?? Buffer.alloc(0));
    if (r.event !== "TaskStarted") {
      throw new Error(`StartTask 失败: ${r.status_code} ${r.status_text}`);
    }
    const taskId = r.task_id ?? "";

    // 2) StartSession
    send("StartSession", sessionPayload(cfg), taskId);
    r = decodeResponse((await recv(20000)) ?? Buffer.alloc(0));
    if (r.event !== "SessionStarted") {
      throw new Error(`StartSession 失败: ${r.status_code} ${r.status_text}`);
    }

    // 3) 发文本 + 收尾
    send("BidirectionalTTS", JSON.stringify({ text }), taskId);
    send("EndTTS", "", taskId);

    // 4) 接收事件流直到 TTSEnded
    while (true) {
      let raw: Buffer | null;
      try {
        raw = await recv(30000);
      } catch {
        break; // 超时视为结束
      }
      if (raw === null) break;
      const msg = decodeResponse(raw);

      if (msg.data && msg.data.length > 0) {
        yield { audio: msg.data };
      }
      if (msg.event === "TTSSentenceEnd") {
        try {
          const sentence = JSON.parse(msg.payload ?? "{}").text as string;
          if (sentence) yield { sentence };
        } catch {
          // 忽略解析失败
        }
      } else if (msg.event === "TTSEnded" || msg.event === "SessionFinished") {
        break;
      } else if (msg.event === "SessionFailed" || msg.event === "TaskFailed") {
        throw new Error(`${msg.event}: ${msg.status_code} ${msg.status_text}`);
      }
    }
  } finally {
    ws.close();
  }
}
