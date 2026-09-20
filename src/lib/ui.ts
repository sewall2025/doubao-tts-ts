/**
 * 音色预览页面（自包含 HTML，零外部依赖）。
 * 与 Python 版一致：女声/男声分组、每音色播放按钮试听、API Key 存内存、
 * 宽屏居中限宽、每音色显示简称/speaker_id 可点击复制。
 */
import { DEMO_TEXT } from "./config";

export const UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>豆包 TTS 音色预览</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
         "PingFang SC", "Microsoft YaHei", sans-serif; color: #1a1a1a; background: #fff; }
  header { position: sticky; top: 0; background: #fff; z-index: 10;
           border-bottom: 1px solid #eee; padding: 12px 16px;
           display: flex; flex-direction: column; align-items: center; }
  header > * { width: 100%; max-width: 720px; }
  h1 { font-size: 18px; margin: 0 0 12px; text-align: center; }
  .keybar { display: flex; gap: 8px; align-items: center; }
  .keybar label { flex: none; font-size: 13px; color: #666; white-space: nowrap; }
  .keybar input { flex: 1; padding: 8px 12px; border: 1px solid #ddd;
                  border-radius: 8px; font-size: 14px; }
  .keybar input.ok { border-color: #22c55e; }
  .keybar button { flex: none; padding: 8px 16px; border: none; border-radius: 8px;
                   background: #2563eb; color: #fff; font-size: 14px; cursor: pointer; }
  .keybar button:hover { background: #1d4ed8; }
  .tabs { display: flex; gap: 8px; margin-top: 12px; }
  .tab { flex: 1; padding: 8px; text-align: center; border-radius: 8px;
         background: #f2f2f2; cursor: pointer; font-size: 14px; user-select: none; }
  .tab.active { background: #2563eb; color: #fff; }
  ul { list-style: none; margin: 0 auto; padding: 0; max-width: 720px; }
  li { display: flex; align-items: center; padding: 12px 16px; border-bottom: 1px solid #f2f2f2; }
  .info { flex: 1; min-width: 0; }
  .name { font-size: 15px; font-weight: 600; }
  .tags { font-size: 12px; color: #999; margin-top: 3px; }
  .ids { font-size: 11px; color: #bbb; margin-top: 3px; font-family:
         ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
  .ids code { background: #f5f5f5; padding: 1px 5px; border-radius: 4px;
              margin-right: 6px; color: #666; cursor: pointer; }
  .play { flex: none; width: 40px; height: 40px; border-radius: 50%; border: none;
          background: #f2f2f2; cursor: pointer; font-size: 18px;
          display: flex; align-items: center; justify-content: center; }
  .play:hover { background: #e5e5e5; }
  .play.loading { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .hint { padding: 10px 16px; font-size: 13px; color: #b45309;
          background: #fffbeb; max-width: 720px; margin: 0 auto; }
  .empty { padding: 40px; text-align: center; color: #999; }
</style>
</head>
<body>
<header>
  <h1>豆包 TTS 音色预览</h1>
  <div class="keybar">
    <label for="apikey">输入 API KEY</label>
    <input id="apikey" type="password" placeholder="填入 API Key 才能试听" autocomplete="off">
    <button id="savekey">确定</button>
  </div>
  <div class="tabs">
    <div class="tab active" data-g="female">女声</div>
    <div class="tab" data-g="male">男声</div>
  </div>
</header>
<div id="hint" class="hint" style="display:none"></div>
<ul id="list"><li class="empty">加载中…</li></ul>
<audio id="player"></audio>
<script>
(function () {
  var data = { female: [], male: [] };
  var cur = "female";
  var playing = null;
  var savedKey = "";
  var listEl = document.getElementById("list");
  var keyEl = document.getElementById("apikey");
  var saveBtn = document.getElementById("savekey");
  var hintEl = document.getElementById("hint");
  var player = document.getElementById("player");
  var DEMO_TEXT = %DEMO_TEXT%;

  function showHint(msg) { hintEl.textContent = msg; hintEl.style.display = msg ? "block" : "none"; }
  function saveKey() {
    savedKey = keyEl.value.trim();
    keyEl.classList.toggle("ok", savedKey.length > 0);
    showHint(savedKey ? "API Key 已保存，可以试听了" : "API Key 已清空");
  }
  saveBtn.addEventListener("click", saveKey);
  keyEl.addEventListener("keydown", function (e) { if (e.key === "Enter") saveKey(); });

  function copy(text) {
    if (navigator.clipboard) { navigator.clipboard.writeText(text); showHint("已复制: " + text); }
  }

  function render() {
    var arr = data[cur] || [];
    if (!arr.length) { listEl.innerHTML = '<li class="empty">暂无音色</li>'; return; }
    listEl.innerHTML = "";
    arr.forEach(function (v) {
      var li = document.createElement("li");
      var info = document.createElement("div"); info.className = "info";
      var name = document.createElement("div"); name.className = "name";
      name.textContent = v.name || v.speaker_id;
      var tags = document.createElement("div"); tags.className = "tags";
      tags.textContent = (v.tags || []).join(" \\u00b7 ");
      var ids = document.createElement("div"); ids.className = "ids";
      if (v.alias) {
        var a = document.createElement("code"); a.textContent = "简称：" + v.alias;
        a.onclick = function () { copy(v.alias); }; ids.appendChild(a);
      }
      var sid = document.createElement("code"); sid.textContent = "speaker_id：" + v.speaker_id;
      sid.onclick = function () { copy(v.speaker_id); }; ids.appendChild(sid);
      info.appendChild(name); info.appendChild(tags); info.appendChild(ids);
      var btn = document.createElement("button"); btn.className = "play"; btn.textContent = "\\u25b6";
      btn.onclick = function () { demo(v.speaker_id, btn); };
      li.appendChild(info); li.appendChild(btn); listEl.appendChild(li);
    });
  }

  function demo(speaker, btn) {
    if (!savedKey) { showHint("请先在顶部输入 API Key 并点“确定”"); keyEl.focus(); return; }
    showHint("");
    if (playing) { playing.classList.remove("loading"); playing.textContent = "\\u25b6"; }
    playing = btn; btn.classList.add("loading"); btn.textContent = "\\u25cc";
    fetch("/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + savedKey },
      body: JSON.stringify({ model: "tts-1", voice: speaker, input: DEMO_TEXT, response_format: "mp3" })
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) {
        throw new Error(r.status === 401 ? "API Key 错误" : ("合成失败: " + t.slice(0, 120)));
      });
      return r.blob();
    }).then(function (blob) {
      btn.classList.remove("loading"); btn.textContent = "\\u25b6";
      var url = URL.createObjectURL(blob); player.src = url; player.play();
      player.onended = function () { URL.revokeObjectURL(url); };
    }).catch(function (e) {
      btn.classList.remove("loading"); btn.textContent = "\\u25b6"; showHint(e.message);
    });
  }

  document.querySelectorAll(".tab").forEach(function (t) {
    t.onclick = function () {
      document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("active"); });
      t.classList.add("active"); cur = t.getAttribute("data-g"); render();
    };
  });

  fetch("/ui/voices").then(function (r) { return r.json(); })
    .then(function (d) { data = d; render(); })
    .catch(function () { listEl.innerHTML = '<li class="empty">音色列表加载失败</li>'; });
})();
</script>
</body>
</html>`.replace("%DEMO_TEXT%", JSON.stringify(DEMO_TEXT));
