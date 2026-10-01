/**
 * 输入校验 / 鉴权 / 信号量 / sid_guard 解析自检（纯本地、不联网、不起端口、跑完即退）。
 *
 * 守的都是实测确认过的问题：
 * 1) /v1/audio/speech 字段类型错（input=123、body=null/[] 等）→ .trim() 抛 TypeError → 500；应 400。
 *    超大请求体应被 bodyLimit 拦成 413。这里只发会被校验拦下的请求，不会走到合成/联网。
 * 2) 未设 key 且在 Vercel（VERCEL=1）时鉴权端点曾返回 200（Vercel 没有回环保护）；应 401。
 *    未设 key 的本地回环场景仍应 200。
 * 3) 信号量 CONCURRENCY=1 时，release 先 active-=1 再唤醒 waiter：唤醒到恢复之间新来的 acquire
 *    可插队，active 峰值到 2。修复后槽位直接移交，峰值 <= 1。
 * 4) sid_guard 非法百分号编码 → decodeURIComponent 抛 URIError；应返回 null。
 *
 * API_KEY 在 config.ts 导入时固化，所以每种 env 场景各起一个子进程（CHECK_VALIDATION_ROLE 区分角色）。
 *
 * 运行：npx tsx scripts/check_validation.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const API_KEY = "sk-test-apikey";

async function withKey(): Promise<void> {
  const { app } = await import("../src/app.js");
  const { MAX_INPUT_CHARS } = await import("../src/lib/config.js");
  const { cookieExpiryDays } = await import("../src/lib/cookie.js");
  const post = async (body: string, key = API_KEY) =>
    (
      await app.request("/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
      })
    ).status;
  const j = JSON.stringify;

  const cases: Array<[string, string, number, string?]> = [
    ["input=123", j({ input: 123 }), 400],
    ["body=null", "null", 400],
    ["body=[]", "[]", 400],
    ["voice=1", j({ input: "你好", voice: 1 }), 400],
    ["response_format=1", j({ input: "你好", response_format: 1 }), 400],
    ["input 全空白", j({ input: "  \n\t " }), 400],
    ["voice=alloy", j({ input: "你好", voice: "alloy" }), 422],
    ["错误 key", j({ input: "你好" }), 401, "sk-wrong"],
    ["超大请求体", j({ input: "a".repeat(MAX_INPUT_CHARS * 4 + 32 * 1024) }), 413],
  ];
  for (const [name, body, want, key] of cases) {
    const got = await post(body, key);
    console.log(`[with_key] ${name} → ${got}`);
    assert.equal(got, want, `${name} 应 ${want}，实际 ${got}`);
  }

  const days = await cookieExpiryDays("sid_guard=%E0%A4%A");
  console.log(`[with_key] 非法 sid_guard → ${days}`);
  assert.equal(days, null, "非法 sid_guard 应返回 null");
}

async function modelsStatus(): Promise<number> {
  const { app } = await import("../src/app.js");
  return (await app.request("/v1/models")).status;
}

async function semaphore(): Promise<void> {
  const { acquire, slotSnapshot } = await import("../src/lib/semaphore.js");
  let peak = 0;
  const sample = () => (peak = Math.max(peak, slotSnapshot().active));

  const releaseA = await acquire();
  sample();
  const pB = acquire(); // 满了，排队
  sample();
  await Promise.resolve();
  releaseA(); // 唤醒 B，但 B 的恢复还在微任务队列里
  const pC = acquire(); // 同步紧跟：修复前在这里插队拿到槽位
  sample();
  const releaseB = await pB;
  sample();
  releaseB();
  const releaseC = await pC;
  sample();
  releaseC();
  const end = slotSnapshot();
  console.log(`[semaphore] active 峰值=${peak} 结束 active=${end.active} queued=${end.queued}`);
  assert.ok(peak <= 1, `CONCURRENCY=1 时 active 峰值应 <= 1，实际 ${peak}`);
  assert.deepEqual(end, { active: 0, queued: 0 }, "全部 release 后应 active=0、queued=0");
}

async function child(role: string): Promise<void> {
  // 看门狗：信号量死锁或请求卡住时强制退出，别挂住父进程
  setTimeout(() => {
    console.error(`CHECK FAILED: [${role}] 超时`);
    process.exit(9);
  }, 10_000).unref();

  if (role === "with_key") return withKey();
  if (role === "semaphore") return semaphore();
  if (role === "vercel_no_key") {
    const s = await modelsStatus();
    console.log(`[vercel_no_key] GET /v1/models → ${s}`);
    assert.equal(s, 401, "未设 key 且 VERCEL=1 时应 401");
    return;
  }
  if (role === "local_no_key") {
    const s = await modelsStatus();
    console.log(`[local_no_key] GET /v1/models → ${s}`);
    assert.equal(s, 200, "未设 key 的本地回环场景应 200");
    return;
  }
  throw new Error(`unknown role ${role}`);
}

function run(role: string, extra: Record<string, string>): void {
  const dir = mkdtempSync(join(tmpdir(), "validation-check-"));
  try {
    // 只传最小环境，避免继承 KV_* / VERCEL / .env 里的真实配置
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      STORAGE_BACKEND: "file",
      DOUBAO_TTS_DATA_DIR: dir,
      CHECK_VALIDATION_ROLE: role,
      ...extra,
    };
    execFileSync(process.execPath, [...process.execArgv, process.argv[1]!], { env, stdio: "inherit" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const role = process.env.CHECK_VALIDATION_ROLE;
if (role) {
  child(role).catch((e) => {
    console.error("CHECK FAILED:", (e as Error).message);
    process.exit(1);
  });
} else {
  run("with_key", { DOUBAO_TTS_API_KEY: API_KEY });
  run("vercel_no_key", { VERCEL: "1" });
  run("local_no_key", {});
  run("semaphore", { DOUBAO_TTS_CONCURRENCY: "1" });
  console.log("CHECK OK");
}
