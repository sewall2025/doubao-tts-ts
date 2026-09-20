// @ts-check
/**
 * Vercel 构建：把 TS 源（含 .ts 扩展名 import 和 voices.json）用 esbuild 打包成纯 JS。
 *
 * 为什么需要：Vercel 默认 Node runtime 不认 `.ts` 扩展名的 import，也不跑 .ts 源文件。
 * 本地靠 node --experimental-strip-types 能跑，Vercel 不行，故预打包。
 * 依赖（hono/ws 等）留外部（packages: external），由 Vercel 的 node_modules 解析。
 *
 * 产物 dist-vercel/ 被 api/*.mjs 薄壳 import，作为 Vercel Functions 入口。
 * vercel.json 的 vercel-build 脚本触发本文件。
 */
import * as esbuild from "esbuild";

const shared = {
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  packages: "external", // hono/ws 等留外部，Vercel 装 node_modules 后解析
  sourcemap: false, // 关闭：sourcemap 会引用 src/*.ts，Vercel @vercel/nft 顺着追踪会把 src 拉进 lambda
                    // 并编译 src/app.ts→app.js，其 .ts 扩展名 import 运行时解析失败。
  logLevel: "info",
};

await esbuild.build({
  ...shared,
  entryPoints: {
    index: "src/vercel/index.ts",
    "cron/renew": "src/vercel/cron-renew.ts",
  },
  outdir: "dist-vercel",
});

console.log("✓ Vercel 构建完成 → dist-vercel/");
