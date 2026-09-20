/**
 * 静音降级自检（跑完即退，不起端口、不起长驻进程）。
 *
 * 断言两组行为：
 *  1) "……\n……"（豆包确定性 TTSInvalidText）→ 200 + X-Doubao-Fallback: silence + 极小 body。
 *  2) "你好"（正常对照组）→ 200 + 无降级头 + 正常音频。
 *
 * 运行：cd /Users/fanmac/AI/doubao-tts-ts && npx tsx --env-file-if-exists=.env scripts/check_silence_fallback.ts
 * 两个请求串行（严禁并发调豆包），中间 sleep 300ms。断言失败 → 非零退出码。
 */
import assert from "node:assert/strict";
import { app } from "../src/app.js";
import { API_KEY } from "../src/lib/config.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function speak(input: string): Promise<{ status: number; fallback: string | null; bytes: number; ms: number }> {
  const t0 = Date.now();
  const res = await app.fetch(
    new Request("http://localhost/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // key 只进请求头，绝不打印
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: "tts-1", input, voice: "taozi", response_format: "mp3" }),
    }),
  );
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    fallback: res.headers.get("X-Doubao-Fallback"),
    bytes: buf.length,
    ms: Date.now() - t0,
  };
}

async function main() {
  console.log(`API_KEY 已配置=${!!API_KEY}（内容不打印）`);

  // ---- 组 1：纯标点 → 静音降级 ----
  const a = await speak("……\n……");
  console.log(`[check1] 纯标点 status=${a.status} fallback=${a.fallback} bytes=${a.bytes} ms=${a.ms}`);
  assert.equal(a.status, 200, `纯标点应返回 200，实际 ${a.status}`);
  assert.equal(a.fallback, "silence", `纯标点应带 X-Doubao-Fallback: silence，实际 ${a.fallback}`);
  assert.ok(a.bytes > 0, `静音 body 应非空，实际 ${a.bytes}`);
  assert.ok(a.bytes < 5000, `静音 body 应很小(<5000)，实际 ${a.bytes}`);

  await sleep(300);

  // ---- 组 2：正常文本 → 真实音频、无降级头 ----
  const b = await speak("你好");
  console.log(`[check2] 正常文本 status=${b.status} fallback=${b.fallback} bytes=${b.bytes} ms=${b.ms}`);
  assert.equal(b.status, 200, `正常文本应返回 200，实际 ${b.status}`);
  assert.equal(b.fallback, null, `正常文本不应带降级头，实际 ${b.fallback}`);
  assert.ok(b.bytes > 5000, `正常音频应 >5000 字节，实际 ${b.bytes}`);

  console.log(`\n两组断言全部通过：降级耗时 ${a.ms}ms（单次尝试），正常合成 ${b.ms}ms`);
  console.log("CHECK OK");
}

main().then(
  () => {
    process.exitCode = 0;
  },
  (e) => {
    console.error("CHECK FAILED:", (e as Error)?.message || e);
    process.exitCode = 1;
  },
);
