/**
 * 存储抽象：cookie 持久化 + 限流计数。
 * 按环境切换后端：
 *   - file:  Docker/VPS 单机，cookie 落盘 + 限流用内存信号量
 *   - redis: Vercel/多实例，cookie 存 Redis + 分布式令牌桶
 * 由 STORAGE_BACKEND 环境变量选择（file|redis），默认 file。
 */
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";

export interface Storage {
  /** 读取键值（字符串）；不存在返回 null */
  get(key: string): Promise<string | null>;
  /** 写入键值 */
  set(key: string, value: string): Promise<void>;
  /**
   * 限流：在 windowSec 窗口内对 key 计数并 +1，返回自增后的当前值。
   * 调用方据此判断是否超过阈值。
   */
  incrWindow(key: string, windowSec: number): Promise<number>;
}

// ---------------- 文件后端（Docker/VPS）----------------
// cookie 存本地文件；限流用进程内计数（单机足够）。
class FileStorage implements Storage {
  private dir: string;
  private counters = new Map<string, { count: number; resetAt: number }>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private pathOf(key: string): string {
    // key 里的 : 转成 __，避免非法文件名
    return `${this.dir}/.store_${key.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
  }

  async get(key: string): Promise<string | null> {
    const p = this.pathOf(key);
    if (!existsSync(p)) return null;
    try {
      return (await readFile(p, "utf-8")).trim() || null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    const p = this.pathOf(key);
    // tmp 名必须唯一：固定用 `${p}.tmp` 时两个并发写者会共用同一个临时文件，
    // 先完成的 rename 把它消费掉，后者的 rename 撞 ENOENT → 落进下面的非原子直写兜底
    // （实测：两个 4420 字节并发 set，必然有一个走到直写）。cookie 是这条路径上唯一的写入者，
    // 一旦写坏就是整篇静音，所以宁可多给一个随机后缀。
    const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, value, "utf-8");
    try {
      // rename 同目录内是原子的：读者只会看到旧内容或新内容，不会看到半截。
      await rename(tmp, p);
    } catch {
      // 单文件 bind mount 的 rename 可能失败（目标是挂载点而非普通文件），退回直写。
      // 这条路径非原子，但此时已无更好选择；tmp 唯一化后它只在真正的 bind mount 场景触发，
      // 不再被并发误触。
      await writeFile(p, value, "utf-8");
    } finally {
      // 无论成功失败都清掉残留 tmp（rename 成功后 tmp 已不存在，unlink 失败无害）。
      await unlink(tmp).catch(() => {});
    }
  }

  async incrWindow(key: string, windowSec: number): Promise<number> {
    const now = Date.now();
    const c = this.counters.get(key);
    if (!c || now >= c.resetAt) {
      // 新窗口：先清掉旧桶。key 是 `rl:<秒级桶号>`，每秒换一个，而上面那个
      // 过期分支只在「同一个 key 再被查」时才走得到——旧桶永远不会被再查，所以
      // 永远不会被清除，单向堆积（实测：模拟每秒 1 请求跑 1 小时，size 到 3600）。
      // 按语义只需保留当前桶一条，直接 clear 比逐条扫过期更简单。
      this.counters.clear();
      this.counters.set(key, { count: 1, resetAt: now + windowSec * 1000 });
      return 1;
    }
    c.count += 1;
    return c.count;
  }
}

// ---------------- Redis 后端（Vercel/多实例）----------------
// 走 Upstash REST API（Vercel KV 底层即此），无需长连接，适合 serverless。
class RedisStorage implements Storage {
  private url: string;
  private token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
  }

  private async cmd(...args: (string | number)[]): Promise<unknown> {
    const res = await fetch(`${this.url}/${args.map(encodeURIComponent).join("/")}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`Redis ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { result?: unknown };
    return data.result;
  }

  async get(key: string): Promise<string | null> {
    const r = await this.cmd("GET", key);
    return typeof r === "string" ? r : null;
  }

  async set(key: string, value: string): Promise<void> {
    // 用 POST 传 body，避免超长 value 撑爆 URL
    const res = await fetch(`${this.url}/SET/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` },
      body: value,
    });
    if (!res.ok) throw new Error(`Redis SET ${res.status}: ${await res.text()}`);
  }

  async incrWindow(key: string, windowSec: number): Promise<number> {
    const n = (await this.cmd("INCR", key)) as number;
    if (n === 1) await this.cmd("EXPIRE", key, windowSec); // 首次设过期
    return n;
  }
}

let _storage: Storage | null = null;

/** 按后缀查环境变量：先精确匹配，再兑底任意前缀（Vercel 连 KV 会加 doubaotts_ 等前缀）。
 *  例：KV_REST_API_URL 或 doubaotts_KV_REST_API_URL 都能命中。优先非 READ_ONLY 的 token。*/
function envBySuffix(suffix: string): string {
  if (process.env[suffix]) return process.env[suffix] as string;
  // 兜底：任意前缀 + suffix，排除只读 token
  const keys = Object.keys(process.env).filter(
    (k) => k.endsWith(suffix) && !k.includes("READ_ONLY"),
  );
  for (const k of keys) {
    const v = (process.env[k] ?? "").trim();
    if (v) return v;
  }
  return "";
}

/** 单例获取存储后端。显式 STORAGE_BACKEND 优先；未设时自动检测：
 *  有 KV/Upstash 环境变量 → redis；否则 file。
 *  （Vercel 连上 Upstash 集成后自动注入 KV_REST_API_*，可带 doubaotts_ 等前缀，无需手动设 STORAGE_BACKEND。）*/
export function getStorage(): Storage {
  if (_storage) return _storage;
  const kvUrl = envBySuffix("KV_REST_API_URL") || envBySuffix("UPSTASH_REDIS_REST_URL");
  const kvToken = envBySuffix("KV_REST_API_TOKEN") || envBySuffix("UPSTASH_REDIS_REST_TOKEN");
  const explicit = (process.env.STORAGE_BACKEND ?? "").trim().toLowerCase();
  // 未显式指定时：有 KV 就用 redis，否则 file
  const backend = explicit || (kvUrl && kvToken ? "redis" : "file");
  if (backend === "redis") {
    if (!kvUrl || !kvToken) {
      throw new Error(
        "STORAGE_BACKEND=redis 需要 KV_REST_API_URL / KV_REST_API_TOKEN " +
          "(或 UPSTASH_REDIS_REST_URL / _TOKEN)",
      );
    }
    _storage = new RedisStorage(kvUrl, kvToken);
  } else {
    const dir = process.env.DOUBAO_TTS_DATA_DIR ?? process.cwd();
    _storage = new FileStorage(dir);
  }
  return _storage;
}
