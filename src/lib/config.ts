/**
 * 运行时配置：从环境变量读取，两种部署共用。
 */
function envInt(name: string, def: number, min = 1): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return n < min ? min : n;
}

export const API_KEY = (process.env.DOUBAO_TTS_API_KEY ?? "").trim();
export const MAX_INPUT_CHARS = envInt("DOUBAO_TTS_MAX_INPUT", 4096);

// 保温阈值
export const KEEPALIVE_ENABLED =
  !["0", "false", "no", "off"].includes(
    (process.env.DOUBAO_TTS_KEEPALIVE ?? "1").trim().toLowerCase(),
  );
export const KEEPALIVE_INTERVAL_H = envInt("DOUBAO_TTS_KEEPALIVE_INTERVAL_H", 12);
export const KEEPALIVE_THRESHOLD_D = envInt("DOUBAO_TTS_KEEPALIVE_THRESHOLD_D", 25);

// demo 试听句子（约 20 字）
export const DEMO_TEXT = "你好呀，这是一段用来试听音色效果的示例语音。";
