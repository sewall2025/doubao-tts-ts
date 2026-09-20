/**
 * Vercel Cron Function 入口（薄壳）。
 * import esbuild 预打包好的产物（dist-vercel/cron/renew.js）。
 * vercel.json 的 crons 配置每天定时打这个路径。
 */
export { default } from "../../dist-vercel/cron/renew.js";
