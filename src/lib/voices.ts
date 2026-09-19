/**
 * 音色表 + 白名单解析。
 * voices.json 由 Python 版 fetch_voices.py 从豆包 /alice/user_voice/recommend 拉取。
 * 服务端对未识别的 speaker ID 会静默回退默认音色，故白名单是唯一拦截点。
 */
import voicesData from "../../voices.json" with { type: "json" };

export interface Voice {
  speaker_id: string;
  name: string;
  voice_id?: string;
  tags: string[];
  tab?: string;
  language?: string;
}

// 少量常用简称，方便命令行/接口；完整列表见 voices.json
export const SPEAKERS: Record<string, string> = {
  taozi: "zh_female_wenroutaozi_uranus_bigtts",
  vv: "zh_female_vv_uranus_bigtts",
  shuangkuai: "zh_female_shuangkuaisisi_moon_bigtts",
  yangguang: "zh_male_yangguang_conversation_v4_wvae_bigtts",
  rap: "zh_male_rap_mars_bigtts",
  en_female: "en_female_sarah_conversation_bigtts",
  en_male: "en_male_adam_conversation_bigtts",
};

// OpenAI 的预设音色名，豆包无对应实现，命中时给可用清单
export const OPENAI_VOICES = new Set([
  "alloy", "echo", "fable", "onyx", "nova", "shimmer",
  "ash", "coral", "sage", "ballad", "verse",
]);

const _voices: Voice[] = (voicesData as { voices: Voice[] }).voices;

// 构建查找表：名称/别名/speaker_id（小写） -> speaker_id
const _lookup = new Map<string, string>();
const _byId = new Map<string, Voice>();

for (const v of _voices) {
  const sid = v.speaker_id;
  if (!sid) continue;
  _byId.set(sid, v);
  _lookup.set(sid.toLowerCase(), sid);
  const name = (v.name ?? "").trim();
  if (name && !_lookup.has(name.toLowerCase())) {
    _lookup.set(name.toLowerCase(), sid); // 中文名也可作为 voice 传入
  }
}
// 简称优先级最高；其指向的 speaker_id 本身也要可解析
for (const [alias, sid] of Object.entries(SPEAKERS)) {
  _lookup.set(alias.toLowerCase(), sid);
  if (!_lookup.has(sid.toLowerCase())) _lookup.set(sid.toLowerCase(), sid);
  if (!_byId.has(sid)) {
    _byId.set(sid, { speaker_id: sid, name: alias, tags: [], tab: "alias", language: "" });
  }
}

/** 把用户输入（简称 / speaker_id / 中文名）解析为 speaker_id；无法匹配返回 null */
export function resolveSpeaker(voice: string): string | null {
  if (!voice) return null;
  return _lookup.get(voice.trim().toLowerCase()) ?? null;
}

/** 全部已知音色详情（含 voices.json 与内置简称） */
export function voiceCatalog(): Voice[] {
  return [..._byId.values()].sort((a, b) =>
    a.speaker_id.localeCompare(b.speaker_id),
  );
}

// ---------------- 格式映射 ----------------
// OpenAI response_format -> 豆包 format
export const FORMAT_MAP: Record<string, AudioFormatName> = {
  mp3: "mp3",
  opus: "ogg_opus",
  wav: "wav",
  pcm: "pcm",
};
export const UNSUPPORTED_FORMATS = new Set(["aac", "flac"]);

export type AudioFormatName = "mp3" | "ogg_opus" | "wav" | "pcm";

export const MEDIA_TYPES: Record<AudioFormatName, string> = {
  mp3: "audio/mpeg",
  ogg_opus: "audio/ogg",
  wav: "audio/wav",
  pcm: "audio/L16",
};

/** 语速 clamp：OpenAI 允许 0.25~4.0，豆包只到 0.5~2.0 */
export function clampSpeed(speed: unknown): number {
  const v = typeof speed === "number" ? speed : Number(speed);
  if (!Number.isFinite(v)) return 1.0;
  return Math.max(0.5, Math.min(2.0, v));
}

/** 音调 clamp：-12~12 半音，取整 */
export function clampPitch(pitch: unknown): number {
  const v = typeof pitch === "number" ? pitch : Number(pitch);
  if (!Number.isFinite(v)) return 0;
  return Math.max(-12, Math.min(12, Math.trunc(v)));
}
