// background.js — Service Worker(ESモジュール)
// 「広告カーテン for OBS」の中枢。
// content.js からの広告状態を集約し、OBSソースの表示/非表示(カーテン)を制御する。
// 広告のブロックは一切行わない。OBS側の見た目だけを切り替える。

import { ObsClient } from './obs-client.js';

// ---- 既定設定 ----------------------------------------------------------
const DEFAULT_SETTINGS = {
  enabled: false,
  host: '127.0.0.1',
  port: 4455,
  password: '',
  sourceName: '',
  restoreDelayMs: 300,
  failSafe: true,
  hideAfterEnded: true, // 動画終了後〜次の動画再生開始までカーテンを閉じる
};

// 「映像用, 音声用」のようにカンマ(、も可)区切りで複数ソースを指定できる
function parseSourceNames(sourceName) {
  return String(sourceName || '')
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---- 状態 --------------------------------------------------------------
let settings = { ...DEFAULT_SETTINGS };
let obs = null;                    // 現在のObsClient(切断のたびに作り直す)
let reconnectTimer = null;         // 再接続タイマー
let reconnectDelayMs = 5000;       // 再接続間隔(失敗が続くと最大30秒まで延びる)
let pingTimer = null;              // 疎通確認/SW延命タイマー
let watchdogTimer = null;          // 定期再評価タイマー

const tabStates = new Map();       // tabId -> { ad, lastSeen, playerFound, url, endedHold }
const detectorLostTabs = new Set();// 検知喪失状態のタブID
const pingFails = new Map();       // tabId -> 能動ping連続失敗回数
// 注: タブ側からのハートビートは、バックグラウンドタブではChromeのタイマー絞りで
// 最大1分に1回まで間引かれるため、生存判定には使えない(誤発動の原因になった)。
// 生存判定はSW側からの能動ping(pingWatchTabs)で行う。
// カーテンの「元の表示状態」を切断・SW再起動を跨いで引き継ぐための退避先。
// これが無いと、広告中にOBS接続が切れて再接続した場合に「隠れた状態」を
// 元状態として再保存してしまい、広告終了後もソースが復帰しなくなる。
let savedStatesCarryover = null;
let preconsumeTabId = null;        // 事前消化中のタブID(null=未実行)
let preconsumeProgress = null;     // { current, duration }

let manualTestUntil = 0;           // 手動カーテンテストの終了時刻(この間はONを維持)
let curtainActive = false;         // 実際にOBSへ適用済みのカーテン状態
let curtainWantedButFailed = false;// カーテンONが必要なのに未接続/失敗で打てない
let curtainReason = '';            // カーテンONの理由(popup表示用)
let lastError = '';                // popup表示用の直近エラー文字列

// カーテンON/OFF呼び出しを直列化するプロミスチェーン(連打・交錯の防止)
let curtainChain = Promise.resolve();
// 復帰ディレイ用タイマー(待機中に再ONが来たらキャンセルする)
let offTimer = null;

// ---- 初期化(SW再起動のたびに設定を読み直し接続を復元) ----------------
let initPromise = null;
function ensureInit() {
  if (!initPromise) initPromise = doInit();
  return initPromise;
}
async function doInit() {
  settings = await loadSettings();
  // SWが再起動しても「カーテンを張ったまま」の事実と元状態を復元する
  // (storage.sessionはブラウザ終了まで生きるインメモリ領域)
  try {
    const s = await chrome.storage.session.get('nnwSavedStates');
    if (s && s.nnwSavedStates) {
      savedStatesCarryover = s.nnwSavedStates;
      curtainActive = true; // 物理的にはOBS上で隠れたままのはず
    }
  } catch { /* session storage非対応環境では諦める */ }
  if (settings.enabled) connectObs();
  startWatchdog();
  updateBadge();
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    port: Number(stored.port) || DEFAULT_SETTINGS.port,
    restoreDelayMs: Number(stored.restoreDelayMs) || DEFAULT_SETTINGS.restoreDelayMs,
  };
}

