// bookmarklet-source.js から配布用1行ブックマークレットを生成する。
// 方針: 行頭コメント行を捨て、各行をtrimして連結するだけの「監査可能な最小変換」。
// (難読化ツールを使わないことで、1行版とソースの対応を目視で追える)
// 使い方: node tools/minify-bookmarklet.js
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'ad-curtain-for-obs', 'bookmarklet-source.js');
const out = path.join(__dirname, '..', 'ad-curtain-for-obs', 'bookmarklet-line.txt');

let s = fs.readFileSync(src, 'utf8');
const lines = s.split(/\r?\n/)
  .filter((l) => !/^\s*\/\//.test(l)) // 行頭コメント行を除去
  .map((l) => l.trim())
  .filter((l) => l.length > 0);
const one = 'javascript:' + lines.join('');

if (one.includes('%')) {
  console.error('エラー: %文字が含まれています(ブックマークURLで%エンコードと誤解釈されるため使用禁止)');
  process.exit(1);
}
fs.writeFileSync(out, one, 'utf8');
console.log('生成完了: ' + out + ' (' + one.length + ' 文字)');
