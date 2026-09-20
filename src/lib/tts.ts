/**
 * 豆包 TTS 客户端（VoiceGenie 协议，TypeScript）
 * 逆向自豆包网页端，与 Python 版 doubao_tts.py 等价。
 */
import { randomUUID, createHash } from "node:crypto";
import { WebSocket } from "ws";
import { encodeRequest, decodeResponse } from "./protobuf.js";

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

// 两层流健康度超时（默认值，可按 cfg 覆盖）。
// 首字节 6s：实测正常段 1.8-5.4s 内就出音频，握手也只给 6s，超了就是真卡住。
// 块间 8s：流一旦开始产出，块间间隔远小于此；8s 没新块说明连接已死。
export const FIRST_BYTE_TIMEOUT_MS = 6000;
export const CHUNK_TIMEOUT_MS = 8000;

export interface TTSConfig {
  speaker: string;
  format: AudioFormat;
  speechRate: number; // 倍率，1.0 正常
  pitch: number; // 半音，-12~12
  cookie: string;
  /** 首字节超时(ms)：多久没收到第一块音频就算故障。默认 FIRST_BYTE_TIMEOUT_MS */
  firstByteTimeoutMs?: number;
  /** 块间超时(ms)：流中途多久没新块就算断了。默认 CHUNK_TIMEOUT_MS */
  chunkTimeoutMs?: number;
  /** 诊断回调：本次连接选中的设备（池下标 + device_id）。建连前同步调用一次。 */
  onConnInfo?: (info: { devIdx: number; deviceId: string }) => void;
}

export interface TTSChunk {
  audio?: Buffer; // 音频数据块
  sentence?: string; // 句子文本（TTSSentenceEnd）
}

/** 生成设备 ID。stableId 同一 seed 总是同一结果（稳定）。*/
function stableId(seed: string): string {
  const s = seed || String(Math.floor(Math.random() * 2 ** 53));
  const h = createHash("sha256").update(s).digest("hex").slice(0, 15);
  return String(7_600_000_000_000_000_000n + BigInt("0x" + h) % 99_999_999_999_999_999n);
}