// インストール/リロード時、既に開いているYouTubeタブへ監視スクリプトを注入する。
// これが無いと、拡張機能より前から開いていたタブは広告を一切報告できず、
// フェイルセーフだけが発動する「検知しないのに突然隠れる」状態になる。
async function injectIntoExistingTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' }); } catch { return; }
  for (const t of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] });
    } catch { /* chrome://等に化けたタブなどは無視 */ }
  }
}

// SW起動イベントで確実に初期化
chrome.runtime.onStartup.addListener(() => ensureInit());
chrome.runtime.onInstalled.addListener(() => { ensureInit(); injectIntoExistingTabs(); });
// 設定が外部(options)で変わったら追随する
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  ensureInit().then(async () => {
    const before = { ...settings };
    settings = await loadSettings();
    // enabledやOBS接続情報が変わったら接続を作り直す
    if (
      before.enabled !== settings.enabled ||
      before.host !== settings.host ||
      before.port !== settings.port ||
      before.password !== settings.password
    ) {
      reconnectObsFromScratch();
    }
    updateBadge();
    evaluate();
  });
});
// モジュール読み込み時にも初期化(SW再評価時の復元)
ensureInit();

// ---- OBS接続管理 -------------------------------------------------------
async function connectObs() {
  if (!settings.enabled) return;
  if (obs && obs.connected) return;
  // 既存の接続試行が生きているなら二重接続しない
  if (obs && obs.ws && obs.ws.readyState === WebSocket.CONNECTING) return;

  const client = new ObsClient();
  obs = client;
  client.onClose = () => {
    if (obs !== client) return; // すでに作り直された古いクライアントの通知は無視
    // カーテン中に切断された場合、元状態を退避して再接続後に引き継ぐ。
    // curtainActiveは物理状態(OBS上で隠れたまま)を表すのでリセットしない。
    if (client.savedStates) savedStatesCarryover = client.savedStates;
    stopPing();
    updateBadge();
    if (settings.enabled) scheduleReconnect();
  };
  try {
    await client.connect(settings.host, settings.port, settings.password);
    if (obs !== client) { client.close(); return; }
    // 退避していた元状態を新しいクライアントへ引き継ぐ
    // (setCurtain(true)は冪等になり、setCurtain(false)は正しい元状態へ戻せる)
    if (savedStatesCarryover) {
      client.savedStates = savedStatesCarryover;
      savedStatesCarryover = null;
    }
    // 引き継いだ「カーテン適用済み」状態が実際のOBSと食い違っていないか検証する。
    // 古い残骸のままだと、以後のカーテンONが全て「適用済み」と誤認され何も起きなくなる。
    if (curtainActive && client.savedStates) {
      const probe = (client.savedStates.items || []).find((it) => it.wasEnabled);
      if (probe) {
        try {
          const { sceneItemEnabled } = await client.request('GetSceneItemEnabled', {
            sceneName: probe.sceneName, sceneItemId: probe.sceneItemId,
          });
          if (sceneItemEnabled) throw new Error('実際には表示中=カーテンは張られていない');
        } catch {
          // 残骸を破棄する。ただし音声ミュートだけは必ず戻す
          // (映像はユーザーがOBS側で手動復帰した可能性が高い局面。ミュートを
          //  道連れに捨てると「音声だけOFFのまま」になる)
          const stale = client.savedStates;
          client.savedStates = null;
          curtainActive = false;
          for (const m of (stale && stale.mutes) || []) {
            if (m.wasMuted) continue;
            try { await client.request('SetInputMute', { inputName: m.inputName, inputMuted: false }); } catch { /* 無視 */ }
          }
          try { await chrome.storage.session.remove('nnwSavedStates'); } catch { /* 無視 */ }
        }
      }
    }
    lastError = '';
    reconnectDelayMs = 5000; // 接続成功でリトライ間隔をリセット
    startPing();
    updateBadge();
    evaluate(); // 再接続時、必要ならカーテンを張り直す/開き直す
  } catch (e) {
    lastError = e.message || String(e);
    if (obs === client) obs = null;
    updateBadge();
    if (settings.enabled) scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectObs();
  }, reconnectDelayMs);
  // OBS未起動のままエラー記録が溜まり続けないよう、失敗が続くほど間隔を延ばす
  reconnectDelayMs = Math.min(Math.round(reconnectDelayMs * 1.5), 30000);
}

