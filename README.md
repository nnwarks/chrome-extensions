# nnwarks Chrome拡張機能

配信者向けChrome拡張機能のソースコード公開リポジトリです。

| 拡張機能 | 説明 | インストール |
|---|---|---|
| **広告カーテン for OBS** | YouTube同時視聴配信で、広告の再生中だけOBSのソースを自動非表示にして広告を配信に載せない(広告のブロックはしません) | [Chromeウェブストア](https://chromewebstore.google.com/detail/%E5%BA%83%E5%91%8A%E3%82%AB%E3%83%BC%E3%83%86%E3%83%B3-for-obs/hpklkfhdanbnjcjplgdacgdehhnjmimp) |
| **コメントシーク for YouTube Live** | ライブ配信アーカイブのチャットリプレイに、各コメントの投稿時刻へジャンプするボタンを追加 | [Chromeウェブストア](https://chromewebstore.google.com/detail/%E3%82%B3%E3%83%A1%E3%83%B3%E3%83%88%E3%82%B7%E3%83%BC%E3%82%AF-for-youtube-live/bjdklniapkmcclhjhoogpckhhfonciag) |

## このリポジトリを公開している理由

事務所所属の配信者など、「出所の確認できないツールを入れられない」環境でも
安心して使えるように、全ソースコードを公開しています。

**監査のポイント**(いずれも数分で確認できます):

- 依存ライブラリゼロ。全コードが素のJavaScript数百行
- 外部サーバーとの通信なし。広告カーテンの通信先は同一PC内のOBS(`ws://127.0.0.1`)のみ
- 要求権限は最小限(`storage` / `scripting` / youtube.comのホスト権限のみ)
- アナリティクス・トラッキングなし

拡張機能のインストール自体ができない環境向けに、
**ブックマークレット版**(インストール不要・自動更新なし・コード全文が見える)も
[ad-curtain-for-obs/bookmarklet.md](ad-curtain-for-obs/bookmarklet.md) で配布しています。

## 構成

```
ad-curtain-for-obs/        広告カーテン for OBS(拡張機能+ブックマークレット版)
comment-seek-for-ytlive/   コメントシーク for YouTube Live
tools/                     ブックマークレット1行版の生成ツール
PRIVACY-POLICY.md          プライバシーポリシー
```


## 自分でビルド・固定バージョン利用したい場合

ビルド工程はありません。各フォルダをそのまま `chrome://extensions` の
「パッケージ化されていない拡張機能を読み込む」で読み込めば、
その時点のコードのまま(自動更新なしで)動作します。
組織で監査済みバージョンを固定配布する場合はこの方式を推奨します。

## ライセンス

[MIT License](LICENSE) — 監査・改変・再配布は自由です。

## 作者

nnwarks — https://nnwarks.com
