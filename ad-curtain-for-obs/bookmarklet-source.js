// 広告カーテン for OBS — ブックマークレット版
//
// 拡張機能をインストールできない環境(事務所PC等)向けの形態。
// インストール不要・ブラウザ権限ゼロ・自動更新なし。このファイルが唯一のソースで、
// 配布用の1行版は tools/minify-bookmarklet.js でこのファイルから機械生成する。
//
// 機能(拡張機能版のコア部分):
// - YouTube広告の再生を検知したら、OBSの指定ソースを全シーンで非表示(カーテン)
// - 広告終了で元の表示状態に復帰(300msディレイ)
// - 動画が最後まで再生されたらカーテン、次の再生開始で復帰
// - 画面右下に状態パネル(設定変更・終了ボタン付き)
// 広告のブロック・スキップは一切しない。通信先は同一PC内のOBS(ws://127.0.0.1)のみ。
//
// 設定はプロンプトで尋ね、このブラウザのyoutube.com用localStorageに保存される。
// ページを再読み込みしたら、もう一度ブックマークレットをクリックして再開する。
(() => {
'use strict';
const w = window;
// 2回目のクリックはパネルを前面に出すだけ(多重起動防止)
if (w.__nnwAdCurtain) { w.__nnwAdCurtain.show(); return; }

const LS = 'nnwAdCurtainCfg';
const st = {
stopped: false, identified: false, seq: 0, pending: new Map(),
ws: null, cfg: null, saved: null, curtainOn: false,
adNow: false, endedHold: false,
offTimer: null, reTimer: null, findTimer: null,
player: null, video: null, panel: null, el: null, obsErr: '',
};

// ---- 設定(localStorage) ----
function loadCfg() { try { return JSON.parse(localStorage.getItem(LS) || 'null'); } catch (e) { return null; } }
function saveCfg(c) { try { localStorage.setItem(LS, JSON.stringify(c)); } catch (e) { } }
function askCfg(prev) {
const p = prev || { port: '4455', password: '', sources: '' };
const port = prompt('OBS WebSocketのポート番号', p.port);
if (port === null) { return null; }
const pass = prompt('OBS WebSocketのパスワード(認証無しなら空欄)', p.password);
if (pass === null) { return null; }
const src = prompt('隠すOBSソース名(カンマ区切りで複数可)', p.sources);
if (src === null || !src.trim()) { return null; }
return { port: port.trim() || '4455', password: pass, sources: src };
}

// ---- obs-websocket v5 認証(sha256を2段) ----
function b64(buf) {
let s = '';
const a = new Uint8Array(buf);
for (let i = 0; i < a.length; i++) { s += String.fromCharCode(a[i]); }
return btoa(s);
}
async function sha(t) { return b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))); }

// ---- OBS接続 ----
function connect() {
if (st.stopped) { return; }
let ws;
try { ws = new WebSocket('ws://127.0.0.1:' + st.cfg.port); } catch (e) { retry(); return; }
st.ws = ws;
st.identified = false;
ws.onmessage = async (ev) => {
let m;
try { m = JSON.parse(ev.data); } catch (e) { return; }
if (m.op === 0) {
const d = { rpcVersion: 1, eventSubscriptions: 0 };
if (m.d.authentication) {
d.authentication = await sha(await sha(st.cfg.password + m.d.authentication.salt) + m.d.authentication.challenge);
}
ws.send(JSON.stringify({ op: 1, d: d }));
} else if (m.op === 2) {
st.identified = true;
st.obsErr = '';
paint();
evaluate();
} else if (m.op === 7) {
const pd = st.pending.get(m.d.requestId);
if (pd) {
st.pending.delete(m.d.requestId);
if (m.d.requestStatus.result) { pd.res(m.d.responseData || {}); }
else { pd.rej(new Error(m.d.requestType + ' 失敗 code=' + m.d.requestStatus.code)); }
}
}
};
ws.onclose = (ev) => {
st.identified = false;
st.pending.forEach((pd) => pd.rej(new Error('切断')));
st.pending.clear();
if (!st.stopped) {
st.obsErr = (ev.code === 4009) ? 'パスワードが違います' : 'OBS未接続(再接続中)';
paint();
retry();
}
};
}
function retry() {
if (st.reTimer || st.stopped) { return; }
st.reTimer = setTimeout(() => { st.reTimer = null; connect(); }, 5000);
}
function req(type, data) {
return new Promise((res, rej) => {
if (!st.identified) { rej(new Error('OBS未接続')); return; }
const id = String(++st.seq);
st.pending.set(id, { res: res, rej: rej });
st.ws.send(JSON.stringify({ op: 6, d: { requestType: type, requestId: id, requestData: data || {} } }));
});
}

