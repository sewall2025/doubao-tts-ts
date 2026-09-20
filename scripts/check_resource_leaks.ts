/**
 * 资源泄漏自检（纯本地、不联网、跑完即退）。
 *
 * 守两个实测确认过的 P0：
 *
 * 1) storage.ts 的限流 counters Map 单向增长。
 *    key 是 `rl:<秒级桶号>`（ratelimit.ts:33-34），每秒换一个；而 incrWindow 的过期分支
 *    只在「同一个 key 再被查」时才走得到 —— 旧桶永远不会被再查，所以永远不会被清除。
 *    实测（修复前）：模拟每秒 1 请求跑 1 小时，Map 到 3600 条，30 天 259 万条。
 *    半小时压测看不出来（约 1800 条 ≈ 0.3MB），这也是它此前没被发现的原因。
 *
 * 2) protobuf.ts 的 decodeResponse 负数长度导致同步死循环。
 *    长度 varint 用 32 位 |=/<< 累加，畸形 5 字节 varint 能把 bit31 置 1 得到负数，
 *    i += ln 于是回退，外层 while 永不终止。同步死循环会卡死整个事件循环，
 *    连块间超时 timer 都没机会触发 —— 比单个请求失败严重得多。
 *
 * 运行：cd /Users/fanmac/AI/doubao-tts-ts && npx tsx scripts/check_resource_leaks.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeResponse } from "../src/lib/protobuf.js";

async function checkCountersBounded() {
  // 用临时目录，绝不碰真实 data/
  const dir = await mkdtemp(join(tmpdir(), "doubao-check-"));
  try {
    process.env.DOUBAO_TTS_DATA_DIR = dir;
    process.env.STORAGE_BACKEND = "file";
    const { getStorage } = await import("../src/lib/storage.js");
    const st = getStorage();

    // 模拟秒级滚动 key：每次都是新桶（真实流量下的必然情形）
    for (let bucket = 0; bucket < 500; bucket++) {
      await st.incrWindow(`rl:${bucket}`, 2);
    }
    // 读私有字段做断言：只关心容器有没有被清理。
    // SAFETY: STORAGE_BACKEND=file 已在上面设好，getStorage() 必定返回 FileStorage 实例，
    // 而 FileStorage 有 `private counters = new Map()`（storage.ts:27）。private 只是编译期
    // 可见性，运行期字段确实存在。这里刻意越过封装去读它——这个自检要守的就是「容器有没有被
    // 清理」这个内部不变量，公开 API 无法观测到它。字段若被改名，断言会因 undefined 报错而非
    // 静默通过（下一行 .size 会抛 TypeError），不会退化成空跑。
    const size = (st as unknown as { counters: Map<string, unknown> }).counters.size;
    console.log(`[check1] 连续 500 个不同窗口桶后 counters.size=${size}`);
    assert.ok(size <= 2, `counters 应只保留当前桶（<=2），实际 ${size} 条 → 无界增长`);

    // 同一个桶内重复计数必须仍然递增（别把限流本身改坏了）
    const a = await st.incrWindow("rl:same", 5);
    const b = await st.incrWindow("rl:same", 5);
    const c = await st.incrWindow("rl:same", 5);
    console.log(`[check1] 同窗口内计数递增: ${a} → ${b} → ${c}`);
    assert.deepEqual([a, b, c], [1, 2, 3], "同一窗口内必须正常累加，否则限流失效");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function checkMalformedFrames() {
  // 每个用例都必须「快速返回」而不是卡住。同步死循环会直接挂住进程，
  // 所以这里用耗时上限兜底：正常都是 0-1ms。
  const cases: Array<[string, number[]]> = [
    ["负长度 varint (bit31)", [0x3a, 0x80, 0x80, 0x80, 0x80, 0x08, 0x11]],
    ["负长度 varint (-1)", [0x3a, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x00]],
    ["长度超出 buffer", [0x3a, 0x7f, 0x01, 0x02]],
    ["截断的 tag", [0xff, 0xff]],
    ["全连续位", [0x80, 0x80, 0x80, 0x80, 0x80, 0x80]],
    ["空 buffer", []],
  ];
  for (const [name, bytes] of cases) {
    const t0 = Date.now();
    decodeResponse(Buffer.from(bytes)); // 不许抛，也不许卡
    const ms = Date.now() - t0;
    console.log(`[check2] ${name}: ${ms}ms`);
    assert.ok(ms < 1000, `${name} 耗时 ${ms}ms，疑似死循环`);
  }
  // 合法帧仍要能正常解出（别为了防御把功能改坏）
  const ok = decodeResponse(Buffer.from([0x3a, 0x02, 0x68, 0x69]));
  console.log(`[check2] 合法 payload 解码: ${JSON.stringify(ok)}`);
  assert.equal(ok.payload, "hi", "合法帧必须仍能正确解码");
}

async function main() {
  await checkCountersBounded();
  checkMalformedFrames();
  console.log("\n两类资源泄漏断言全部通过（限流 Map 有界 + 畸形帧不死循环）");
  console.log("CHECK OK");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("CHECK FAILED:", (e as Error)?.message || e);
    process.exit(1);
  },
);
