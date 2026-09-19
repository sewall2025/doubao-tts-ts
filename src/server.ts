/**
 * Docker/VPS 入口：Node HTTP 服务器 + 后台保温定时器。
 * 运行: node --experimental-strip-types src/server.ts
 */
import { serve } from "@hono/node-server";
import { app } from "./app.ts";
import {
  API_KEY,
  KEEPALIVE_ENABLED,
  KEEPALIVE_INTERVAL_H,
  KEEPALIVE_THRESHOLD_D,
} from "./lib/config.ts";
import { loadCookie, cookieExpiryDays, renewCookie } from "./lib/cookie.ts";
import { voiceCatalog } from "./lib/voices.ts";

const HOST = process.env.DOUBAO_TTS_HOST || (API_KEY ? "0.0.0.0" : "127.0.0.1");
const PORT = parseInt(process.env.DOUBAO_TTS_PORT || "8000", 10);

// 未设 key 却要监听非回环 → 拒绝启动（防账号被局域网滥用）
if (!API_KEY && !["127.0.0.1", "localhost", "::1"].includes(HOST)) {
  console.error(
    `🔴 拒绝启动：未设置 DOUBAO_TTS_API_KEY 却要监听 ${HOST}。\n` +
      `   请设置 DOUBAO_TTS_API_KEY，或改用 HOST=127.0.0.1。`,
  );
  process.exit(1);
}

async function startupCheck(): Promise<void> {
  const cookie = await loadCookie();
  if (!cookie) {
    console.error("⚠️  未找到 cookie（设 DOUBAO_TTS_COOKIE 或挂载 .store_cookie），请求将失败");
  } else {
    const days = await cookieExpiryDays(cookie);
    if (days !== null) {
      console.log(`✓ cookie 剩余 ${days.toFixed(1)} 天`);
      if (days < KEEPALIVE_THRESHOLD_D) {
        const r = await renewCookie();
        console.log(r.ok ? `✓ cookie 保温: ${r.msg}` : `⚠️  cookie 续期失败: ${r.msg}`);
      }
    }
  }
  console.log(`✓ 已加载 ${voiceCatalog().length} 个音色`);
}

// 后台保温：每 N 小时检查，快过期就续
function startKeepalive(): void {
  if (!KEEPALIVE_ENABLED) return;
  setInterval(
    async () => {
      try {
        const days = await cookieExpiryDays();
        if (days === null || days >= KEEPALIVE_THRESHOLD_D) return;
        const r = await renewCookie();
        console.log(r.ok ? `✓ cookie 保温: ${r.msg}` : `⚠️  cookie 续期失败: ${r.msg}`);
      } catch (e) {
        console.error("⚠️  cookie 保温异常:", (e as Error).message);
      }
    },
    KEEPALIVE_INTERVAL_H * 3600 * 1000,
  ).unref(); // 不阻止进程退出
}

await startupCheck();
startKeepalive();

console.log("🎤 豆包 TTS OpenAI 兼容服务");
console.log(`   地址: http://${HOST}:${PORT}/v1`);
console.log(`   鉴权: ${API_KEY ? "需要 Bearer API Key" : "关闭（仅回环）"}`);
console.log(`   UI:   http://${HOST}:${PORT}/ui`);

serve({ fetch: app.fetch, hostname: HOST, port: PORT });
