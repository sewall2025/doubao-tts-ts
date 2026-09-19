/**
 * 并发限流：防止打爆豆包配额触发 710022002 block。
 *
 * 用固定窗口计数（storage.incrWindow）。file 后端是进程内计数（单机够用），
 * redis 后端是跨实例共享（Vercel 多函数实例必需）。
 *
 * 窗口 + 上限由环境变量配置：
 *   DOUBAO_TTS_RATE_MAX     窗口内最大请求数（默认 8）
 *   DOUBAO_TTS_RATE_WINDOW  窗口秒数（默认 1）
 * 语义：近似「每窗口 N 个」，比信号量粗但对 serverless 友好。
 */
import { getStorage } from "./storage.ts";

function envInt(name: string, def: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const RATE_MAX = envInt("DOUBAO_TTS_RATE_MAX", 8);
const RATE_WINDOW = envInt("DOUBAO_TTS_RATE_WINDOW", 1);

export interface RateResult {
  allowed: boolean;
  current: number;
  max: number;
}

/** 检查是否放行。超过窗口上限则拒绝。 */
export async function checkRateLimit(): Promise<RateResult> {
  // 按窗口分桶，key 随时间滚动
  const bucket = Math.floor(Date.now() / 1000 / RATE_WINDOW);
  const key = `rl:${bucket}`;
  let current: number;
  try {
    current = await getStorage().incrWindow(key, RATE_WINDOW + 1);
  } catch {
    // 限流后端故障时放行（可用性优先于限流），但不计数
    return { allowed: true, current: 0, max: RATE_MAX };
  }
  return { allowed: current <= RATE_MAX, current, max: RATE_MAX };
}

export { RATE_MAX, RATE_WINDOW };
