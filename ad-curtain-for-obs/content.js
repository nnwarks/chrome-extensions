// content.js — YouTubeページ側(isolated world)
// 広告状態の検知・ハートビート・検知喪失通知と、「事前消化モード」の実行を担当する。
// 広告のブロック・スキップは一切しない。スキップボタンには触れない。

(function () {
  'use strict';

  // SPA遷移や再注入で多重初期化しない
  if (window.__nnwAdCurtainInstalled) return;
  window.__nnwAdCurtainInstalled = true;

  const PRECONSUME_RATE = 16; // 事前消化時の本編再生速度

  let player = null;          // #movie_player 要素
  let classObserver = null;   // class属性の監視
  let lastAd = false;         // 直近の広告状態(変化検出用)
  let lostSince = null;       // /watchなのにプレイヤーが見つからなくなった時刻
  let lostReported = false;   // detector-lost送信済みフラグ

  let preconsume = false;         // 事前消化モード中か
  let pendingSeekToZero = false;  // 広告中に開始した場合、広告明けに先頭へシークする
  let progressTimer = null;

  // ---- ユーティリティ ----------------------------------------------------

  function getVideo() {
    return (
      document.querySelector('video.html5-main-video') ||
      document.querySelector('#movie_player video')
    );
  }

  function isAdNow() {
    if (!player || !player.isConnected) return false;
    const cl = player.classList;
    return cl.contains('ad-showing') || cl.contains('ad-interrupting');
  }

  // SWへの送信。SW起動直後などの失敗時は1秒後に1回だけ再送する。
  function send(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {
        setTimeout(() => {
          try { chrome.runtime.sendMessage(msg).catch(() => { /* 諦める */ }); } catch { /* 無視 */ }
        }, 1000);
      });
    } catch { /* 拡張コンテキスト破棄時など。無視 */ }
  }

  // ---- 広告状態の検知 ------------------------------------------------------

  function onAdChange(ad) {
    if (ad === lastAd) return;
    lastAd = ad;
    send({ type: 'ad-state', ad });

    if (preconsume) {
      applyPreconsumeRate();
      // 広告中に事前消化を開始していた場合、広告明けに先頭からやり直す
      if (!ad && pendingSeekToZero) {
        pendingSeekToZero = false;
        const v = getVideo();
        if (v) { try { v.currentTime = 0; } catch { /* 無視 */ } }
      }
    }
  }

  function attachPlayer(p) {
    if (classObserver) { classObserver.disconnect(); classObserver = null; }
    player = p;
    classObserver = new MutationObserver(() => onAdChange(isAdNow()));
    classObserver.observe(p, { attributes: true, attributeFilter: ['class'] });
    onAdChange(isAdNow()); // 現時点の状態を即通知
  }

  function isWatchPage() {
    return location.pathname === '/watch' || location.pathname.startsWith('/watch');
  }

  // ---- 動画終了/再生開始の検知(動画探し中の画面を配信に載せないための情報) ----
  let videoEl = null; // ended/playingリスナーを張ったvideo要素

  function onVideoEnded() {
    if (preconsume) return; // 事前消化の走破終端は対象外(SW側でも掃除する)
    if (isAdNow()) return;  // 広告素材のendedは無視
    send({ type: 'video-ended' });
  }
  function onVideoPlaying() {
    send({ type: 'video-playing', ad: isAdNow() });
  }
  function attachVideo() {
    const v = getVideo();
    if (!v || v === videoEl) return;
    if (videoEl) {
      videoEl.removeEventListener('ended', onVideoEnded);
      videoEl.removeEventListener('playing', onVideoPlaying);
    }
    videoEl = v;
    v.addEventListener('ended', onVideoEnded);
    v.addEventListener('playing', onVideoPlaying);
  }

  function findPlayer() {
    attachVideo();
    const p = document.getElementById('movie_player');
    if (p) {
      if (p !== player) attachPlayer(p);
      lostSince = null;
      lostReported = false;
      return;
    }
    if (isWatchPage()) {
      // /watchなのにプレイヤーが10秒以上見つからない → 検知喪失(隠す側に倒す)
      if (lostSince == null) {
        lostSince = Date.now();
      } else if (!lostReported && Date.now() - lostSince > 10000) {
        lostReported = true;
        send({ type: 'detector-lost' });
      }
    } else {
      lostSince = null;
      lostReported = false;
    }
  }

  // SPAなので定期再探索+遷移イベントの両方で追う
  setInterval(findPlayer, 2000);
  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(findPlayer, 0);
    // ページ遷移したら事前消化は打ち切る(対象動画が変わるため)
    if (preconsume) {
      stopPreconsumeCore(getVideo());
      send({ type: 'preconsume-done' });
    }
  });
  findPlayer();

  // ---- ハートビート --------------------------------------------------------

  function sendHeartbeat() {
    send({
      type: 'heartbeat',
      url: location.href,
      playerFound: !!(player && player.isConnected),
      ad: isAdNow(),
    });
  }
  setInterval(sendHeartbeat, 10000);
  sendHeartbeat(); // 起動直後にも1回送り、SW側の猶予期間を早く解除する

  // ---- 事前消化モード ------------------------------------------------------
  // 本編だけを16倍速・ミュートで走破して広告枠を先に消化する。
  // 広告中は等速に戻す(広告は普通に完全再生される)。スキップは自動で押さない。

  function applyPreconsumeRate() {
    if (!preconsume) return;
    const v = getVideo();
    if (!v) return;
    try { v.playbackRate = isAdNow() ? 1 : PRECONSUME_RATE; } catch { /* 無視 */ }
  }

  // YouTubeが勝手にレートを戻すことがあるため、消化中は16へ戻す
  function onRateChange() {
    if (!preconsume || isAdNow()) return;
    const v = getVideo();
    if (v && v.playbackRate !== PRECONSUME_RATE) {
      try { v.playbackRate = PRECONSUME_RATE; } catch { /* 無視 */ }
    }
  }

  function onTimeUpdate() { maybeFinish(false); }
  function onEnded() { maybeFinish(true); }

  function maybeFinish(ended) {
    // durationやendedは広告中は信用しない(広告素材のものを拾うため)
    if (!preconsume || isAdNow()) return;
    const v = getVideo();
    if (!v) return;
    const d = v.duration;
    if (ended || (isFinite(d) && d > 0 && v.currentTime >= d - 0.5)) {
      // 走破完了: 先頭に戻して停止し、通常状態へ復帰
      stopPreconsumeCore(v);
      try { v.currentTime = 0; v.pause(); } catch { /* 無視 */ }
      send({ type: 'preconsume-done' });
    }
  }

  function startPreconsume() {
    const v = getVideo();
    if (!v) return { ok: false, error: '動画プレイヤーが見つかりません' };
    if (preconsume) return { ok: true }; // すでに実行中

    preconsume = true;
    pendingSeekToZero = false;
    v.addEventListener('ratechange', onRateChange);
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('ended', onEnded);

    try {
      if (isAdNow()) {
        // 広告再生中に開始した場合、シークすると広告側を触ってしまうので
        // 広告明けに先頭へシークする(広告は等速のまま流し切る)
        pendingSeekToZero = true;
      } else {
        v.currentTime = 0;
      }
      v.muted = true;
      v.playbackRate = isAdNow() ? 1 : PRECONSUME_RATE;
      const p = v.play();
      if (p && typeof p.catch === 'function') p.catch(() => { /* 自動再生拒否等は無視 */ });
    } catch { /* 無視 */ }

    if (progressTimer) clearInterval(progressTimer);
    progressTimer = setInterval(() => {
      if (!preconsume || isAdNow()) return;
      const vv = getVideo();
      if (!vv) return;
      send({
        type: 'preconsume-progress',
        current: vv.currentTime || 0,
        duration: isFinite(vv.duration) ? vv.duration : 0,
      });
    }, 5000);

    return { ok: true };
  }

  // 消化の中断/終了処理(位置は動かさない)。復帰: 等速・ミュート解除。
  function stopPreconsumeCore(v) {
    preconsume = false;
    pendingSeekToZero = false;
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    if (v) {
      v.removeEventListener('ratechange', onRateChange);
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('ended', onEnded);
      try { v.playbackRate = 1; v.muted = false; } catch { /* 無視 */ }
    }
  }

  // ---- SW/popupからのコマンド受信 -----------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return;
    if (msg.type === 'preconsume-start') {
      sendResponse(startPreconsume());
    } else if (msg.type === 'preconsume-stop') {
      stopPreconsumeCore(getVideo());
      sendResponse({ ok: true });
    } else if (msg.type === 'content-ping') {
      // popupからの疎通確認: このタブで監視スクリプトが生きているか
      sendResponse({
        ok: true,
        playerFound: !!(player && player.isConnected),
        ad: isAdNow(),
      });
    }
  });
})();