function reconnectObsFromScratch() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopPing();
  if (obs) {
    // onCloseはobs=null後に発火してobs!==clientで弾かれるため、ここで退避する
    if (obs.savedStates) savedStatesCarryover = obs.savedStates;
    try { obs.close(); } catch { /* 無視 */ }
    obs = null;
  }
  if (settings.enabled) connectObs();
}

function startPing() {
  stopPing();
  // 20秒ごとに疎通確認。SWの延命(アクティビティ発生)も兼ねる。
  pingTimer = setInterval(async () => {
    if (!obs || !obs.connected) return;
    try {
      await obs.ping();
    } catch (e) {
      lastError = e.message || String(e);
      // pingが通らなければ接続は死んでいる。閉じて再接続へ。
      try { obs.close(); } catch { /* 無視 */ }
    }
  }, 20000);
}
function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

let watchdogTick = 0;
function startWatchdog() {
  if (watchdogTimer) return;
  // 5秒ごとに再評価。10秒ごとにwatchタブへ能動ping(SW側タイマーは絞られない)。
  watchdogTimer = setInterval(() => {
    if (settings.enabled && (!obs || !obs.connected)) connectObs();
    watchdogTick++;
    if (settings.enabled && watchdogTick % 2 === 0) {
      pingWatchTabs().then(() => evaluate());
    } else {
      evaluate();
    }
  }, 5000);
}

// SW側からwatchタブの監視スクリプトへ能動的に生存確認する。
// タブ側のsetIntervalはバックグラウンドで最大1分に1回まで間引かれるため、
// 受け身のハートビート待ちでは「途絶→復活」を繰り返して誤発動する。
async function pingWatchTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' }); } catch { return; }
  for (const t of tabs) {
    const isWatch = !!(t.url && t.url.includes('/watch'));
    if (!isWatch) {
      // watchページでないタブは監視対象外。検知不能マーク等の残骸を必ず掃除する
      // (これを怠ると、動画→ホーム遷移後に「検知不能」が永久に残りカーテンが固着する)
      detectorLostTabs.delete(t.id);
      pingFails.delete(t.id);
      const st = tabStates.get(t.id);
      if (st) { st.ad = false; st.endedHold = st.endedHold || false; st.lastSeen = Date.now(); }
      continue;
    }
    if (t.status !== 'complete') { pingFails.delete(t.id); continue; } // 読み込み中は数えない
    try {
      const res = await chrome.tabs.sendMessage(t.id, { type: 'content-ping' });
      if (res && res.ok) {
        pingFails.delete(t.id);
        touchTab(t.id, { ad: !!res.ad, playerFound: !!res.playerFound, url: t.url });
        if (res.playerFound) detectorLostTabs.delete(t.id);
      } else {
        pingFails.set(t.id, (pingFails.get(t.id) || 0) + 1);
      }
    } catch {
      // 応答なし = 監視スクリプト不在の可能性
      pingFails.set(t.id, (pingFails.get(t.id) || 0) + 1);
    }
  }
}

// ---- カーテン判定 ------------------------------------------------------
// いずれかの条件でカーテンON。
async function computeDesired() {
  if (!settings.enabled) return false;
  if (Date.now() < manualTestUntil) { curtainReason = '手動テスト中'; return true; }
  if (preconsumeTabId != null) { curtainReason = '事前消化中'; return true; }

  for (const st of tabStates.values()) {
    if (st.ad) { curtainReason = '広告検知中'; return true; }
  }

  // 動画終了後〜次の動画の再生開始まで(動画探しの画面操作を配信に載せない)
  if (settings.hideAfterEnded) {
    for (const st of tabStates.values()) {
      if (st.endedHold) { curtainReason = '動画終了(次の再生開始で復帰)'; return true; }
    }
  }

  if (settings.failSafe) {
    if (detectorLostTabs.size > 0) { curtainReason = 'フェイルセーフ(検知不能)'; return true; }
    // 能動pingに3回連続(約30秒)失敗したwatchタブ = 監視スクリプト不在 → 隠す側に倒す
    for (const fails of pingFails.values()) {
      if (fails >= 3) { curtainReason = 'フェイルセーフ(未監視のwatchタブ)'; return true; }
    }
  }
  curtainReason = '';
  return false;
}

