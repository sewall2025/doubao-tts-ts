/**
 * /api/cron/renew 鉴权 + 失败可见性自检（跑完即退，不起端口、不触网）。
 *
 * 用临时空 DATA_DIR（file 后端）→ cookie 不存在 → renewCookie 直接返回「未找到 cookie」，
 * 不会调豆包心跳端点；借此断言续期失败返回 5xx。
 * API_KEY 在 config.ts 导入时固化，所以两种场景各起一个子进程（子进程只跑 app.request）。
 *
 * 运行：npx tsx scripts/check_cron_auth.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const API_KEY = "sk-test-apikey";
const CRON_SECRET = "test-cron-secret";

async function child(): Promise<void> {
  const { app } = await import("../src/app.js");
  const get = async (auth?: string) =>
    (await app.request("/api/cron/renew", { headers: auth ? { Authorization: auth } : {} })).status;

  if (process.env.CRON_SECRET) {
    assert.equal(await get(), 401, "无 header 应 401");
    assert.equal(await get("Bearer wrong"), 401, "错误 Bearer 应 401");
    assert.equal(await get(`Bearer ${API_KEY}`), 401, "设了 CRON_SECRET 时 API_KEY 不应放行");
    const ok = await get(`Bearer ${CRON_SECRET}`);
    assert.notEqual(ok, 401, "正确 CRON_SECRET 不应 401");
    assert.ok(ok >= 500, `续期失败应 5xx，实际 ${ok}`);
    console.log(`[cron_secret] 无header=401 错误=401 API_KEY=401 正确=${ok}`);
  } else {
    assert.equal(await get(), 401, "无 header 应 401");
    assert.equal(await get("Bearer wrong"), 401, "错误 Bearer 应 401");
    const ok = await get(`Bearer ${API_KEY}`);
    assert.notEqual(ok, 401, "正确 API_KEY 不应 401");
    assert.ok(ok >= 500, `续期失败应 5xx，实际 ${ok}`);
    console.log(`[api_key] 无header=401 错误=401 正确=${ok}`);
  }
}

function run(extra: Record<string, string>): void {
  const dir = mkdtempSync(join(tmpdir(), "cron-check-"));
  try {
    // 只传最小环境，避免继承 KV_* / .env 里的真实配置
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      STORAGE_BACKEND: "file",
      DOUBAO_TTS_DATA_DIR: dir,
      DOUBAO_TTS_API_KEY: API_KEY,
      CRON_CHECK_CHILD: "1",
      ...extra,
    };
    execFileSync(process.execPath, [...process.execArgv, process.argv[1]!], { env, stdio: "inherit" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.env.CRON_CHECK_CHILD) {
  child().catch((e) => {
    console.error("CHECK FAILED:", (e as Error).message);
    process.exitCode = 1;
  });
} else {
  run({ CRON_SECRET });
  run({});
  console.log("CHECK OK");
}
