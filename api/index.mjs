/**
 * Vercel Function 入口（薄壳）。
 * Vercel 原生认 .mjs；这里 import esbuild 预打包好的产物（dist-vercel/index.js）。
 * 构建由 package.json 的 vercel-build 脚本触发（见 build.js）。
 * 所有请求经 vercel.json 的 rewrite 打到这里，由 Hono app 内部路由分发。
 */
export { default } from "../dist-vercel/index.js";
