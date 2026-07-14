# CLAUDE.md

このリポジトリで作業する際に、毎回踏まえるべき恒常的な前提・ルール・落とし穴をまとめる。
（時点ごとの変更履歴は `docs/session-summary-*.md` を参照。CLAUDE.mdは“常に最新に保つ前提”を書く場所。）
（**なぜこう作るか（設計の背骨）は `docs/design-philosophy.md` を参照。** CLAUDE.mdは運用ルール、あちらは設計思想。）

## プロジェクト概要
- 樹木医向け「木材腐朽菌 同定アシスト」。React + Vite の**静的サイト**を GitHub Pages で公開。
  公開URL: https://treedoctor360.github.io/wood-decay-fungi/
- AIは候補出しの助手、最終判定は樹木医（人）。写真＋観察情報→GAS経由でGemini→候補を絞る。
- データ根拠は書籍『緑化樹木腐朽病害ハンドブック』(日本緑化センター, 2017)。

## 開発・ビルド・デプロイ
- ビルド確認: `npm run build`（変更後は必ず通す）。ローカル起動: `npm run dev`。
- **デプロイ**: `main` にpush → GitHub Actions(`.github/workflows/deploy.yml`) が自動でビルドして `gh-pages` に公開。
- 正本は **`main`**。開発は作業ブランチ（例 `claude/gas-url-exposure-ddkaim`）→ `main` にマージ。

## ⚠️ 重要な落とし穴（知らないとハマる）
1. **`gh-pages` ブランチは自動生成。手で触らない・マージ対象にしない**（CIが上書きする）。
2. **GASはリポジトリからデプロイされない。** `gas/*.gs` は**参照コピー**で、実体は各自のGoogle Apps Script内で動く。
   - GASのコードを変えたら、Apps Scriptエディタで編集→保存→**デプロイ→デプロイを管理→編集→バージョン「新規」→デプロイ**（同一URL維持）。保存だけでは本番に反映されない。
3. **Geminiのモデル名は `gemini-flash-latest`**（`gas/gemini-relay.gs`）。新規プロジェクトのAPIキーでは `gemini-2.5-flash` は404（新規ユーザー提供外）。
4. **GASのWeb AppはOrigin/Refererヘッダを読めない** → 参照元制限は不可。防御はレート制限・トークン・無料枠キー・グループ分けで行う。
5. 種は **`id` でなく和名で照合**。`id`は書籍の解説本文順で、**書籍の表1-1（索引表）とはコウヤクタケ科10〜13で番号が食い違う**（書籍内の不整合。OCRのせいではない）。

## アーキテクチャ / 主要ファイル
- `src/App.jsx` … 本体（単一ファイル）。`speciesMaster`(全65種)、同定フロー、IndexedDB保存、GAS同期、記録タブ。
  - GAS接続定数: `GAS_URL`(Gemini中継) / `GAS_DB_URL`・`DB_TOKEN`(記録DB) / `RELAY_TOKEN`(任意)。
- `src/data/searchKey.js` … 図鑑の「簡易検索表」(p.9-11)を構造化。観察状況(宿主・部位)から該当群を選びプロンプトに注入。
- `gas/gemini-relay.gs` … Gemini中継（キーはスクリプトプロパティ `GEMINI_API_KEY`、1日レート制限 `DAILY_LIMIT`、任意 `SHARED_TOKEN`）。
- `gas/records-db.gs` … 記録DB中継（スクリプトプロパティ `TOKEN`、共有キーワード`group`でグループ分け）。
- `gas/README.md` … GASセットアップ手順。

## データの扱い（同定精度）
- `speciesMaster` は図鑑2017に忠実。**「記載なし」は書籍がその項目を書いていない場合＝空欄が正**。推測で埋めない。
- 種データを直すときは、必ず**書籍本文の該当種と和名で照合**してから（OCR `fukyu_full.md` の簡易検索表・表1-1は崩れがあったので、実物ページ優先）。
- `searchKey.js` のメンバー和名は `speciesMaster` の和名と一致必須（追加時は照合すること）。

## 記録DB（マルチユーザー）
- 全ユーザーが同じGAS/スプレッドシートを共有（各自のGAS設定は不要）。
- **共有キーワード(`group`)** で仕分け：同じキーワードの人だけで記録を共有。GAS側でフィルタ・削除範囲を強制。
- キーワードは“グループの合言葉”で個人認証ではない。完全な本人確認が必要ならログイン導入（別スコープ）。

## コード規約
- コメント・コミットメッセージ・UI文言は**日本語**。既存のスタイルに合わせる。
- **秘密（APIキー本体・未公開トークン）はコードにもCLAUDE.mdにも書かない**。GASのスクリプトプロパティに置く。
- PRは明示依頼があるときだけ作成。
