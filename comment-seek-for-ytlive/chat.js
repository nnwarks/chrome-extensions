// コメントシーク for YouTube Live - chat.js (チャットリプレイのiframe側)
//
// チャットリプレイのiframe内で動作する。各コメントに「少し前へジャンプ」ボタンを注入し、
// クリック時に window.parent.postMessage でトップフレーム(player.js)へ移動先の秒数を送る。
//
// v1.0.3:
// - 監視対象を特定のチャットリスト要素から文書全体に変更。
//   「上位チャットのリプレイ⇔チャットのリプレイ」切替でリストごと作り直されても
//   ボタン注入が途切れない(旧方式は切離された古い要素を監視し続けていた)
// - 注入済み判定を「data属性の印」から「ボタンの実在」に変更し、
//   ジャンプ先の秒数はクリック時点のタイムスタンプから読む。
//   YouTubeはチャット要素をリサイクル(同じDOM要素の中身だけ差替え)するため、
//   印や事前計算した秒数は実態とズレることがある
(function () {
  "use strict";

  // トップフレーム(watchページ)以外、つまりiframe内でのみ動く想定。
  if (window.top === window.self) {
    return;
  }

  var TARGET_ORIGIN = "https://www.youtube.com";
  var DEFAULT_OFFSET_SEC = 5;

  // storage.syncから取得したオフセット秒。onChangedで即時更新する。
  var seekOffsetSec = DEFAULT_OFFSET_SEC;

  // ---- オフセット秒の読み込みと変更監視 ----
  function loadOffset() {
    try {
      chrome.storage.sync.get({ seekOffsetSec: DEFAULT_OFFSET_SEC }, function (items) {
        var v = Number(items && items.seekOffsetSec);
        if (isFinite(v) && v >= 0) {
          seekOffsetSec = v;
        }
      });
    } catch (e) {
      // storageが使えない環境では既定値のまま動作させる。
    }
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== "sync") {
        return;
      }
      if (changes && changes.seekOffsetSec) {
        var v = Number(changes.seekOffsetSec.newValue);
        if (isFinite(v) && v >= 0) {
          seekOffsetSec = v;
        }
      }
    });
  } catch (e) {
    // 監視できなくても致命的ではない。
  }

  loadOffset();

  // ---- タイムスタンプ文字列を秒に変換 ----
  // "1:23:45"(h:m:s) / "12:34"(m:s) / "-0:05"(負値) などに対応。
  function parseTimestampToSeconds(text) {
    if (!text) {
      return null;
    }
    var trimmed = String(text).trim();
    if (!trimmed) {
      return null;
    }
    var negative = false;
    if (trimmed.charAt(0) === "-") {
      negative = true;
      trimmed = trimmed.slice(1);
    } else if (trimmed.charAt(0) === "+") {
      trimmed = trimmed.slice(1);
    }

    var parts = trimmed.split(":");
    if (parts.length < 2 || parts.length > 3) {
      return null;
    }

    var total = 0;
    for (var i = 0; i < parts.length; i++) {
      var n = parseInt(parts[i], 10);
      if (isNaN(n)) {
        return null;
      }
      total = total * 60 + n;
    }

    return negative ? -total : total;
  }

  // ---- ボタンのクリック処理 ----
  function onSeekClick(event, itemEl) {
    // チャット側UI(メニュー展開など)の反応を抑止する。
    event.preventDefault();
    event.stopPropagation();

    // クリック時点のタイムスタンプを読む。要素リサイクルで中身が別コメントに
    // 差し替わっていても、常に「いま表示されているコメント」の時刻に飛べる。
    var timestampEl = itemEl.querySelector("#timestamp");
    var seconds = timestampEl ? parseTimestampToSeconds(timestampEl.textContent) : null;
    if (seconds === null) {
      return;
    }

    var target = seconds - seekOffsetSec;
    if (target < 0) {
      target = 0;
    }

    try {
      window.parent.postMessage(
        { nnwCommentSeek: true, seconds: target },
        TARGET_ORIGIN
      );
    } catch (e) {
      // postMessageに失敗しても静かに無視する。
    }
  }

  // ---- 1つのメッセージ要素にボタンを注入 ----
  function injectButton(itemEl) {
    if (!itemEl || itemEl.nodeType !== 1) {
      return;
    }
    // 注入済み判定はボタンの実在で行う(リサイクルでボタンだけ消えても再注入できる)。
    if (itemEl.querySelector(".nnw-seek-btn")) {
      return;
    }

    var timestampEl = itemEl.querySelector("#timestamp");
    if (!timestampEl) {
      return;
    }
    if (parseTimestampToSeconds(timestampEl.textContent) === null) {
      return; // 時刻が読めないものにはボタンを付けない
    }

    var btn = document.createElement("button");
    btn.className = "nnw-seek-btn";
    btn.title = "このコメントの少し前へジャンプ";
    btn.textContent = "⏪";
    btn.type = "button";

    btn.addEventListener("click", function (event) {
      onSeekClick(event, itemEl);
    });
    // mousedownでもstopPropagationし、チャット側のホバー/クリック処理を抑止。
    btn.addEventListener("mousedown", function (event) {
      event.stopPropagation();
    });

    // timestampの近く(同じ親のインライン位置)にボタンを置く。
    var parent = timestampEl.parentNode;
    if (parent) {
      if (timestampEl.nextSibling) {
        parent.insertBefore(btn, timestampEl.nextSibling);
      } else {
        parent.appendChild(btn);
      }
    } else {
      itemEl.appendChild(btn);
    }
  }

  // ---- 追加された要素からメッセージ系アイテムを拾ってボタン注入 ----
  function processNode(node) {
    if (!node || node.nodeType !== 1) {
      return;
    }

    // node自身が#timestamp要素そのものの場合(まれ)は、そのアイテム祖先を処理する。
    if (node.id === "timestamp") {
      var selfItem = findItemAncestor(node);
      if (selfItem) {
        injectButton(selfItem);
      }
      return;
    }

    // 子孫に含まれる #timestamp を持つアイテム群を処理する。
    if (node.querySelectorAll) {
      var stamps = node.querySelectorAll("#timestamp");
      for (var i = 0; i < stamps.length; i++) {
        var itemEl = findItemAncestor(stamps[i]);
        if (itemEl) {
          injectButton(itemEl);
        }
      }
    }
  }

  // #timestamp要素から、注入対象となる「アイテム要素」を探す。
  // タグ名が yt-live-chat-*-renderer のものをアイテムとみなす。
  function findItemAncestor(stampEl) {
    var el = stampEl.parentElement;
    var fallback = stampEl.parentElement;
    var depth = 0;
    while (el && depth < 12) {
      var tag = el.tagName ? el.tagName.toLowerCase() : "";
      if (tag.indexOf("yt-live-chat-") === 0 && tag.indexOf("-renderer") !== -1) {
        return el;
      }
      el = el.parentElement;
      depth++;
    }
    return fallback;
  }

  // ---- 監視 ----
  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var added = mutations[i].addedNodes;
      for (var j = 0; j < added.length; j++) {
        processNode(added[j]);
      }
    }
  });

  function startObserving() {
    var target = document.documentElement || document.body;
    if (!target) {
      setTimeout(startObserving, 500);
      return;
    }
    // チャット切替(上位チャット⇔すべてのチャット)でリストごと作り直されても
    // 観測が途切れないよう、特定のリスト要素ではなく文書全体を監視する。
    processNode(target);
    observer.observe(target, { childList: true, subtree: true });

    // 保険: 切替直後やリサイクルで漏れたアイテムを定期的に拾い直す。
    // 表示中のアイテムは高々数十件なので走査コストはごく小さい。
    setInterval(function () {
      processNode(document.documentElement);
    }, 2000);
  }

  startObserving();
})();
