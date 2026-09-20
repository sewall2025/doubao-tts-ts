/**
 * 极简 Protobuf 编解码（无 protobuf 依赖），对应豆包 VoiceGenie 协议
 * data.speech.gateway.WebSocketRequest / WebSocketResponse
 *
 * 逆向自豆包前端 s2-doubao-speech-sdk.js，与 Python 版 doubao_tts.py 一致。
 * 协议整数字段用大端；这里只用到 string / bytes（wire type 2）与 varint。
 */

function varint(n: number): number[] {
  const out: number[] = [];
  while (true) {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    out.push(n ? b | 0x80 : b);
    if (!n) return out;
  }
}

function fieldStr(num: number, val: string): number[] {
  const b = Array.from(Buffer.from(val, "utf-8"));
  return [...varint((num << 3) | 2), ...varint(b.length), ...b];
}

export interface WsRequest {
  token?: string;
  appkey?: string;
  namespace?: string;
  version?: string;
  event?: string;
  payload?: string;
  task_id?: string;
  session_id?: string;
}

// WebSocketRequest 字段编号
const REQ_FIELDS: Array<[keyof WsRequest, number]> = [
  ["token", 1],
  ["appkey", 2],
  ["namespace", 3],
  ["version", 4],
  ["event", 5],
  ["payload", 6],
  // data=7 (bytes) 未用
  ["task_id", 8],
  // seq_id=9 (uint64) 未用
  ["session_id", 10],
];

export function encodeRequest(req: WsRequest): Buffer {
  const bytes: number[] = [];
  for (const [key, num] of REQ_FIELDS) {
    const v = req[key];
    if (v) bytes.push(...fieldStr(num, v));
  }
  return Buffer.from(bytes);
}

export interface WsResponse {
  task_id?: string;
  message_id?: string;
  namespace?: string;
  event?: string;
  status_code?: number;
  status_text?: string;
  payload?: string;
  data?: Buffer;
  seq_id?: number;
  session_id?: string;
  log_id?: string;
}

// WebSocketResponse 字段编号
const RESP_NAMES: Record<number, keyof WsResponse> = {
  1: "task_id",
  2: "message_id",
  3: "namespace",
  4: "event",
  5: "status_code",
  6: "status_text",
  7: "payload",
  8: "data",
  9: "seq_id",
  10: "session_id",
  11: "log_id",
};

export function decodeResponse(buf: Buffer): WsResponse {
  const out: WsResponse = {};
  let i = 0;
  while (i < buf.length) {
    // 读 tag varint
    let tag = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i++]!;
      tag |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const num = tag >> 3;
    const wt = tag & 7;
    const name = RESP_NAMES[num];

    if (wt === 0) {
      // varint
      let v = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++]!;
        v |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      if (name === "status_code" || name === "seq_id") out[name] = v;
    } else if (wt === 2) {
      // length-delimited
      let ln = 0;
      let s = 0;
      while (i < buf.length) {
        const b = buf[i++]!;
        ln |= (b & 0x7f) << s;
        if (!(b & 0x80)) break;
        s += 7;
      }
      // 长度必须是合法的非负值且不越界。这里用 32 位 |=/<< 累加，畸形的 5 字节
      // varint 能把 bit31 置 1 得到负数（实测 [0x80,0x80,0x80,0x80,0x08] → -2147483648），
      // 负数会让下面的 i += ln 回退，外层 while(i < buf.length) 永不终止 →
      // 同步死循环卡死整个事件循环，连块间超时 timer 都没机会触发（实测 2e6 次迭代未退出）。
      if (ln < 0 || i + ln > buf.length) break; // 畸形帧：停止解析，返回已解出的字段
      const raw = buf.subarray(i, i + ln);
      i += ln;
      if (name === "data") {
        out.data = raw;
      } else if (name) {
        // 其余都是 string 字段
        (out as Record<string, unknown>)[name] = raw.toString("utf-8");
      }
    } else {
      break; // 不支持的 wire type，终止
    }
  }
  return out;
}
