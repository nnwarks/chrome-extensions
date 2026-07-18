// コメントシーク for YouTube Live - options.js
// 「何秒前に飛ぶか」の設定を storage.sync に読み書きする。
(function () {
  "use strict";

  var DEFAULT_OFFSET_SEC = 5;
  var MIN_SEC = 0;
  var MAX_SEC = 60;

  var input = document.getElementById("seekOffsetSec");
  var saveBtn = document.getElementById("save");
  var status = document.getElementById("status");

  // 0〜60の整数にクランプする。
  function clampSec(value) {
    var n = Math.round(Number(value));
    if (!isFinite(n)) {
      n = DEFAULT_OFFSET_SEC;
    }
    if (n < MIN_SEC) {
      n = MIN_SEC;
    }
    if (n > MAX_SEC) {
      n = MAX_SEC;
    }
    return n;
  }

  // 保存済みの値を読み込んで入力欄へ反映。
  function restore() {
    chrome.storage.sync.get({ seekOffsetSec: DEFAULT_OFFSET_SEC }, function (items) {
      input.value = clampSec(items.seekOffsetSec);
    });
  }

  function showStatus(msg) {
    status.textContent = msg;
    setTimeout(function () {
      status.textContent = "";
    }, 1500);
  }

  function save() {
    var value = clampSec(input.value);
    input.value = value;
    chrome.storage.sync.set({ seekOffsetSec: value }, function () {
      showStatus("保存しました");
    });
  }

  saveBtn.addEventListener("click", save);
  document.addEventListener("DOMContentLoaded", restore);
  // options_uiは開くたびにDOMを読み込むが、既にDOMContentLoaded済みの場合にも対応。
  if (document.readyState !== "loading") {
    restore();
  }
})();