// ---- カーテン適用(直列化) --------------------------------------------
async function evaluate() {
  await ensureInit();
  const desired = await computeDesired();

  if (desired) {
    if (offTimer) { clearTimeout(offTimer); offTimer = null; }
    enqueueCurtain(true);
    return;
  }

  // desired === false
  if (curtainActive) {
    // 復帰ディレイ後にOFF。待機中に再ONが来たら上の分岐でoffTimerがクリアされる。
    if (!offTimer) {
      offTimer = setTimeout(async () => {
        offTimer = null;
        if (await computeDesired()) {
          enqueueCurtain(true); // 途中で再び必要になった
        } else {
          curtainWantedButFailed = false;
          enqueueCurtain(false);
        }
      }, settings.restoreDelayMs);
    }
  } else {
    // まだ張っていない/張れなかった状態。即座に整理する。
    if (offTimer) { clearTimeout(offTimer); offTimer = null; }
    if (curtainWantedButFailed) {
      curtainWantedButFailed = false;
      updateBadge();
    }
  }
}

// setCurtainの呼び出しを1本のチェーンに直列化する。
// これによりON/OFFの連打や復帰ディレイ中の再ONでも呼び出しが交錯しない。
function enqueueCurtain(targetOn) {
  curtainChain = curtainChain
    .then(() => applyCurtain(targetOn))
    .catch((e) => { lastError = e.message || String(e); updateBadge(); });
  return curtainChain;
}

async function applyCurtain(targetOn) {
  if (targetOn === curtainActive) {
    if (!targetOn) curtainWantedButFailed = false;
    return; // 変化なし
  }
  if (!obs || !obs.connected) {
    if (targetOn) {
      // 配信事故を検知したのに打つ手がない状態。可視化して再接続を促す。
      curtainWantedButFailed = true;
      updateBadge();
      scheduleReconnect();
    }
    return;
  }
  try {
    await obs.setCurtain(parseSourceNames(settings.sourceName), targetOn);
    curtainActive = targetOn;
    if (targetOn) curtainWantedButFailed = false;
    // SW再起動に備えて元状態をstorage.sessionへ退避/掃除する
    try {
      if (targetOn) await chrome.storage.session.set({ nnwSavedStates: obs.savedStates });
      else await chrome.storage.session.remove('nnwSavedStates');
    } catch { /* 無視 */ }
    updateBadge();
  } catch (e) {
    lastError = e.message || String(e);
    if (targetOn) curtainWantedButFailed = true;
    updateBadge();
  }
}

// ---- バッジ ------------------------------------------------------------
function updateBadge() {
  const connected = !!(obs && obs.connected);
  let text = '';
  let color = '#000000';
  if (curtainWantedButFailed) {
    text = '!'; color = '#d00000';          // 必要なのに打てない(未接続/失敗)= 赤!
  } else if (curtainActive) {
    text = 'AD'; color = '#d00000';          // カーテン中 = 赤AD
  } else if (settings.enabled && !connected) {
    text = '!'; color = '#e08000';           // enabledだが未接続 = オレンジ!
  }
  try {
    chrome.action.setBadgeText({ text });
    if (text) chrome.action.setBadgeBackgroundColor({ color });
  } catch { /* 無視 */ }
}

// ---- content.js からの状態受信 ----------------------------------------
function touchTab(tabId, patch) {
  if (tabId == null) return;
  const prev = tabStates.get(tabId) || { ad: false, lastSeen: 0, playerFound: false, url: '' };
  tabStates.set(tabId, { ...prev, lastSeen: Date.now(), ...patch });
}

