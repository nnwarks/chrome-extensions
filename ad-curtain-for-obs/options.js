// options.js — 設定の読み書きと接続テスト
// 保存先は chrome.storage.local(パスワードを含むため sync にはしない)。
// background.js が storage.onChanged で変更を検知して接続を作り直す。

(function () {
  'use strict';

  const DEFAULTS = {
    enabled: false,
    host: '127.0.0.1',
    port: 4455,
    password: '',
    sourceName: '',
    restoreDelayMs: 300,
    failSafe: true,
    hideAfterEnded: true,
  };

  const el = (id) => document.getElementById(id);
  const hostEl = el('host');
  const portEl = el('port');
  const passwordEl = el('password');
  const sourceNameEl = el('sourceName');
  const restoreDelayEl = el('restoreDelayMs');
  const failSafeEl = el('failSafe');
  const hideAfterEndedEl = el('hideAfterEnded');
  const resultEl = el('result');

  function showResult(msg, ok) {
    resultEl.textContent = msg;
    resultEl.className = ok ? 'ok' : 'bad';
  }

  function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function readForm() {
    return {
      host: hostEl.value.trim() || DEFAULTS.host,
      port: clampInt(portEl.value, 1, 65535, DEFAULTS.port),
      password: passwordEl.value,
      sourceName: sourceNameEl.value.trim(),
      restoreDelayMs: clampInt(restoreDelayEl.value, 0, 5000, DEFAULTS.restoreDelayMs),
      failSafe: failSafeEl.checked,
      hideAfterEnded: hideAfterEndedEl.checked,
      muteAlso: false, // 廃止した設定を明示的に無効化(旧バージョンの保存値の掃除)
    };
  }

  async function restore() {
    const items = await chrome.storage.local.get(DEFAULTS);
    hostEl.value = items.host;
    portEl.value = items.port;
    passwordEl.value = items.password;
    sourceNameEl.value = items.sourceName;
    restoreDelayEl.value = items.restoreDelayMs;
    failSafeEl.checked = !!items.failSafe;
    hideAfterEndedEl.checked = !!items.hideAfterEnded;
  }

  el('save').addEventListener('click', async () => {
    const values = readForm();
    if (!values.sourceName) {
      showResult('OBSソース名を入力してください。', false);
      return;
    }
    await chrome.storage.local.set(values);
    showResult('保存しました。', true);
  });

  el('test').addEventListener('click', async () => {
    showResult('接続テスト中…', true);
    const values = readForm();
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'test-connection',
        host: values.host,
        port: values.port,
        password: values.password,
      });
      if (res && res.ok) {
        let msg = `接続成功: ${res.version}`;
        if (res.inputNames && res.inputNames.length) {
          msg += `\nOBSにあるソース名: ${res.inputNames.join(' / ')}`;
          msg += '\n↑この中から正確にコピーして「OBSソース名」に入力してください。';
        }
        showResult(msg, true);
      } else {
        showResult(`接続失敗: ${res && res.error ? res.error : '不明なエラー'}`, false);
      }
    } catch (e) {
      showResult(`接続失敗: ${e.message || e}`, false);
    }
  });

  restore();
})();
