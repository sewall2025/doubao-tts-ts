/**
 * 进程内并发信号量：限制同时连豆包的 WebSocket 数。
 * 对齐 Python 版 asyncio.Semaphore(DOUBAO_TTS_CONCURRENCY)。
 *
 * 无限制时，客户端预取会瞬间猛开一堆并发，同时对豆包狂开连接，
 * 偶发 TCP 连接超时（ETIMEDOUT）。限流让超出的请求排队而非全砸向豆包。
 *
 * ponytail: 单机内存信号量，够 Docker/VPS 单进程用。多实例（Vercel）
 * 走 redis 限流那套，不用这个。
 */

function envInt(name: string, def: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const MAX_CONCURRENCY = envInt("DOUBAO_TTS_CONCURRENCY", 8);

let active = 0;
const waiters: Array<() => void> = [];

/** 释放函数，另带本次取槽的诊断快照。 */
export interface Release {
  (): void;
  /** 取槽后的活跃数（1..MAX），仅用于诊断日志 */
  slotNo: number;
  /** 取槽后仍在排队的请求数 */
  queued: number;
}

/** 获取一个槽位；满了就排队等待。返回释放函数。 */
export async function acquire(): Promise<Release> {
  if (active < MAX_CONCURRENCY) {
    active += 1;
  } else {
    await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
  }
  const slotNo = active; // 取槽后的活跃数，仅用于诊断日志（不是稳定的槽位编号）
  let released = false;
  const release = () => {
    if (released) return; // 幂等，避免重复释放
    released = true;
    active -= 1;
    const next = waiters.shift();
    if (next) next();
  };
  // 挂在释放函数上带出诊断信息，避免改 acquire 的返回类型（调用方仍可当普通函数用）
  release.slotNo = slotNo;
  release.queued = waiters.length;
  return release as Release;
}

export { MAX_CONCURRENCY };