// 固定设备池轮询：预生成 N 个稳定 device_id（N = 并发数），请求轮流取用。
// • 避开每设备并发限制：同时并发请求分散到不同 device_id。
// • 风控友好：设备数固定且每次重启都是同一批（从 cookie 派生），豆包看到“一人 N 台稳定设备”。
// 置 DOUBAO_TTS_UNIQUE_DEVICE=0 回退到单设备（池大小=1）。
function envInt(name: string, def: number): number {
  const n = parseInt((process.env[name] ?? "").trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}
const SINGLE_DEVICE = ["0", "false", "no", "off"].includes(
  (process.env.DOUBAO_TTS_UNIQUE_DEVICE ?? "1").trim().toLowerCase(),
);
// 池大小：单设备模式=1；否则=并发数（与 DOUBAO_TTS_CONCURRENCY 一致，默认 8）
const DEVICE_POOL_SIZE = SINGLE_DEVICE ? 1 : envInt("DOUBAO_TTS_CONCURRENCY", 8);
let _rrCounter = 0; // 轮询游标

function buildWsUrl(cookie: string): { url: string; devIdx: number; deviceId: string } {
  // 轮询取第 idx 个设备（固定从 cookie:idx 派生，重启后仍是同一批）
  const idx = DEVICE_POOL_SIZE === 1 ? 0 : _rrCounter++ % DEVICE_POOL_SIZE;
  const seed = `${cookie}:dev${idx}`;
  const deviceId = stableId(seed);
  const webId = stableId(seed + "_web");
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
  return { url: `${WS_URL}?${qs}`, devIdx: idx, deviceId };
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
 *
 * 超时由本函数自己管（连接的所有权在这里），调用方绝不要在外面包 Promise.race：
 * race 超时只会「丢弃」迭代器，finally 永不执行 → ws 不关，泄露的连接继续占豆包配额，
 * 重试再叠一条，越重试挤得越狠（实测：ECONNRESET / TLS disconnected / handshake timed out 连环）。
 *
 * 两层超时替代原来的「整段硬超时」：后者计量的是合成总时长，而总时长随文本长度
 * 线性增长（实测 3-4 字符/秒），用固定阈值卡它必然误判长文本。健康度该看流是不是卡着：
 *   • 首字节超时：豆包迟迟不出第一块 = 真故障，快速失败交给上层重试。
 *   • 块间超时：流中途断了才是故障；一直在出音频就是正常工作，不设总时长上限。
 * ponytail: 不设总时长上限的天花板——超长输入（近 MAX_INPUT=4096 字）合成可能超过 Vercel
 *   maxDuration=60s 被平台杀掉。升级路径：限 MAX_INPUT 或由调用方分段，而不是再加超时。
 */
export async function* synthesize(
  text: string,
  cfg: TTSConfig,
): AsyncGenerator<TTSChunk, void, unknown> {
  // family: 4 强制 IPv4——避开 Node happy-eyeballs 双栈连接：容器/服务器 IPv6 到豆包
  // 不通时会先试 IPv6 卡到超时再回退 IPv4，每次白耗几秒（ETIMEDOUT/AggregateError）→周期性卡顿。
  // handshakeTimeout: 握手超 6s 直接失败，不空等 OS 默认 TCP 超时。
  const conn = buildWsUrl(cfg.cookie);
  // 诊断用：把本次连接实际用的设备回传给调用方（app.ts 打 [TRY] 日志）。
  // 注意 _rrCounter 在 buildWsUrl 里自增，所以重试会换设备——这是当前行为，日志要能看出来。
  cfg.onConnInfo?.({ devIdx: conn.devIdx, deviceId: conn.deviceId });
  const ws = new WebSocket(conn.url, {
    headers: HEADERS(cfg.cookie),
    handshakeTimeout: 6000,
    family: 4,
  });

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
  // 握手被拒（豆包并发/限流会返回非 101 响应），ws 不会当 error 抛，手动捕获状态码
  ws.on("unexpected-response", (_req, res) => {
    error = new Error(`WS 握手被拒: HTTP ${res.statusCode} ${res.statusMessage ?? ""}`.trim());
    resolveMsg?.();
    resolveMsg = null;
  });
  ws.on("close", (code: number, reason: Buffer) => {
    // 非正常关闭且未收到终态事件时，把关闭码当错误暴露
    if (!error && code !== 1000 && code !== 1005) {
      error = new Error(`WS 异常关闭: code=${code} reason=${reason?.toString() || ""}`.trim());
    }
    closed = true;
    resolveMsg?.();
    resolveMsg = null;
  });

  const waitOpen = () =>
    new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (e: Error) => reject(e));
      ws.once("unexpected-response", (_req, res) =>
        reject(new Error(`WS 握手被拒: HTTP ${res.statusCode} ${res.statusMessage ?? ""}`.trim())),
      );
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
    // 两层超时阈值（cfg 可覆盖）。握手阶段的控制事件也算「出首字节前」，共用 firstByteMs：
    // 原来写死 20000ms，卡在握手上就要白等 20 秒，远超客户端耐心。
    const firstByteMs = cfg.firstByteTimeoutMs ?? FIRST_BYTE_TIMEOUT_MS;
    const chunkMs = cfg.chunkTimeoutMs ?? CHUNK_TIMEOUT_MS;
    await waitOpen();

    // 1) StartTask
    send("StartTask");
    let r = decodeResponse((await recv(firstByteMs)) ?? Buffer.alloc(0));
    if (r.event !== "TaskStarted") {
      throw new Error(`StartTask 失败: ${r.status_code} ${r.status_text}`);
    }
    const taskId = r.task_id ?? "";

    // 2) StartSession
    send("StartSession", sessionPayload(cfg), taskId);
    r = decodeResponse((await recv(firstByteMs)) ?? Buffer.alloc(0));
    if (r.event !== "SessionStarted") {
      throw new Error(`StartSession 失败: ${r.status_code} ${r.status_text}`);
    }

    // 3) 发文本 + 收尾
    send("BidirectionalTTS", JSON.stringify({ text }), taskId);
    send("EndTTS", "", taskId);

    // 4) 接收事件流直到 TTSEnded。cleanEnd 标记是否正常收尾——
    //    超时/异常关闭时未收到 TTSEnded 视为截断，抛错让上层重试，绝不静默返回半截。
    //    超时分两层：出第一块音频前用首字节阈值，之后改用（更宽的）块间阈值。
    let cleanEnd = false;
    let gotAudio = false;
    while (true) {
      let raw: Buffer | null;
      try {
        raw = await recv(gotAudio ? chunkMs : firstByteMs);
      } catch {
        throw new Error(
          gotAudio
            ? `块间超时 ${chunkMs}ms（流中断，视为截断）`
            : `首字节超时 ${firstByteMs}ms（豆包未出音频）`,
        );
      }
      if (raw === null) throw new Error("WS 在收尾前关闭（视为截断）");
      const msg = decodeResponse(raw);

      if (msg.data && msg.data.length > 0) {
        gotAudio = true; // 首块到手：后续改用块间超时，不再卡总时长
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
        cleanEnd = true;
        break;
      } else if (msg.event === "SessionFailed" || msg.event === "TaskFailed") {
        throw new Error(`${msg.event}: ${msg.status_code} ${msg.status_text}`);
      }
    }
    if (!cleanEnd) throw new Error("流未正常收尾");
  } finally {
    // 必须真死掉：这个 finally 也走「调用方提前 break / 抛弃迭代器」的路径（异步生成器的
    // .return() 会触发它）。ws.close() 只发关闭帧等对端回应，网络卡死时可能永不完成，
    // 连接就挂着占豆包配额——所以给 1s 宽限期，过后 terminate() 硬断。
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      const killer = setTimeout(() => ws.terminate(), 1000);
      killer.unref?.(); // 不阻止进程退出
      ws.once("close", () => clearTimeout(killer));
      ws.close();
    } else {
      ws.terminate();
    }
  }
}
