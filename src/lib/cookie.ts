/**
 * Cookie 管理：加载 / 心跳续期 / 从 sid_guard 推算过期。
 *
 * 存储用 Storage 抽象（file 或 redis），key 固定为 "cookie"。
 * 心跳端点 /passport/token/beat/v2/ 会滚动续期核心登录态到 ~29.9 天。
 */
import { getStorage } from "./storage";

const RENEW_HOST = "www.doubao.com";
const RENEW_PATH = "/passport/token/beat/v2/?aid=497858";
const COOKIE_KEY = "cookie";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

// 登录态核心 cookie：这几个过期就需要重新登录
const CORE_COOKIES = new Set([
  "sessionid_ss", "uid_tt_ss", "sid_ucp_v1", "ssid_ucp_v1",
  "session_tlb_tag", "passport_auth_status_ss",
]);

/**
 * 加载 cookie。只从存储读（不走环境变量）：
 *   - file 后端（Docker）：直接把 Cookie 头写进 data/.store_cookie
 *   - redis 后端（Vercel）：往 KV 写 cookie 键（控制台/CLI）
 */
async function loadCookie(): Promise<string> {
  return (await getStorage().get(COOKIE_KEY)) ?? "";
}

export { loadCookie };

/** 解析 Cookie 头字符串为 name->value */
function parseCookie(header: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const part of header.split(";")) {
    const t = part.trim();
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    m.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim());
  }
  return m;
}

/** 从 sid_guard 推算登录态到期时间戳（秒）；无法判断返回 null */
function expiryFromSidGuard(header: string): number | null {
  const sg = parseCookie(header).get("sid_guard");
  if (!sg) return null;
  const parts = decodeURIComponent(sg).split("|");
  if (parts.length < 3) return null;
  const issued = Number(parts[1]);
  const ttl = Number(parts[2]);
  if (!Number.isFinite(issued) || !Number.isFinite(ttl)) return null;
  return issued + ttl;
}

/** 核心登录态最早还有多少天过期；无法判断返回 null */
export async function cookieExpiryDays(header?: string): Promise<number | null> {
  const c = header ?? (await loadCookie());
  if (!c) return null;
  const exp = expiryFromSidGuard(c);
  if (exp === null) return null;
  return (exp - Date.now() / 1000) / 86400;
}

/** 把 Set-Cookie 响应头合并进现有 Cookie 头字符串，返回新字符串 */
function mergeSetCookie(header: string, setCookies: string[]): string {
  const jar = parseCookie(header);
  for (const raw of setCookies) {
    const head = raw.split(";")[0] ?? "";
    const eq = head.indexOf("=");
    if (eq <= 0) continue;
    const name = head.slice(0, eq).trim();
    const value = head.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

interface BeatResult {
  ok: boolean;
  msg: string;
  setCookies: string[];
}

/** 调用心跳端点。返回登录态是否有效 + Set-Cookie 列表 */
async function beat(cookieHeader: string): Promise<BeatResult> {
  let res: Response;
  try {
    res = await fetch(`https://${RENEW_HOST}${RENEW_PATH}`, {
      headers: {
        Cookie: cookieHeader,
        Origin: "https://www.doubao.com",
        Referer: "https://www.doubao.com/chat/",
        "User-Agent": UA,
      },
    });
  } catch (e) {
    return { ok: false, msg: `请求失败: ${(e as Error).message}`, setCookies: [] };
  }
  if (res.status !== 200) return { ok: false, msg: `HTTP ${res.status}`, setCookies: [] };

  let message = "";
  try {
    message = ((await res.json()) as { message?: string }).message ?? "";
  } catch {
    message = "";
  }
  if (message !== "success") return { ok: false, msg: `登录态无效: ${message}`, setCookies: [] };

  // Node fetch 的 headers.getSetCookie() 返回原始 Set-Cookie 数组
  const setCookies = res.headers.getSetCookie?.() ?? [];
  return { ok: true, msg: "success", setCookies };
}

export interface RenewResult {
  ok: boolean;
  msg: string;
}

/** 续期登录态，成功则把新 cookie 写回存储。不抛异常。 */
export async function renewCookie(): Promise<RenewResult> {
  const header = await loadCookie();
  if (!header) return { ok: false, msg: "未找到 cookie" };

  const r = await beat(header);
  if (!r.ok) {
    if (r.msg.includes("登录态无效")) {
      return { ok: false, msg: `登录已失效，需重新导出 cookie（${r.msg}）` };
    }
    return { ok: false, msg: r.msg };
  }

  const got = new Set(
    r.setCookies.map((s) => (s.split("=")[0] ?? "").trim()),
  );
  const hasCore = [...CORE_COOKIES].some((c) => got.has(c));
  if (!hasCore) {
    // 端点有节流：刚续过或还很新时不重发核心 cookie，不是失败
    const days = await cookieExpiryDays(header);
    const tail = days !== null ? `，剩余 ${days.toFixed(1)} 天` : "";
    return { ok: true, msg: `登录态有效，服务端本次未下发新 cookie（无需续期）${tail}` };
  }

  const merged = mergeSetCookie(header, r.setCookies);
  await getStorage().set(COOKIE_KEY, merged);
  const days = await cookieExpiryDays(merged);
  const tail = days !== null ? `，核心登录态剩余 ${days.toFixed(1)} 天` : "";
  return { ok: true, msg: `已续期 ${got.size} 个 cookie${tail}` };
}
