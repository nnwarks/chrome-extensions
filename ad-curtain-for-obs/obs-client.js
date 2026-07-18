// obs-client.js — obs-websocket v5 プロトコル最小クライアント
// 「広告カーテン for OBS」のコア部品。認証ハンドシェイクと、
// 元の表示状態を保存してから隠す/戻すソース制御を担当する。
// ※このファイルは設計担当が実装・検証済み。仕様変更が必要な場合を除き編集しないこと。

const OP = { HELLO: 0, IDENTIFY: 1, IDENTIFIED: 2, EVENT: 5, REQUEST: 6, RESPONSE: 7 };

function b64(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

// obs-websocket v5 の認証は sha256 を2段重ねて base64 する
async function sha256b64(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return b64(buf);
}

export class ObsRequestError extends Error {
  constructor(requestType, status) {
    super(`OBSリクエスト失敗: ${requestType} (code=${status?.code}) ${status?.comment ?? ''}`);
    this.name = 'ObsRequestError';
    this.code = status?.code;
    this.requestType = requestType;
  }
}

export class ObsClient {
  constructor() {
    this.ws = null;
    this.identified = false;
    this.pending = new Map(); // requestId -> {resolve, reject}
    this.reqSeq = 0;
    this.savedStates = null;  // カーテンON時に保存した元状態
    this.onClose = null;      // (CloseEvent) => void 切断通知(再接続は呼び出し側の責務)
  }

  get connected() {
    return this.identified && this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** 接続して Identify 完了まで待つ。失敗時は reject */
  connect(host, port, password) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      const fail = (err) => {
        if (!settled) { settled = true; reject(err); }
        try { ws.close(); } catch { /* 無視 */ }
      };
      try {
        ws = new WebSocket(`ws://${host}:${port}`);
      } catch (e) { reject(e); return; }
      this.ws = ws;
      this.identified = false;

      const timer = setTimeout(() => fail(new Error('OBS接続タイムアウト(8秒)')), 8000);

      ws.onerror = () => fail(new Error('OBSに接続できません(WebSocketエラー)'));

      ws.onclose = (ev) => {
        clearTimeout(timer);
        this.identified = false;
        for (const p of this.pending.values()) p.reject(new Error('OBS接続が切断されました'));
        this.pending.clear();
        if (!settled) {
          settled = true;
          // 認証失敗時は code 4009 (AuthenticationFailed) で閉じられる
          const hint = ev.code === 4009 ? ' パスワードが違います' : '';
          reject(new Error(`OBS接続が閉じられました (code=${ev.code})${hint}`));
        }
        if (this.onClose) this.onClose(ev);
      };

      ws.onmessage = async (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        const { op, d } = msg;
        if (op === OP.HELLO) {
          const identify = { rpcVersion: 1, eventSubscriptions: 0 };
          if (d.authentication) {
            if (!password) return fail(new Error('OBS側で認証が有効です。設定画面でパスワードを入力してください'));
            const { challenge, salt } = d.authentication;
            const secret = await sha256b64(password + salt);
            identify.authentication = await sha256b64(secret + challenge);
          }
          ws.send(JSON.stringify({ op: OP.IDENTIFY, d: identify }));
        } else if (op === OP.IDENTIFIED) {
          clearTimeout(timer);
          this.identified = true;
          if (!settled) { settled = true; resolve(); }
        } else if (op === OP.RESPONSE) {
          const p = this.pending.get(d.requestId);
          if (!p) return;
          this.pending.delete(d.requestId);
          if (d.requestStatus && d.requestStatus.result) p.resolve(d.responseData ?? {});
          else p.reject(new ObsRequestError(d.requestType, d.requestStatus));
        }
      };
    });
  }

  close() {
    try { this.ws?.close(); } catch { /* 無視 */ }
  }

  /** 低レベルリクエスト送信 */
  request(requestType, requestData = {}) {
    if (!this.connected) return Promise.reject(new Error('OBS未接続'));
    const requestId = String(++this.reqSeq);
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.ws.send(JSON.stringify({ op: OP.REQUEST, d: { requestType, requestId, requestData } }));
    });
  }

  /** キープアライブ兼疎通確認(Service Workerの延命にも使う) */
  ping() {
    return this.request('GetVersion');
  }

  /**
   * カーテン制御: 指定名のソース群(配列)を全シーンで隠す(hidden=true)/元に戻す(false)。
   * - 隠す前に各シーンでの表示状態とミュート状態を保存する
   * - 戻すときは保存した状態へ戻す(元から非表示だったものは非表示のまま)
   * - 隠した状態で再度 hide が来ても二重保存しない(冪等)
   * - 映像用+音声用など複数ソースをまとめて対象にできる
   *   (音声もシーン内ソースなら非表示で音が止まる。ミキサーのミュートは操作しない)
   * - ソースがグループ内にある場合は見つけられない制約あり(READMEに記載すること)
   */
  async setCurtain(sourceNames, hidden) {
    const names = (Array.isArray(sourceNames) ? sourceNames : [sourceNames])
      .filter((n) => typeof n === 'string' && n.length > 0);
    if (hidden) {
      if (this.savedStates) return; // すでにカーテン中。二重保存を防ぐ
      const saved = { names, items: [] };
      const { scenes } = await this.request('GetSceneList');
      for (const scene of scenes ?? []) {
        const sceneName = scene.sceneName;
        for (const sourceName of names) {
          let sceneItemId;
          try {
            ({ sceneItemId } = await this.request('GetSceneItemId', { sceneName, sourceName }));
          } catch { continue; } // このシーンには無い
          const { sceneItemEnabled } = await this.request('GetSceneItemEnabled', { sceneName, sceneItemId });
          saved.items.push({ sceneName, sceneItemId, wasEnabled: sceneItemEnabled });
          if (sceneItemEnabled) {
            await this.request('SetSceneItemEnabled', { sceneName, sceneItemId, sceneItemEnabled: false });
          }
        }
      }
      this.savedStates = saved;
      if (saved.items.length === 0) {
        this.savedStates = null;
        throw new Error(`ソース「${names.join('、')}」がどのシーンにも見つかりません(グループ内のソースは指定できません。グループ名を指定してください)`);
      }
    } else {
      const saved = this.savedStates;
      this.savedStates = null;
      if (!saved) return;
      for (const it of saved.items) {
        if (!it.wasEnabled) continue; // 元から非表示だったものは触らない
        try {
          await this.request('SetSceneItemEnabled', {
            sceneName: it.sceneName, sceneItemId: it.sceneItemId, sceneItemEnabled: true,
          });
        } catch { /* シーンが削除された等は無視 */ }
      }
      // 旧バージョン(〜v1.2)がミュートしたまま残した記録があれば戻す(保険)
      for (const m of saved.mutes ?? []) {
        if (m.wasMuted) continue;
        try { await this.request('SetInputMute', { inputName: m.inputName, inputMuted: false }); } catch { /* 無視 */ }
      }
    }
  }
}
