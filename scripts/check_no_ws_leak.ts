/**
 * 连接不泄漏自检（跑完即退，不起端口、不起长驻进程）。
 *
 * 守的是这次事故的根因：超时或调用方提前放弃时，ws 必须真的关掉。
 * 原来 app.ts 用 Promise.race 包整段硬超时，超时只「丢弃」async generator，
 * synthesize 的 finally 永不执行 → ws 泄漏，继续占豆包配额；重试再叠一条，越重试越挤
 * （实测表现：ECONNRESET / TLS disconnected / handshake timed out 连环）。
 *
 * 用 process.getActiveResourcesInfo() 数活跃 socket 句柄（TLSWRAP/TCPWRAP）来判泄漏，
 * 不打桩、不碰实现细节——泄漏的连接一定留着句柄。
 *
 * 两组断言：
 *  1) 正常合成跑完 → 句柄回到基线。
 *  2) 只取首块就 break（等价于调用方放弃）→ 句柄同样回到基线。
 *     这组是关键：for-await 的 break 会调生成器 .return()，必须触发 finally 关掉 ws。
 *
 * 运行：cd /Users/fanmac/AI/doubao-tts-ts && npx tsx --env-file-if-exists=.env scripts/check_no_ws_leak.ts
 */
import assert from "node:assert/strict";
import { synthesize } from "../src/lib/tts.js";
import { loadCookie } from "../src/lib/cookie.js";

// 实测（Node 24）：一条活的 wss 连接在 getActiveResourcesInfo() 里叫 TCPSocketWrap。
// 必须包含它，否则计数永远是 0，所有断言都是空跑（这个坑已经踩过一次）。
const SOCKET_TYPES = new Set(["TCPSocketWrap", "TLSWRAP", "TCPWRAP"]);

function sockets(): number {
  return process.getActiveResourcesInfo().filter((t) => SOCKET_TYPES.has(t)).length;
}

/** 等句柄落地（close 帧 / terminate 需要一点时间），最多等 waitMs */
async function socketsSettled(baseline: number, waitMs = 4000): Promise<number> {
  const deadline = Date.now() + waitMs;
  let n = sockets();
  while (n > baseline && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    n = sockets();
  }
  return n;
}

async function main() {
  const cookie = await loadCookie();
  assert.ok(cookie, "需要有效 cookie（data/.store_cookie）");

  const cfg = {
    speaker: "zh_female_wenroutaozi_uranus_bigtts",
    format: "mp3" as const,
    speechRate: 1.0,
    pitch: 0,
    cookie,
  };

  const baseline = sockets();
  console.log(`基线 socket 句柄=${baseline}`);

  // ---- 组 1：正常跑完 ----
  let bytes = 0;
  for await (const chunk of synthesize("你好，这是一段测试。", cfg)) {
    if (chunk.audio) bytes += chunk.audio.length;
  }
  const after1 = await socketsSettled(baseline);
  console.log(`[check1] 正常合成 bytes=${bytes} 句柄=${after1}`);
  assert.ok(bytes > 0, "正常合成应产出音频");
  assert.equal(after1, baseline, `正常结束后句柄应回到基线 ${baseline}，实际 ${after1}（泄漏）`);

  // ---- 组 2：提前 break（等价于原 Promise.race 丢弃迭代器的场景）----
  let firstChunk = 0;
  for await (const chunk of synthesize("这一段只取第一块就提前退出，用来验证连接会被关掉。", cfg)) {
    if (chunk.audio && chunk.audio.length > 0) {
      firstChunk = chunk.audio.length;
      break; // 调用方放弃
    }
  }
  const after2 = await socketsSettled(baseline);
  console.log(`[check2] 提前 break 首块 bytes=${firstChunk} 句柄=${after2}`);
  assert.ok(firstChunk > 0, "应至少拿到一块音频再 break");
  assert.equal(after2, baseline, `提前放弃后句柄应回到基线 ${baseline}，实际 ${after2}（泄漏）`);

  console.log("\n两组断言全部通过：正常结束与提前放弃都不泄漏连接");
  console.log("CHECK OK");
}

// 注意：泄露的 socket 会把事件循环永久牵住，进程不会自然退出。
// 所以结论一出就用 process.exit 硬退，否则泄露时这个自检会「挂住」而不是「报错」，
// 反而掩盖了它要抄的 bug（实测踩过：注掉 ws.close() 后这里直接超时无输出）。
main().then(
  () => {
    process.exit(0);
  },
  (e) => {
    console.error("CHECK FAILED:", (e as Error)?.message || e);
    process.exit(1);
  },
);
