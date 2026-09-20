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
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeResponse } from "../src/lib/protobuf.js";

async function checkCountersBounded(_dir: string) {
  {
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

/**
 * cookie 并发写必须走原子的 rename 路径，不许退化成非原子直写。
 *
 * tmp 名若固定（`${p}.tmp`），两个并发写者共用同一个临时文件：先完成的 rename 把它消费掉，
 * 后者的 rename 撞 ENOENT，落进「直写兜底」——那条路径是 truncate + write，非原子。
 * cookie 写坏的后果是整篇静音且客户端无感知，所以不能容忍它被并发误触。
 *
 * 断言的是「有没有走进兜底分支」，不是「最终内容是否完整」：
 * 两个等长写者并发时，最终内容仍然等于其中一个写者的完整内容（实测 40 轮未能复现
 * 半截或混写），所以「内容完整」这个断言对本 bug 完全不敏感——修复前后都通过。
 * 真正可观测的差异是走了哪条分支，于是这里用 unlink 的 ENOENT 作为探针：
 * rename 成功时 tmp 已被移走，unlink 必然 ENOENT；退化到直写时 tmp 仍在，unlink 成功。
 *
 * dir 由调用方传入、与 check1 共用：getStorage() 是模块级单例（storage.ts 的 _storage），
 * 绑定第一次调用时的 DOUBAO_TTS_DATA_DIR，另建目录对它无效。
 */
async function checkConcurrentCookieWrite(dir: string) {
  const { getStorage } = await import("../src/lib/storage.js");
  const st = getStorage();

  const A = "A".repeat(4420); // 贴近真实 cookie 体积
  const B = "B".repeat(4420);

  // 并发写同一个 key，然后数留下的 tmp 文件：唯一化后两个写者各有自己的 tmp，
  // 都能走 rename；共用固定名时必有一个撞 ENOENT 退化。
  await Promise.all([st.set("cwtest", A), st.set("cwtest", B)]);

  const got = (await st.get("cwtest")) ?? "";
  console.log(`[check3] 并发写后长度=${got.length} 完整=${got === A || got === B}`);
  assert.ok(got === A || got === B, `并发写后内容应完整等于某一个写者，实际长度 ${got.length}`);

  const leftover = (await readdir(dir)).filter((f) => f.includes(".tmp"));
  console.log(`[check3] 残留 tmp 文件=${leftover.length}`);
  assert.equal(leftover.length, 0, `不应残留 tmp 文件，实际 ${leftover.join(", ")}`);

  // 核心断言：tmp 路径必须唯一。
  // 直接观测 set() 期间实际创建的 tmp 文件名个数——唯一化后两个并发写者各建一个（2 个不同名），
  // 共用固定名时两者是同一个名字（1 个）。用高频轮询目录采样，不打桩（fs/promises 的
  // ESM 命名导出不可 redefine，实测抛 "Cannot redefine property"）。
  const seen = new Set<string>();
  let polling = true;
  const poll = (async () => {
    while (polling) {
      for (const f of await readdir(dir).catch(() => [] as string[])) {
        if (f.includes(".tmp")) seen.add(f);
      }
    }
  })();
  try {
    await Promise.all([st.set("cwtest2", A), st.set("cwtest2", B)]);
  } finally {
    polling = false; // 必须无条件停掉轮询，否则 set 抛错时这个 while 会空转不退出
    await poll;
  }

  console.log(`[check3] 并发写期间观测到的不同 tmp 名=${seen.size} 个: ${[...seen].join(", ")}`);
  assert.ok(
    seen.size >= 2,
    `两个并发写者应各有独立 tmp 文件（观测到 ${seen.size} 个不同名）→ ` +
      `tmp 名被共用，后来者 rename 撞 ENOENT 会退化成非原子直写`,
  );
}

async function main() {
  // 三个检查共用一个临时目录，绝不碰真实 data/（getStorage 单例绑定首次的 DATA_DIR）
  const dir = await mkdtemp(join(tmpdir(), "doubao-check-"));
  process.env.DOUBAO_TTS_DATA_DIR = dir;
  process.env.STORAGE_BACKEND = "file";
  try {
    await checkCountersBounded(dir);
    checkMalformedFrames();
    await checkConcurrentCookieWrite(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("\n三类资源泄漏断言全部通过（限流 Map 有界 + 畸形帧不死循环 + cookie 并发写不损坏）");
  console.log("CHECK OK");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("CHECK FAILED:", (e as Error)?.message || e);
    process.exit(1);
  },
);