// ---- カーテン(元の表示状態を保存してから隠す) ----
function srcNames() { return st.cfg.sources.split(/[,、]/).map((s) => s.trim()).filter(Boolean); }
async function setCurtain(on) {
if (on) {
if (st.saved) { return; }
const saved = [];
const sc = await req('GetSceneList');
for (const scene of (sc.scenes || [])) {
for (const name of srcNames()) {
let id;
try { id = (await req('GetSceneItemId', { sceneName: scene.sceneName, sourceName: name })).sceneItemId; } catch (e) { continue; }
const en = (await req('GetSceneItemEnabled', { sceneName: scene.sceneName, sceneItemId: id })).sceneItemEnabled;
saved.push({ s: scene.sceneName, i: id, e: en });
if (en) { await req('SetSceneItemEnabled', { sceneName: scene.sceneName, sceneItemId: id, sceneItemEnabled: false }); }
}
}
st.saved = saved;
if (!saved.length) { st.saved = null; throw new Error('ソースが見つかりません: ' + st.cfg.sources); }
} else {
const saved = st.saved;
st.saved = null;
if (!saved) { return; }
for (const it of saved) {
if (!it.e) { continue; }
try { await req('SetSceneItemEnabled', { sceneName: it.s, sceneItemId: it.i, sceneItemEnabled: true }); } catch (e) { }
}
}
}
let chain = Promise.resolve();
function apply(on) {
chain = chain.then(async () => {
if (on === st.curtainOn) { return; }
await setCurtain(on);
st.curtainOn = on;
st.obsErr = '';
paint();
}).catch((e) => { st.obsErr = e.message; paint(); });
}
function evaluate() {
const want = st.adNow || st.endedHold;
if (want) {
if (st.offTimer) { clearTimeout(st.offTimer); st.offTimer = null; }
apply(true);
} else if (st.curtainOn && !st.offTimer) {
st.offTimer = setTimeout(() => {
st.offTimer = null;
if (!(st.adNow || st.endedHold)) { apply(false); }
}, 300);
}
}

// ---- 広告検知(拡張機能版と同一ロジック) ----
function isAd() {
const p = st.player;
return !!(p && p.isConnected && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting')));
}
const mo = new MutationObserver(() => {
const a = isAd();
if (a !== st.adNow) {
st.adNow = a;
paint();
evaluate();
// 広告明け(=ポストロール終了の可能性)に本編終了状態を確認する
if (!a) { setTimeout(checkEnded, 500); }
}
});
function onEnded() { if (!isAd()) { st.endedHold = true; paint(); evaluate(); } }
function onPlaying() { if (!isAd() && st.endedHold) { st.endedHold = false; paint(); evaluate(); } }
// 本編終了の直接判定。終了直前にポストロール広告が挟まると'ended'イベントは
// 広告中に発火してガードで捨てられるため、プレイヤーAPIの状態(0=終了)でも拾う。
function checkEnded() {
const p = st.player;
if (isAd() || st.endedHold || !p || typeof p.getPlayerState !== 'function') { return; }
if (p.getPlayerState() === 0) { st.endedHold = true; paint(); evaluate(); }
}
function attach() {
const p = document.getElementById('movie_player');
if (p && p !== st.player) {
st.player = p;
mo.disconnect();
mo.observe(p, { attributes: true, attributeFilter: ['class'] });
st.adNow = isAd();
evaluate();
}
const v = document.querySelector('#movie_player video');
if (v && v !== st.video) {
if (st.video) {
st.video.removeEventListener('ended', onEnded);
st.video.removeEventListener('playing', onPlaying);
}
st.video = v;
v.addEventListener('ended', onEnded);
v.addEventListener('playing', onPlaying);
}
}

// ---- 状態パネル ----
function paint() {
if (!st.el) { return; }
let t;
if (st.obsErr) { t = '⚠ ' + st.obsErr; }
else if (!st.identified) { t = 'OBSへ接続中…'; }
else if (st.adNow) { t = '広告中(カーテン)'; }
else if (st.endedHold) { t = '動画終了(カーテン)'; }
else { t = '監視中'; }
st.el.textContent = '広告カーテン: ' + t;
}
const BTN = 'background:#4a4f59;color:#fff;border:none;border-radius:4px;padding:3px 8px;font:11px Meiryo,sans-serif;cursor:pointer';
function makePanel() {
const d = document.createElement('div');
d.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;background:rgba(20,22,28,.92);color:#eee;font:12px Meiryo,sans-serif;padding:8px 10px;border-radius:8px;display:flex;gap:8px;align-items:center;box-shadow:0 2px 10px rgba(0,0,0,.4)';
const s = document.createElement('span');
st.el = s;
const cb = document.createElement('button');
cb.textContent = '設定';
cb.style.cssText = BTN;
cb.onclick = () => {
const c = askCfg(st.cfg);
if (c) {
st.cfg = c;
saveCfg(c);
try { if (st.ws) { st.ws.close(); } } catch (e) { }
}
};
const xb = document.createElement('button');
xb.textContent = '終了';
xb.style.cssText = BTN;
xb.onclick = () => { stop(); };
d.appendChild(s);
d.appendChild(cb);
d.appendChild(xb);
document.documentElement.appendChild(d);
st.panel = d;
paint();
}
async function stop() {
st.stopped = true;
if (st.findTimer) { clearInterval(st.findTimer); }
if (st.offTimer) { clearTimeout(st.offTimer); }
if (st.reTimer) { clearTimeout(st.reTimer); }
mo.disconnect();
if (st.video) {
st.video.removeEventListener('ended', onEnded);
st.video.removeEventListener('playing', onPlaying);
}
try { if (st.curtainOn || st.saved) { await setCurtain(false); st.curtainOn = false; } } catch (e) { }
try { if (st.ws) { st.ws.close(); } } catch (e) { }
if (st.panel) { st.panel.remove(); }
delete w.__nnwAdCurtain;
}
st.show = () => { if (st.panel) { st.panel.style.display = 'flex'; } };
w.__nnwAdCurtain = st;

// ---- 起動 ----
st.cfg = loadCfg();
if (!st.cfg) {
const c = askCfg(null);
if (!c) { delete w.__nnwAdCurtain; return; }
st.cfg = c;
saveCfg(c);
}
makePanel();
attach();
st.findTimer = setInterval(() => { attach(); checkEnded(); }, 2000);
connect();
})();
