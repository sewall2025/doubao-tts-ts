/**
 * 静音音频兜底。
 *
 * 豆包对纯标点/符号段返回「合法会话、零字节」（bytes=0），或偶发 TTSInvalidText。
 * 客户端顺序播放，若这类段返回错误(502)会卡住并重试(确定性失败→死循环)。
 *
 * 微软 Edge TTS 对标点返回的就是静音——参考项目 read-aloud 因此「标点无问题」。
 * 本模块对齐该行为：这类段返回一小段合法静音音频(200)，客户端无声播过、顺畅推进。
 *
 * mp3 用预生成的合法静音帧(ffmpeg: anullsrc 24kHz mono 32k, ~0.3s)。
 * wav/pcm 程序生成静音。opus 罕见，退回 mp3 静音字节（客户端只用 mp3）。
 */
import type { AudioFormat } from "./tts.ts";

// ffmpeg -f lavfi -i anullsrc=r=24000:cl=mono -t 0.05 -b:a 32k -acodec libmp3lame，716 字节合法可播（50ms）
const SILENT_MP3_B64 =
  "SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAwAAAAAAAAAAAAAAD/84TAAAAAAAAAAAAASW5mbwAAAA8AAAAFAAACoABtbW1tbW1tbW1tbW1tbW1tbW1tkpKSkpKSkpKSkpKSkpKSkpKSkpK2tra2tra2tra2tra2tra2tra2ttvb29vb29vb29vb29vb29vb29vb//////////////////////////8AAAAATGF2YzYxLjE5AAAAAAAAAAAAAAAAJARQAAAAAAAAAqC9P8vrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/80TEAAAAA0gAAAAATEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy7/80TEUwAAA0gAAAAAMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy7/80TEpgAAA0gAAAAAMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80TErAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80TErAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVU=";

const SILENT_MP3 = Buffer.from(SILENT_MP3_B64, "base64");

/** WAV 头 + 一小段静音 PCM（16bit 24kHz mono, 50ms）*/
function silentWav(): Buffer {
  const sampleRate = 24000;
  const samples = Math.floor(sampleRate * 0.05);
  const dataLen = samples * 2; // 16bit mono
  const buf = Buffer.alloc(44 + dataLen); // 头 44 字节 + 静音数据（默认全 0）
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // fmt chunk 大小
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // 字节率
  buf.writeUInt16LE(2, 32); // 块对齐
  buf.writeUInt16LE(16, 34); // 位深
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf; // data 段已是全 0 静音
}

/** 返回指定格式的一小段静音音频。用于标点/零内容段，让客户端顺畅播过。 */
export function silentAudio(format: AudioFormat): Buffer {
  switch (format) {
    case "wav":
      return silentWav();
    case "pcm":
      return Buffer.alloc((24000 * 2 * 0.05) | 0); // 裸 PCM 静音，50ms 16bit 24kHz mono
    case "mp3":
    case "ogg_opus":
    default:
      return SILENT_MP3; // 客户端主用 mp3；opus 罕见，退回 mp3 静音字节
  }
}