function handleAdState(tabId, ad) {
  touchTab(tabId, { ad: !!ad });
  evaluate();
}

function handleHeartbeat(tabId, msg) {
  touchTab(tabId, { ad: !!msg.ad, playerFound: !!msg.playerFound, url: msg.url || '' });
  if (msg.playerFound) detectorLostTabs.delete(tabId); // 回復が伝わる
  evaluate();
}

function handleDetectorLost(tabId) {
  if (tabId == null) return;
  detectorLostTabs.add(tabId);
  evaluate();
}

function handlePreconsumeDone() {
  const tabId = preconsumeTabId;
  preconsumeTabId = null;
  preconsumeProgress = null;
  // 消化走破の終端でended系イベントが拾われていてもカーテンを開けるよう掃除する
  if (tabId != null) {
    const st = tabStates.get(tabId);
    if (st) st.endedHold = false;
  }
  evaluate();
}

// 動画終了: 次の動画の再生が始まるまでカーテンを閉じる(動画探し画面を配信に載せない)
function handleVideoEnded(tabId) {
  touchTab(tabId, { endedHold: true });
  evaluate();
}

// 再生開始: 広告中のplayingでなければ復帰
function handleVideoPlaying(tabId, msg) {
  if (!msg.ad) touchTab(tabId, { endedHold: false });
  evaluate();
}

// タブが閉じたら状態を除去して再判定
chrome.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  detectorLostTabs.delete(tabId);
  pingFails.delete(tabId);
  if (preconsumeTabId === tabId) { preconsumeTabId = null; preconsumeProgress = null; }
  evaluate();
});

// ---- popup / options からのコマンド ------------------------------------
async function getStatus() {
  return {
    enabled: settings.enabled,
    obsConnected: !!(obs && obs.connected),
    curtainActive,
    curtainWantedButFailed,
    curtainReason,
    preconsumeActive: preconsumeTabId != null,
    preconsumePercent: percentOf(preconsumeProgress),
    lastError,
  };
}

function percentOf(p) {
  if (!p || !p.duration || !isFinite(p.duration) || p.duration <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((p.current / p.duration) * 100)));
}

async function toggleEnabled() {
  settings.enabled = !settings.enabled;
  await chrome.storage.local.set({ enabled: settings.enabled });
  if (settings.enabled) {
    connectObs();
  } else {
    // 無効化: カーテンの復帰完了を待ってから切断する
    // (待たずに切断すると復帰コマンドが「未接続」で空振りし、隠れたままになる)
    await enqueueCurtain(false);
    reconnectObsFromScratch();
  }
  updateBadge();
  evaluate();
}

async function getActiveWatchTab() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch { /* 無視 */ }
  const tab = tabs[0];
  if (tab && tab.url && /^https:\/\/www\.youtube\.com\/watch/.test(tab.url)) return tab;
  return null;
}

async function startPreconsume() {
  const tab = await getActiveWatchTab();
  if (!tab) return { ok: false, error: 'アクティブなタブがYouTubeの動画(watch)ページではありません' };

  // 先にカーテンを閉じ、適用完了を待ってから再生を開始する。
  // (逆順だと16倍速の映像が一瞬配信に映ってしまう)
  preconsumeTabId = tab.id;
  preconsumeProgress = { current: 0, duration: 0 };
  await evaluate();
  await curtainChain.catch(() => { /* エラーはlastErrorに記録済み */ });

  const abort = (error) => {
    preconsumeTabId = null;
    preconsumeProgress = null;
    evaluate();
    return { ok: false, error };
  };

  if (!curtainActive) {
    // カーテンを閉じられないまま16倍速再生を始めるのは配信事故なので中止する
    return abort('OBSのカーテンを閉じられないため開始しません: ' + (lastError || 'OBS未接続'));
  }
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'preconsume-start' });
    if (res && res.ok === false) {
      return abort(res.error || '開始できませんでした');
    }
  } catch (e) {
    return abort('ページにメッセージを送れませんでした(ページを再読み込みしてください)');
  }
  return { ok: true };
}

