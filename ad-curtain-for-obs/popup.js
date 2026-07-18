// popup.js — 状態表示と操作(有効化トグル/事前消化の開始・中止/設定を開く)

(function () {
  'use strict';

  const enabledEl = document.getElementById('enabled');
  const obsDot = document.getElementById('obs-dot');
  const obsText = document.getElementById('obs-text');
  const stateDot = document.getElementById('state-dot');
  const stateText = document.getElementById('state-text');
  const errorText = document.getElementById('error-text');
  const preconsumeBtn = document.getElementById('preconsume-btn');
  const curtainTestBtn = document.getElementById('curtain-test-btn');
  const openOptions = document.getElementById('open-options');

  const tabDot = document.getElementById('tab-dot');
  const tabText = document.getElementById('tab-text');

  let lastStatus = null;   // 直近のget-status結果
  let curtainTestRunning = false;
  let activeIsWatch = false; // アクティブタブがYouTubeのwatchページか
  let activeIsYouTube = false;
  let tabPing = null;      // アクティブタブのcontent scriptからの応答

  function sendMessage(msg) {
    return chrome.runtime.sendMessage(msg).catch(() => null);
  }

  function render(status) {
    if (!status) {
      obsText.textContent = 'OBS: 拡張機能と通信できません';
      obsDot.className = 'dot bad';
      return;
    }
    lastStatus = status;
    enabledEl.checked = !!status.enabled;

    // OBS接続状態
    if (!status.enabled) {
      obsDot.className = 'dot';
      obsText.textContent = 'OBS: 無効化中';
    } else if (status.obsConnected) {
      obsDot.className = 'dot ok';
      obsText.textContent = 'OBS: 接続中';
    } else {
      obsDot.className = 'dot warn';
      obsText.textContent = 'OBS: 未接続(再接続中…)';
    }

    // 動作状態
    if (!status.enabled) {
      stateDot.className = 'dot';
      stateText.textContent = '状態: 停止中';
    } else if (status.curtainWantedButFailed) {
      stateDot.className = 'dot bad';
      stateText.textContent = '状態: カーテン必要だがOBSを操作できません!';
    } else if (status.preconsumeActive) {
      stateDot.className = 'dot warn';
      stateText.textContent = `状態: 事前消化中 ${status.preconsumePercent}%(カーテン中)`;
    } else if (status.curtainActive) {
      stateDot.className = 'dot warn';
      stateText.textContent = `状態: カーテン中(${status.curtainReason || '広告検知'})`;
    } else {
      stateDot.className = 'dot ok';
      stateText.textContent = '状態: 監視中(広告なし)';
    }

    // アクティブタブの監視スクリプト状態
    if (!activeIsYouTube) {
      tabDot.className = 'dot';
      tabText.textContent = 'このタブ: YouTubeではありません';
    } else if (tabPing && tabPing.ok) {
      tabDot.className = 'dot ok';
      tabText.textContent = tabPing.ad
        ? 'このタブ: 監視中(広告再生中)'
        : 'このタブ: 監視中';
    } else {
      tabDot.className = 'dot bad';
      tabText.textContent = 'このタブ: 監視未動作(タブを再読み込みしてください)';
    }

    // エラー表示
    if (status.lastError) {
      errorText.hidden = false;
      errorText.textContent = status.lastError;
    } else {
      errorText.hidden = true;
    }

    // カーテン動作テストボタン(OBS接続中のみ)
    curtainTestBtn.disabled = !(status.enabled && status.obsConnected) || curtainTestRunning;

    // 事前消化ボタン
    if (status.preconsumeActive) {
      preconsumeBtn.textContent = '事前消化を中止';
      preconsumeBtn.className = 'stop';
      preconsumeBtn.disabled = false;
    } else {
      preconsumeBtn.textContent = '事前消化を開始';
      preconsumeBtn.className = '';
      preconsumeBtn.disabled = !status.enabled || !activeIsWatch;
      preconsumeBtn.title = activeIsWatch ? '' : 'アクティブタブがYouTubeの動画ページのときに使えます';
    }
  }

  async function refresh() {
    // アクティブタブの種別と監視スクリプトの生存を確認
    tabPing = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      const url = tab && tab.url ? tab.url : '';
      activeIsYouTube = /^https:\/\/www\.youtube\.com\//.test(url);
      activeIsWatch = /^https:\/\/www\.youtube\.com\/watch/.test(url);
      if (activeIsYouTube && tab) {
        tabPing = await chrome.tabs.sendMessage(tab.id, { type: 'content-ping' }).catch(() => null);
      }
    } catch {
      activeIsYouTube = false;
      activeIsWatch = false;
    }

    const status = await sendMessage({ type: 'get-status' });
    render(status);
  }

  enabledEl.addEventListener('change', async () => {
    const status = await sendMessage({ type: 'toggle-enabled' });
    render(status);
  });

  preconsumeBtn.addEventListener('click', async () => {
    preconsumeBtn.disabled = true;
    if (lastStatus && lastStatus.preconsumeActive) {
      await sendMessage({ type: 'preconsume-stop' });
    } else {
      const res = await sendMessage({ type: 'preconsume-start' });
      if (res && !res.ok && res.error) {
        errorText.hidden = false;
        errorText.textContent = res.error;
      }
    }
    refresh();
  });

  curtainTestBtn.addEventListener('click', async () => {
    curtainTestRunning = true;
    curtainTestBtn.disabled = true;
    curtainTestBtn.textContent = 'テスト中…(3秒)';
    errorText.hidden = true;
    const res = await sendMessage({ type: 'curtain-test' });
    curtainTestRunning = false;
    curtainTestBtn.textContent = 'カーテン動作テスト(3秒)';
    if (res && res.ok) {
      errorText.hidden = false;
      errorText.style.color = 'var(--ok)';
      errorText.textContent = 'テスト成功: ソースが隠れて復帰しました';
    } else {
      errorText.hidden = false;
      errorText.style.color = '';
      errorText.textContent = 'テスト失敗: ' + (res && res.error ? res.error : '応答がありません');
    }
    refresh();
  });

  openOptions.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  refresh();
  // ポップアップを開いている間は1秒ごとに状態を更新する
  setInterval(refresh, 1000);
})();
