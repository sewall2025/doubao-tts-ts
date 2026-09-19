/**
 * Vercel 入口：把 Hono app 作为 Web 标准 handler 导出。
 * vercel.json 里 rewrites 把所有请求指到这里。
 */
import { app } from "../src/app.ts";

export const config = {
  runtime: "nodejs", // 需要 Node 运行时（出站 WebSocket + ws 库）
};

export default function handler(req: Request): Response | Promise<Response> {
  return app.fetch(req);
}