async function stopPreconsume() {
  const tabId = preconsumeTabId;
  preconsumeTabId = null;
  preconsumeProgress = null;
  if (tabId != null) {
    try { await chrome.tabs.sendMessage(tabId, { type: 'preconsume-stop' }); } catch { /* 無視 */ }
  }
  evaluate();
  return { ok: true };
}

// 接続テスト: メインの接続を乱さないよう、その場限りの一時クライアントで確認する。
// 成功時はOBSに実在するソース名一覧も返す(ソース名の不一致を目で確認できるように)。
async function testConnection(msg) {
  const host = msg.host ?? settings.host;
  const port = Number(msg.port) || settings.port;
  const password = msg.password ?? settings.password;
  const tester = new ObsClient();
  try {
    await tester.connect(host, port, password);
    let version = '不明';
    let inputNames = [];
    let sceneNames = [];
    try {
      const v = await tester.request('GetVersion');
      version = v.obsVersion ? `OBS ${v.obsVersion} / websocket ${v.obsWebSocketVersion}` : '接続成功';
    } catch { /* バージョン取得失敗でも接続自体は成功 */ }
    try {
      const inputs = await tester.request('GetInputList');
      inputNames = (inputs.inputs || []).map((i) => i.inputName);
    } catch { /* 無視 */ }
    try {
      const sc = await tester.request('GetSceneList');
      sceneNames = (sc.scenes || []).map((s) => s.sceneName);
    } catch { /* 無視 */ }
    tester.close();
    return { ok: true, version, inputNames, sceneNames };
  } catch (e) {
    tester.close();
    return { ok: false, error: e.message || String(e) };
  }
}

// 手動カーテンテスト: 即座に隠し、3秒後に戻す。失敗時は理由を返す。
async function curtainTest() {
  await ensureInit();
  if (!settings.enabled) return { ok: false, error: '「有効化」がOFFです' };
  if (!obs || !obs.connected) {
    return { ok: false, error: 'OBS未接続です(接続情報と有効化を確認してください)' };
  }
  lastError = '';
  manualTestUntil = Date.now() + 3000;
  await enqueueCurtain(true);
  if (!curtainActive) {
    manualTestUntil = 0;
    return { ok: false, error: lastError || 'カーテンONに失敗しました' };
  }
  await new Promise((r) => setTimeout(r, 3000));
  manualTestUntil = 0;
  await evaluate(); // 本当に必要な状況(広告中等)でなければここで復帰する
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // どのメッセージ受信でも初期化を保証(SW復活時の設定/接続復元)
  ensureInit().then(async () => {
    const tabId = sender.tab ? sender.tab.id : null;
    switch (msg && msg.type) {
      case 'ad-state': handleAdState(tabId, msg.ad); break;
      case 'heartbeat': handleHeartbeat(tabId, msg); break;
      case 'detector-lost': handleDetectorLost(tabId); break;
      case 'video-ended': handleVideoEnded(tabId); break;
      case 'video-playing': handleVideoPlaying(tabId, msg); break;
      case 'preconsume-progress':
        preconsumeProgress = { current: msg.current, duration: msg.duration };
        break;
      case 'preconsume-done': handlePreconsumeDone(); break;

      case 'get-status': sendResponse(await getStatus()); return;
      case 'toggle-enabled': await toggleEnabled(); sendResponse(await getStatus()); return;
      case 'preconsume-start': sendResponse(await startPreconsume()); return;
      case 'preconsume-stop': sendResponse(await stopPreconsume()); return;
      case 'test-connection': sendResponse(await testConnection(msg)); return;
      case 'curtain-test': sendResponse(await curtainTest()); return;
      default: break;
    }
    // 通知系(ad-state等)にも空応答を返し、送信側のPromiseを解決させる
    sendResponse({ ok: true });
  });
  return true; // 非同期応答のためチャネルを開いたままにする
});
