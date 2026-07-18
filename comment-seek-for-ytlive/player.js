// コメントシーク for YouTube Live - player.js (watchページのトップフレーム側)
//
// チャットリプレイのiframeから postMessage で送られてきた秒数を受け取り、
// 動画の再生位置を移動して再生する。
//
// v1.0.2: メインワールド(world:"MAIN")で実行し、YouTube本体のプレイヤーAPI
// (movie_player.seekTo)を使う方式に変更。
// 理由: ページ内には本体プレイヤー以外のvideo要素(サムネイルのホバープレビュー等)が
// 存在することがあり、document全体からvideo.html5-main-videoを探す旧方式は
// ブラウジング経路によって別のvideo要素を掴んで空振りしていた。
// seekToはプレイヤーの内部状態・シークバーUIも含めて正しく更新する。
(function () {
  'use strict';

  var TRUSTED_ORIGIN = 'https://www.youtube.com';

  // SPA遷移(watch→watch)でこのスクリプトが再評価されてもリスナーが
  // 多重登録されないよう、windowにフラグを立てて一度だけ登録する。
  if (window.__nnwCommentSeekPlayerInstalled) {
    return;
  }
  window.__nnwCommentSeekPlayerInstalled = true;

  function doSeek(seconds) {
    // 最優先: 本体プレイヤーAPI。UI・内部状態も含めて正しく追従する
    var p = document.getElementById('movie_player');
    if (p && typeof p.seekTo === 'function') {
      try {
        p.seekTo(seconds, true);
        if (typeof p.playVideo === 'function') {
          p.playVideo();
        }
        return;
      } catch (e) { /* フォールバックへ */ }
    }

    // フォールバック: 本体プレイヤー(#movie_player)配下のvideoに限定して探す。
    // document全体から探すとホバープレビュー等の別videoを掴む恐れがある。
    var video =
      document.querySelector('#movie_player video.html5-main-video') ||
      document.querySelector('#movie_player video') ||
      document.querySelector('video.html5-main-video');
    if (!video) {
      return; // 動画が見つからない場合は静かに無視する
    }
    try {
      video.currentTime = seconds;
      var playPromise = video.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(function () {});
      }
    } catch (e) { /* 静かに無視 */ }
  }

  function onMessage(event) {
    // 送信元オリジンとメッセージ形式を厳密に検証する。
    if (event.origin !== TRUSTED_ORIGIN) {
      return;
    }
    var data = event.data;
    if (!data || data.nnwCommentSeek !== true) {
      return;
    }
    var seconds = Number(data.seconds);
    if (!isFinite(seconds) || seconds < 0) {
      return;
    }
    doSeek(seconds);
  }

  window.addEventListener('message', onMessage, false);
})();
