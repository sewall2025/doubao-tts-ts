/**
 * 存储抽象：cookie 持久化 + 限流计数。
 * 按环境切换后端：
 *   - file:  Docker/VPS 单机，cookie 落盘 + 限流用内存信号量
 *   - redis: Vercel/多实例，cookie 存 Redis + 分布式令牌桶
 * 由 STORAGE_BACKEND 环境变量选择（file|redis），默认 file。
 */
import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";

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
    const tmp = `${p}.tmp`;
    await writeFile(tmp, value, "utf-8");
    try {
      await rename(tmp, p);
    } catch {
      // 单文件 bind mount 的 rename 可能失败，退回直写
      await writeFile(p, value, "utf-8");
      await unlink(tmp).catch(() => {});
    }
  }

  async incrWindow(key: string, windowSec: number): Promise<number> {
    const now = Date.now();
    const c = this.counters.get(key);
    if (!c || now >= c.resetAt) {
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

/** 单例获取存储后端，按环境变量选择 */
export function getStorage(): Storage {
  if (_storage) return _storage;
  const backend = (process.env.STORAGE_BACKEND ?? "file").toLowerCase();
  if (backend === "redis") {
    // 兼容 Vercel KV / Upstash 的环境变量命名
    const url =
      process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL ?? "";
    const token =
      process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN ?? "";
    if (!url || !token) {
      throw new Error(
        "STORAGE_BACKEND=redis 需要 KV_REST_API_URL / KV_REST_API_TOKEN " +
          "(或 UPSTASH_REDIS_REST_URL / _TOKEN)",
      );
    }
    _storage = new RedisStorage(url, token);
  } else {
    const dir = process.env.DOUBAO_TTS_DATA_DIR ?? process.cwd();
    _storage = new FileStorage(dir);
  }
  return _storage;
}
