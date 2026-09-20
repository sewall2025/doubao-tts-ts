/**
 * Vercel Cron 逻辑：定时续期 cookie（serverless 无常驻进程，用 cron 替代 setInterval）。
 * 被 esbuild 打包成 dist-vercel/cron/renew.js，再由 api/cron/renew.mjs 薄壳引用。
 * 可选用 CRON_SECRET 校验，防止被外部随意触发。
 */
import { renewCookie, cookieExpiryDays } from "../lib/cookie.js";
import { KEEPALIVE_THRESHOLD_D } from "../lib/config.js";

export default async function handler(req: Request): Promise<Response> {
  // Vercel Cron 会带 Authorization: Bearer $CRON_SECRET（若配置了）
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${secret}`) {
      return new Response("unauthorized", { status: 401 });
    }
  }

  const days = await cookieExpiryDays();
  if (days !== null && days >= KEEPALIVE_THRESHOLD_D) {
    return Response.json({ renewed: false, reason: `剩余 ${days.toFixed(1)} 天，无需续期` });
  }
  const r = await renewCookie();
  return Response.json({ renewed: r.ok, msg: r.msg });
}
