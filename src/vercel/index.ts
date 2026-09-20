/**
 * Vercel 入口逻辑：把 Hono app 作为 Web 标准 handler 导出。
 * 被 esbuild 打包成 dist-vercel/index.js，再由 api/index.mjs 薄壳引用。
 */
import { app } from "../app";

export default function handler(req: Request): Response | Promise<Response> {
  return app.fetch(req);
}
