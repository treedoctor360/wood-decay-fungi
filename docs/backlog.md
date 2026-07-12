# 今後の検討事項（バックログ）

着手前のアイデア・保留事項を残す場所。着手したら `docs/session-summary-*.md` と
CLAUDE.md に移す。

## 運用・開発基盤
- **clasp 導入**（後日検討）
  - GASをリポジトリから `clasp push`／同一URLへ `clasp deploy -i <deploymentId>` で反映。
  - コピペと「デプロイ管理→新バージョン」のクリック操作を無くし、リポジトリを唯一の正にする。
  - GAS2プロジェクト（gemini-relay / records-db）なので `gas/` を2サブフォルダに再構成し各々 `.clasp.json`。
  - 将来は GitHub Actions で push→自動デプロイも可能（Google認証をSecret化する必要あり）。

## 機能
- **同定チャット機能**（✅ 実装済み 2026-07-10）
  - 同定タブ「3. AIと対話して絞り込む」。AIの質問チップ(半ガイド)＋自由入力で、写真に写らない
    人間観察（KOH反応・断面色・剛毛体・宿主・匂い・触感など）を渡し再同定。対話ログ表示付き。
  - 実装：`runNarrowing(answers, notes)` に `userNotes` を追加してプロンプトに注入。`sendChatNote()`/
    `startNarrowing()`/`dialogue` 状態。GAS側の変更は不要（既存のGemini中継をそのまま利用）。
  - 限界（残）：胞子サイズ・シスチジア等の顕微鏡的決め手はチャットでも解決不可（micro種）。
    マクロ・人間観察の範囲を最大化する位置づけ。今後、確証度が上がらない例の実データで改善検討。
