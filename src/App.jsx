// ============================================================
// 木材腐朽菌 絞り込みPoC  v0.7
// 方式A':GAS経由でGemini(gemini-2.5-flash)を呼ぶオンライン版
//
// v0.6.1 → v0.7 の変更点(機能追加2件):
//   ①Geminiの所見表示: 写真から見えた色・形・大きさの自然文(shoken)を
//     出力JSONに追加させ、判定バー直後に「写真から見えた特徴」として表示。
//     候補絞り込みとは別に観察補助として読める。記録(ai_shoken)にも保存。
//   ②手動登録(AI候補にない種の確定):
//     - 「該当候補がない場合は手動で登録」セクションを候補リスト末尾に追加
//     - 「65種から選ぶ」プルダウン or 「自由入力」(65種外用)を切替可能
//     - 判断理由(なぜAIと違う判断をしたか)も任意で記録
//     - 記録に情報源タグ jouhougen を追加:
//        from_ai / from_master / from_manual の3種
//     - 記録一覧と書き出しJSONにも反映、後の精度分析の材料になる
//
// v0.6a → v0.6.1 の変更点(運用改善・コード変更なし):
//   ・デプロイをGitHub Actionsで自動化(.github/workflows/deploy.yml)。
//     mainへのpushだけで自動ビルド・公開される。
//   ・package.jsonから手動デプロイ用の predeploy/deploy scripts と
//     gh-pages 依存を削除(version 0.6.0→0.6.1)。
//   ※App.jsxの中身は v0.6a と同一(ヘッダー・UIバージョン表記のみ更新)。
//
// v0.6 → v0.6a の変更点(バグ修正3件):
//   ②kenshou誤表示: 候補リストにkenshouを渡していないためAIの返すkenshouが
//     不正確で、バッジが「未検証」と誤表示し得た。→ バッジ表示時に
//     speciesMasterから和名で引いた正しいkenshouを使うよう修正。
//   ④シハイタケ(ID20)の腐朽型: rot文字列が「白色孔状腐朽」のため自動判定の
//     部分一致から漏れ"変色"になっていた。実際は白色腐朽菌なので"白色"に修正。
//   ③画像プレビューのメモリ: dataUrlとbase64を二重保持していたのを解消。
//     プレビューはObject URL方式にし、削除時にrevokeで解放するようにした。
//
// v0.5 → v0.6 の変更点(機能追加:掲載種一覧タブ):
//   ・上部にタブを追加。「同定」と「掲載種一覧」を切り替えられる。
//   ・掲載種一覧タブ:全65種を検索(和名・学名・宿主)＋腐朽型フィルタ付きで一覧表示。
//     各種カードに 和名/学名/科/腐朽型/宿主/部位/見える特徴/決め手/出典 を表示。
//   ※将来:speciesMaster に photo フィールドを足せば、一覧と検索結果に
//     自分で撮った参照写真を表示できる(今は素材がないため未実装)。
//
// v0.4a → v0.5 の変更点(機能追加:形態の観察入力):
//   ・「詳細な形態を入力(任意)」欄を追加(折りたたみ式)。
//     子実体の型 / 柄の有無 / 裏面(管孔・ヒダ・針・平滑) / 質感 /
//     傘表面の色 / 傷つけたときの変色 を入力できる。
//   ・入力した形態をプロンプトでGeminiに渡し、判定に反映。
//     「人が肉眼で確認した形態は写真より確実な事実として扱い、
//      矛盾する種は下げる/外す」と指示(不明・空欄は減点しない)。
//   ・記録(JSON)に観察形態(keitai)を含めるようにした。
//   ※将来:これらを speciesMaster の構造化フィールドにすれば、
//     腐朽型フィルタのように機械的な候補絞り込みにも使える(未実装)。
//
// v0.4 → v0.4a の変更点(バグ修正):
//   ・Geminiの応答が途中で切れJSON解釈に失敗する問題を修正。
//     原因はgemini-2.5-flashの「思考(thinking)」がデフォルトONで、
//     思考トークンがmaxOutputTokensを食い本文が切れていた。
//     → thinkingConfig.thinkingBudget:0 で思考を無効化、
//       maxOutputTokens を 2048→8192 に増やした。
//   ・JSON解釈失敗時にGeminiの終了理由(finishReason)を表示し、
//     途中切れ(MAX_TOKENS)かどうか分かるようにした。
//
// v0.3b → v0.4 の変更点(AI基盤の切り替え):
//   ・Claude in Artifacts が利用不可のため、AI基盤を Gemini に変更。
//   ・送信先を api.anthropic.com → GASのWeb App(中継プロキシ)に差し替え。
//     GASがGeminiのAPIキーを隠して中継する(キーはフロントに置かない)。
//   ・リクエストをGemini形式(contents/inline_data)に変更。
//     responseMimeType:application/json でJSON出力を強制。
//   ・CORS回避のため送信時の Content-Type を text/plain にした。
//   ・65種の候補リスト・腐朽型フィルタ・検索表・プロンプトはそのまま流用。
//   ・GASのURLはファイル冒頭の GAS_URL 定数で管理(再デプロイ時はここだけ変更)。
//
// v0.3a → v0.3b の変更点(バグ修正・送信サイズ削減):
//   ・「Internal server error」=リクエスト過大への対処。
//   ・写真をcanvasで長辺1280pxに縮小+JPEG圧縮(品質0.8)してから送る
//     (スマホ写真は数MBあり、無圧縮だとリクエストが大きすぎて失敗していた)
//   ・AIに渡す候補リストを識別に必要なフィールドだけに軽量化
//     (出典の長文・kenshou・rot説明文を送信対象から除外)
//
// v0.3 → v0.3a の変更点(バグ修正):
//   ・APIモデル名を "claude-sonnet-4-20250514" → "claude-sonnet-4-6" に修正
//     (アーティファクト内のAPI呼び出しでは後者でないと弾かれ、
//      「候補の取得に失敗」になっていた)
//   ・エラー表示を詳細化。HTTPステータス・APIエラー文・JSONパース失敗・
//     空応答を区別して画面に出すようにした(原因切り分けのため)
//
// v0.2 → v0.3 の変更点:
//   1. speciesMaster を全65種「裏取り済み(kenshou:"済")」に更新
//      (出典:緑化樹木腐朽病害ハンドブック / 日本緑化センター 2017)
//   2. 各種に rotType("白色"/"褐色"/"両方"/"変色")を追加
//      → 入力の「腐朽型(材の色)」で候補を機械的にフィルタ
//   3. 各種の出典を shutten(配列)に変更。
//      → 同一種に複数図鑑の記載を追加できる構造にした
//      (腐朽菌は図鑑ごとに色表現や説明が異なるため、出典を併記して比較できるようにする)
//   4. 顕微鏡必須種に micro:true を付与。AIが「採取して顕微鏡確認推奨」と警告
//   5. ヘッダーに対象範囲の注意書きを明示
//      (現時点では「緑化樹木の主要木材腐朽菌」のみ。
//       テングタケ・シイタケ等の一般的なキノコは順次追加予定)
//
// 方針(再掲):AIは候補出し・観察ガイドの助手。判定者は樹木医。
//   © 2026 Koh Kitsukawa. All rights reserved.
// ============================================================

import { useState } from "react";

// ============================================================
// AI接続設定（GAS経由でGeminiを呼ぶ）
//   ・Claude in Artifacts が使えないため、AI基盤を Gemini に切り替えた。
//   ・GAS_URL は「Gemini中継Web App（GAS）」のデプロイURL。
//     GASがGeminiのAPIキーを隠して中継するので、ここにキーは書かない。
//   ・GitHub Pages 等にデプロイすると、このURLはブラウザから見える。
//     見えても困らないよう、キーはGAS側に隠してある（URLだけでは悪用しにくい）。
//   ・GASを再デプロイしてURLが変わったら、この1行だけ差し替える。
// ============================================================
const GAS_URL =
  "https://script.google.com/macros/s/AKfycbwfSHmBl8VYy635RPq0hnc_q_wJw1Cgrg0NzXDcucBmK0jTVOvDKbMxeYqvr-UtCyJ9fQ/exec";

// ---- 配色トークン(標本ラベル風)----
const C = {
  paper: "#ECEEE6",
  card: "#FAF9F4",
  ink: "#1E2A22",
  sub: "#5C665C",
  line: "#C9C8BC",
  rust: "#A8581F",
  sage: "#5B7355",
  amber: "#C2922A",
};

// ============================================================
// 出典の定義(IDで参照。今後 図鑑を増やす場合はここに足す)
//   - 各種の shutten 配列に出典IDを入れる
//   - 同一種に複数出典がある場合は配列に複数IDを入れる
// ============================================================
const SOURCES = {
  handbook2017: "緑化樹木腐朽病害ハンドブック,ゴルフ緑化促進会(編),日本緑化センター,2017(第3刷),ISBN978-4-931085-41-1",
  // 例)今後追加する場合:
  // kinoko_zukan: "○○きのこ図鑑, △△(編), □□出版, 20XX",
};

// ============================================================
// speciesMaster:緑化樹木木材腐朽菌リスト(全65種・裏取り済み)
//
// 各フィールドの意味:
//   id       : 図鑑の番号
//   wamei    : 和名
//   gakumei  : 学名
//   kamei    : 科名
//   kenshou  : 検証状態 "済"=信頼源で裏取り済み
//   rotType  : 腐朽型の材色 "白色"/"褐色"/"両方"/"変色"
//              ※フィルタ用の機械可読タグ(rot の文章とは別)
//   rot      : 腐朽型(部位を含む説明文)
//   host     : 宿主樹種
//   part     : 主な発生部位
//   micro    : true=現地観察のみでは困難・顕微鏡確認推奨
//   mieru    : 写真・肉眼で見える特徴
//   kettede  : 決め手(写真では分かりにくい確認項目)
//   shutten  : 出典ID(SOURCESを参照・配列)
// ============================================================
const speciesMaster = [
  { id: 1, wamei: "オオミコブタケ", gakumei: "Kretzschmaria deusta", kamei: "クロサイワイタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹", part: "根株・地際", micro: false,
    mieru: ["かさぶた状で不定形(幅1〜5cm)", "未熟時パールグレイ→成熟で黒色", "炭質でもろく樹皮から剥がれやすい"],
    kettede: ["子のう菌類(担子菌でない)", "侵入材に黒い帯線(zone line)", "子のう胞子30〜40×8〜12μm・紡錘形"],
    shutten: [SOURCES.handbook2017] },
  { id: 2, wamei: "アラゲキクラゲ", gakumei: "Auricularia polytricha", kamei: "キクラゲ科", kenshou: "済",
    rotType: "白色", rot: "幹枝の心材腐朽・白色腐朽", host: "広葉樹", part: "幹・枝", micro: false,
    mieru: ["ロート〜椀〜耳状(幅2〜6cm)", "生時ゼラチン質・乾くと革質", "背面が灰〜朽葉色"],
    kettede: ["背面に短毛が密生(キクラゲとの区別点)", "子実層面は黒茶色で平滑", "担子胞子8〜13×3〜5μm・ソーセージ形"],
    shutten: [SOURCES.handbook2017] },
  { id: 3, wamei: "ヒラタケ", gakumei: "Pleurotus ostreatus", kamei: "ヒラタケ科", kenshou: "済",
    rotType: "白色", rot: "幹枝の心材腐朽・白色腐朽", host: "広葉樹・まれに針葉樹", part: "幹・枝", micro: false,
    mieru: ["扇〜半円形で短い側生柄(幅5〜15cm)", "数個が重なって発生", "傘表面は平滑・初め濃紺〜黒のち灰白〜枯草色"],
    kettede: ["裏は白色の垂生ヒダ(管孔でない)", "傘肉は柔軟で白色", "担子胞子8〜12×3〜4μm"],
    shutten: [SOURCES.handbook2017] },
  { id: 4, wamei: "スエヒロタケ", gakumei: "Schizophyllum commune", kamei: "スエヒロタケ科", kenshou: "済",
    rotType: "白色", rot: "枝幹の心材腐朽・白色腐朽(腐朽力は小)", host: "広葉樹・時に針葉樹", part: "枝・幹の枯死部", micro: false,
    mieru: ["小型(幅最大3cm)の扇形・無柄", "多数の傘が重なる", "表面に粗毛が密生し白〜灰白色"],
    kettede: ["乾燥時にヒダが縦2裂する『裂けヒダ』(決定的)", "肉は革質", "担子胞子4〜6×1.5〜2μm"],
    shutten: [SOURCES.handbook2017] },
  { id: 5, wamei: "ナラタケ", gakumei: "Armillaria mellea", kamei: "キシメジ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹・一部針葉樹(ヒノキ,クロマツ)", part: "根株・地際", micro: false,
    mieru: ["傘と中心生の柄をもつ普通のキノコ形", "傘は山吹〜金茶〜琥珀色・中央に鱗片", "株状に発生(初夏〜夏・晩秋)"],
    kettede: ["柄に厚いツバあり(モドキとの区別)", "土中に焦茶〜黒の根状菌糸束", "樹皮下に白色菌糸膜", "担子胞子7〜8.5×5〜5.5μm"],
    shutten: [SOURCES.handbook2017] },
  { id: 6, wamei: "ナラタケモドキ", gakumei: "Armillaria tabescens", kamei: "キシメジ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹", part: "根株・地際", micro: false,
    mieru: ["傘と中心生の柄・多数束生", "傘は丸山形のち漏斗形で枯草〜山吹〜土色", "夏〜初秋に発生"],
    kettede: ["柄にツバを欠く(ナラタケとの決定的区別)", "土中に菌糸束を作らない", "担子胞子6〜8×5〜6μm"],
    shutten: [SOURCES.handbook2017] },
  { id: 7, wamei: "ヤナギマツタケ", gakumei: "Agrocybe cylindracea", kamei: "オキナタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: false,
    mieru: ["傘と柄のあるキノコ形(径5〜10cm)", "傘表面は平滑・狐色〜褐色", "柄上部に顕著なツバあり"],
    kettede: ["成熟するとヒダが焦茶色になる", "担子胞子8.5〜11×5.5〜7μm(茶色)"],
    shutten: [SOURCES.handbook2017] },
  { id: 8, wamei: "クリタケ", gakumei: "Hypholoma sublateritium", kamei: "モエギタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹(ムクノキ等)", part: "根株・地際", micro: false,
    mieru: ["傘は黄茶色〜煉瓦色・株状に発生", "ツバを欠く", "ヒダははじめ練色"],
    kettede: ["ヒダが焦茶色〜黒茶色に変化", "担子胞子5〜7.5×3.5〜4.5μm・卵形・琥珀色", "ニガクリタケは小型でより黄色・苦みが強い(鑑別)"],
    shutten: [SOURCES.handbook2017] },
  { id: 9, wamei: "ヌメリスギタケモドキ", gakumei: "Pholiota aurivella", kamei: "モエギタケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹(バッコヤナギ等)", part: "幹", micro: false,
    mieru: ["傘は黄金色〜狐色・三角形の鱗片が多数", "生時に傘が粘性を帯びる", "幹に発生"],
    kettede: ["柄の鱗片が粘性を帯びない(ヌメリスギタケとの鑑別点)", "担子胞子6〜9×4〜5μm・楕円形・橙色"],
    shutten: [SOURCES.handbook2017] },
  { id: 10, wamei: "コガネコウヤクタケ", gakumei: "Phlebia chrysocrea", kamei: "コウヤクタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹・ヒノキ", part: "根株・幹", micro: false,
    mieru: ["背着生・不定型(傘を作らない)", "鮮やかな卵色〜山吹色", "縁が薄く乾くと亀裂が入る"],
    kettede: ["KOH液(5%)でワインレッドに変色(決定的)", "担子胞子4〜5×2〜2.5μm", "分布:本州以南"],
    shutten: [SOURCES.handbook2017] },
  { id: 11, wamei: "チヂレタケ", gakumei: "Plicaturopsis crispa", kamei: "コウヤクタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹・特にサクラ類", part: "枝・幹", micro: false,
    mieru: ["小型(幅0.5〜3cm)・扇形・無柄", "傘表面に短密毛と不明瞭な環紋・卵色〜狐色", "特にサクラ類に多い"],
    kettede: ["裏面のヒダが縮れている(決定的)", "担子胞子3〜4×1〜1.5μm・ソーセージ形"],
    shutten: [SOURCES.handbook2017] },
  { id: 12, wamei: "サガリハリタケ", gakumei: "Radulodon copelandii", kamei: "コウヤクタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: false,
    mieru: ["背着生・白色〜淡黄色", "先端が尖った針状の突起が密生(長さ0.5〜1cm)", "乾燥すると針が褐色"],
    kettede: ["針状の子実層托(他の背着生菌との決定的区別)", "担子胞子5.5〜7×5〜6μm・類球形"],
    shutten: [SOURCES.handbook2017] },
  { id: 13, wamei: "アナタケ", gakumei: "Schizopora flavipora", kamei: "コウヤクタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹(オオヤマザクラ等)", part: "枝・幹", micro: false,
    mieru: ["背着生・不定型・白色〜クリーム色〜枯色", "管孔状で孔口が角形〜迷路状"],
    kettede: ["孔口が角形〜迷路状・1mmに3〜5個", "子実層に先端が球形の特徴ある菌糸", "担子胞子3.5〜5×2.5〜3.5μm"],
    shutten: [SOURCES.handbook2017] },
  { id: 14, wamei: "ウスバタケ", gakumei: "Irpex lacteus", kamei: "ニクハリタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹(シンジュ等)", part: "枝・幹", micro: false,
    mieru: ["半背着生(上縁が幅の狭い傘状に反転)", "傘表面は白色・短毛・環紋あり", "子実層托は薄い歯牙状(長さ1〜2mm)"],
    kettede: ["歯牙状の子実層托と先端に結晶を被るシスチジア", "担子胞子4〜6×2〜3μm・楕円形〜円筒形"],
    shutten: [SOURCES.handbook2017] },
  { id: 15, wamei: "カンゾウタケ", gakumei: "Fistulina hepatica", kamei: "カンゾウタケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽・褐色腐朽", host: "シイ・カシ等広葉樹", part: "幹", micro: false,
    mieru: ["肝臓に似た緋色〜赤茶色・柔らかく多汁", "無環紋", "夏期に発生"],
    kettede: ["管孔が1本1本独立(ストロー状)", "切ると赤い汁が出る(決定的)", "褐色腐朽(他の多くが白色腐朽)", "担子胞子4〜5×2.5〜3μm"],
    shutten: [SOURCES.handbook2017] },
  { id: 16, wamei: "マツオウジ", gakumei: "Neolentinus lepideus", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽・褐色腐朽", host: "針葉樹・特にマツ類", part: "幹・切株", micro: false,
    mieru: ["大型(幅5〜20cm)・傘表面に同心円状の鱗片(黄金〜茶色)", "強いヤニ臭", "針葉樹(特にマツ)に発生"],
    kettede: ["褐色腐朽", "ヒダが垂生", "担子胞子は円筒形10〜11×4〜5μm"],
    shutten: [SOURCES.handbook2017] },
  { id: 17, wamei: "ヒトクチタケ", gakumei: "Cryptoporus volvatus", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の辺材腐朽・白色腐朽(腐朽力はほとんどない・パイオニア菌)", host: "針葉樹・特にマツ類(枯死後1年以内)", part: "幹・枝", micro: false,
    mieru: ["ハマグリ形・無毛・光沢・黄色〜栗色", "裏面全体が薄い膜で覆われ基部近くに1つの穴(口)"],
    kettede: ["管孔は薄膜の内側に隠れている(決定的)", "マツ枯死後1年以内のみ発生", "担子胞子10〜13×4〜6μm"],
    shutten: [SOURCES.handbook2017] },
  { id: 18, wamei: "シロアメタケ", gakumei: "Tyromyces fissilis", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹・クリ・リンゴ・ブナ等", part: "幹", micro: false,
    mieru: ["無柄・半円形〜棚状", "生時は白色でワックス質・環紋なし", "肉は白色で多汁・柔軟"],
    kettede: ["乾くと狐色〜茶色に変色し傘がもろくなる(決定的)", "白紙上に置くと汁で茶色のしみ", "担子胞子4〜6×3〜4μm", "分布:温帯"],
    shutten: [SOURCES.handbook2017] },
  { id: 19, wamei: "ヤニタケ", gakumei: "Ischnoderma resinosum", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "針葉樹・広葉樹", part: "幹・地際", micro: false,
    mieru: ["半円形〜棚状・多数重なる", "傘表面は細密毛・狐色〜黒茶色・明瞭な環紋と環溝", "生時に特有のアニス臭"],
    kettede: ["管孔面を傷つけると褐変(決定的)", "生時は肉質・乾くとコルク質", "担子胞子5〜6×1.5〜2μm・ソーセージ形"],
    shutten: [SOURCES.handbook2017] },
  { id: 20, wamei: "シハイタケ", gakumei: "Trichaptum abietinum", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "枯死木の幹辺材腐朽・白色孔状腐朽", host: "針葉樹・特にマツ属(枯死木)", part: "幹", micro: false,
    mieru: ["半背着生・薄い(幅1〜5cm)・多数重なる", "子実層(裏面)が新鮮時に紫色を帯びる", "針葉樹の枯死木"],
    kettede: ["管孔面の紫色(新鮮時のみ・乾燥すると消える・決定的)", "孔口の縁が歯牙状", "担子胞子5〜7×2〜3μm・湾曲した円筒形"],
    shutten: [SOURCES.handbook2017] },
  { id: 21, wamei: "ハカワラタケ", gakumei: "Trichaptum biforme", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹(ソメイヨシノ等)", part: "枝・幹", micro: false,
    mieru: ["扇形〜半円形・薄い(1〜2mm)・多数重なる", "傘表面に明瞭な環紋", "子実層托がはじめパステルピンク→のちに紫色を帯びる"],
    kettede: ["広葉樹に発生(シハイタケは針葉樹:鑑別点)", "担子胞子5〜7×2〜2.5μm・円筒形"],
    shutten: [SOURCES.handbook2017] },
  { id: 22, wamei: "ニクウスバタケ", gakumei: "Cerrena consors", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹・特にナラ類", part: "幹", micro: false,
    mieru: ["半背着生・多数重なる", "橙色〜狐色の薄い傘(幅1〜3cm)", "子実層托が薄歯状"],
    kettede: ["薄歯状の子実層托(カワラタケ等との区別)", "担子胞子4.5〜6×2〜3μm", "分布:本州・四国・九州"],
    shutten: [SOURCES.handbook2017] },
  { id: 23, wamei: "ミダレアミタケ", gakumei: "Cerrena unicolor", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹", part: "幹・枝", micro: false,
    mieru: ["半円形〜棚状・灰白色", "藻類付着で緑色になりやすい", "子実層托ははじめ迷路状→のちに薄歯状"],
    kettede: ["傘肉に褐色の帯線があり2層に分かれる(決定的)", "担子胞子3.5〜5×2.5〜3.5μm", "ヒラアシキバチと共生(菌糸断片を体内に保持・産卵時に樹木へ植え付ける)"],
    shutten: [SOURCES.handbook2017] },
  { id: 24, wamei: "カイガラタケ", gakumei: "Lenzites betulina", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹", part: "幹・枝", micro: false,
    mieru: ["半円形〜扇形(幅2〜10cm)", "傘表面に環紋(灰〜褐色系)", "裏面がヒダ状(管孔でない)"],
    kettede: ["ヒダが互いに連絡する", "子実層に剣状の厚壁菌糸が多数", "担子胞子5〜6×2〜3μm・湾曲した円筒形"],
    shutten: [SOURCES.handbook2017] },
  { id: 25, wamei: "ウサギタケ", gakumei: "Trametes trogii", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹・特にヤナギ科", part: "幹・枝", micro: false,
    mieru: ["傘表面に粗毛の束が密生(ウサギ毛状)", "クリーム〜褐色・無環紋", "基部が垂生"],
    kettede: ["粗毛の束が特徴的(カワラタケ等との区別)", "担子胞子8〜12×3.5〜4μm", "分布:北海道・本州(温帯)"],
    shutten: [SOURCES.handbook2017] },
  { id: 26, wamei: "オオチリメンタケ", gakumei: "Trametes gibbosa", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹", part: "幹", micro: false,
    mieru: ["半円形・大型(幅5〜15cm)", "傘表面は白色〜灰色・藻類付着で緑色になりやすい", "孔口が放射状に長い〜迷路状"],
    kettede: ["孔口が放射状〜迷路状に長くなる(他のトラメテス属との鑑別)", "担子胞子4〜6×2〜3μm", "特に北日本や標高の高い地域"],
    shutten: [SOURCES.handbook2017] },
  { id: 27, wamei: "カワラタケ", gakumei: "Trametes versicolor", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹枝の心材腐朽・白色腐朽", host: "広葉樹中心", part: "幹・枝・切株(主に枯死部)", micro: false,
    mieru: ["微毛フェルト状で色変化が大きい", "明瞭な同心円の環紋", "白い縁・薄い革質・覆瓦状"],
    kettede: ["KOH液で黒変しない", "肉が白色で強靭", "傘が薄い(1〜3mm)"],
    shutten: [SOURCES.handbook2017] },
  { id: 28, wamei: "クジラタケ", gakumei: "Trametes orientalis", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹(サクラ類等)", part: "幹", micro: false,
    mieru: ["半円形・幅5〜20cm・多数重なる", "傘面は灰白色〜茶鼠色でしわ状・無環紋", "肉が比較的厚い"],
    kettede: ["管孔が小さな円形(迷路状にならない:オオチリメンタケ・ホウロクタケとの鑑別)", "担子胞子5〜7×2〜3μm・円筒形"],
    shutten: [SOURCES.handbook2017] },
  { id: 29, wamei: "シロアミタケ", gakumei: "Trametes suaveolens", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹・特にヤナギ属", part: "幹・枝", micro: false,
    mieru: ["半円形・白色〜バフ色・環紋なし・やや肉厚", "生時に強いアニス臭"],
    kettede: ["強いアニス臭(決定的・ヤニタケとの区別点)", "担子胞子8〜10×3〜4.5μm・円筒形", "特にヤナギ属・分布:全国(特に温帯地域)"],
    shutten: [SOURCES.handbook2017] },
  { id: 30, wamei: "ヒイロタケ", gakumei: "Pycnoporus coccineus", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹・針葉樹(サクラ・ウメ等)", part: "幹・枝", micro: false,
    mieru: ["全体が鮮やかな朱色〜緋色(傘・管孔・肉すべて同色)", "無環紋・コルク質"],
    kettede: ["管孔が微細(1mmに6〜8個・肉眼での観察が難しい:シュタケとの鑑別)", "担子胞子4〜5×2〜2.5μm・湾曲した円筒形", "分布:本州以南"],
    shutten: [SOURCES.handbook2017] },
  { id: 31, wamei: "チャカイガラタケ", gakumei: "Daedaleopsis tricolor", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹・特にサクラ類", part: "幹・枝", micro: false,
    mieru: ["半円形・多数重なる", "傘表面に褐色〜黒茶色系の顕著な環紋", "裏面がヒダ状(硬い)"],
    kettede: ["ヒダの幅が2〜6mm(カイガラタケより太い)", "担子胞子7〜9×2〜3μm・円筒形〜ソーセージ形", "特にサクラ類"],
    shutten: [SOURCES.handbook2017] },
  { id: 32, wamei: "ツリガネタケ", gakumei: "Fomes fomentarius", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹(ブナ・カバ等)", part: "幹", micro: false,
    mieru: ["多年生・蹄形〜釣鐘形(大型は幅最大70cm)", "傘表面に褐色の殻皮と環紋", "傘肉はフェルト質・枯草色"],
    kettede: ["傘肉が枯草色(コフキタケはチョコレート色:鑑別点)", "担子胞子12〜18×4〜5μm(大型)", "分布:全国・特に温帯域"],
    shutten: [SOURCES.handbook2017] },
  { id: 33, wamei: "ウズラタケ", gakumei: "Perenniporia ochroleuca", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹・特にウメ・サクラ類などバラ科", part: "幹・枝", micro: false,
    mieru: ["比較的小型(幅1〜4cm)・クリーム色〜枯草色・環紋あり", "特にバラ科樹木"],
    kettede: ["担子胞子が一端切形・大型(12〜15×6〜10μm)(決定的)", "肉はコルク質・白色〜クリーム色", "分布:本州以南"],
    shutten: [SOURCES.handbook2017] },
  { id: 34, wamei: "ベッコウタケ", gakumei: "Perenniporia fraxinea", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹(特にエンジュ・ニセアカシア等マメ科)・まれに針葉樹", part: "根株・幹基部(地際)", micro: false,
    mieru: ["初夏に黄色〜山吹色の原基→成長して橙〜琥珀〜黒色になる", "坐生・半円形・幅5〜20cm・数個が重なる", "孔口が微細(1mmに6〜7個)"],
    kettede: ["担子胞子5〜7×4.5〜5.5μm・一端が尖った類球形(決定的)", "傘肉に厚壁胞子が多数形成される", "緑化樹木の腐朽菌の中で発生頻度が最も高い種のひとつ", "しばしば樹木を枯死させる(病原性が強い)"],
    shutten: [SOURCES.handbook2017] },
  { id: 35, wamei: "シイサルノコシカケ(シイノサルノコシカケ)", gakumei: "Loweporus tephroporus", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹・特にシイ類(太枝・幹)", part: "幹・枝", micro: false,
    mieru: ["背着生〜半背着生・楕円形", "焦茶色〜黒茶色・硬い", "特にシイ類の太枝・幹に発生"],
    kettede: ["骨格菌糸と担子胞子がデキストリノイド(メルツァー試薬で茶色:決定的)", "担子胞子4.5〜6×3.5〜4.5μm・一端が欠けた広楕円形", "分布:本州以南・暖温帯〜熱帯"],
    shutten: [SOURCES.handbook2017] },
  { id: 36, wamei: "ニレサルノコシカケ(オオシロサルノコシカケ)", gakumei: "Rigidoporus ulmarius", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹(ニレ類)・針葉樹(スギの老木)", part: "根株・地際", micro: false,
    mieru: ["多年生・大型(幅最大30cm)・白色〜クリーム色〜珊瑚色", "無環紋", "根株・地際に発生"],
    kettede: ["菌糸にかすがい連結を欠く(分類上の特徴)", "担子胞子が類球形(径6〜10μm)", "子実体を構成する有色菌糸の存在"],
    shutten: [SOURCES.handbook2017] },
  { id: 37, wamei: "カイメンタケ", gakumei: "Phaeolus schweinitzii", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "根株心材腐朽・褐色腐朽", host: "針葉樹・特にカラマツに多い", part: "根株・地際・切株", micro: false,
    mieru: ["半円形〜円形・大型(幅5〜30cm)・多数重なる", "土色〜焦茶色・軟毛密生・環紋あり", "生時は軟らかくスポンジ状、乾くともろいウレタン状"],
    kettede: ["褐色腐朽(針葉樹根株・カワウソタケ属と外観類似だが褐色腐朽で区別)", "担子胞子5〜8×3.5〜4.5μm・広楕円形", "針葉樹根株腐朽菌の中で発生頻度・腐朽力ともに最大"],
    shutten: [SOURCES.handbook2017] },
  { id: 38, wamei: "アイカワタケ(ヒラフスベ)", gakumei: "Laetiporus sulphureus", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹や枝の心材腐朽・褐色腐朽", host: "広葉樹・特にスダジイ・コジイに多い", part: "幹・枝", micro: false,
    mieru: ["大型(幅10〜30cm)・鮮やかな黄色〜小麦色・棚状", "ヒラフスベ型(傘が開かずコブ状)で現れることもある"],
    kettede: ["褐色腐朽・菌糸にかすがい連結を欠く", "担子胞子5〜8×4〜5μm・卵形〜楕円形", "マスタケ(サーモンピンク)・アイカワタケ(黄色)は近縁だが別種の可能性", "分布:全国・特に関西以西の暖温帯"],
    shutten: [SOURCES.handbook2017] },
  { id: 39, wamei: "マスタケ", gakumei: "Laetiporus sulphureus var. miniatus", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽・褐色腐朽", host: "広葉樹・針葉樹", part: "幹", micro: false,
    mieru: ["鮮やかなサーモンピンク〜クロームオレンジの大型の傘(幅10〜30cm)・棚状"],
    kettede: ["褐色腐朽・菌糸にかすがい連結を欠く", "サーモンピンク〜オレンジ色(アイカワタケは黄色:鑑別点)", "担子胞子5〜8×4〜5μm", "分布:全国・特に温帯域"],
    shutten: [SOURCES.handbook2017] },
  { id: 40, wamei: "アオゾメタケ", gakumei: "Postia caesia", kamei: "ツガサルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "枝や幹の心材腐朽・褐色腐朽", host: "針葉樹に多い・サクラ類など広葉樹にも", part: "枝・幹", micro: false,
    mieru: ["薄藍色〜白色の小型の子実体(幅最大5〜6cm)", "生時は水分多く柔軟"],
    kettede: ["褐色腐朽", "担子胞子5〜7×1.5μm・ソーセージ形・胞子紋が青みを帯びる(決定的)"],
    shutten: [SOURCES.handbook2017] },
  { id: 41, wamei: "ホウロクタケ", gakumei: "Daedalea dickinsii", kamei: "ツガサルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽・褐色腐朽", host: "広葉樹", part: "幹", micro: false,
    mieru: ["幅5〜20cm・ストロー色〜枯草色・コルク質", "環溝と不明瞭な環紋", "管孔は1mmに1〜2個でしばしば迷路状になる"],
    kettede: ["褐色腐朽(広葉樹の幹心材)", "孔口がしばしば迷路状に変形する", "薄茶色のコルク質(多くの樹種に広く発生)"],
    shutten: [SOURCES.handbook2017] },
  { id: 42, wamei: "ツガサルノコシカケ", gakumei: "Fomitopsis pinicola", kamei: "ツガサルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽・褐色腐朽", host: "針葉樹・一部の広葉樹(特にサクラ類)", part: "幹", micro: false,
    mieru: ["多年生・半円形・幅最大20cm", "傘表面に環紋(成熟すると赤錆色が特徴的)・ニス状の光沢"],
    kettede: ["褐色腐朽(針葉樹幹心材)", "赤錆色の環紋(決定的)", "担子胞子6〜8×4〜5μm・広楕円形", "分布:全国・特に温帯域"],
    shutten: [SOURCES.handbook2017] },
  { id: 43, wamei: "バライロサルノコシカケ", gakumei: "Fomitopsis rosea", kamei: "ツガサルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽・褐色腐朽", host: "針葉樹・サクラ類などの広葉樹", part: "幹", micro: false,
    mieru: ["多年生・蹄形・幅1〜10cm", "表面は暗紫(滅紫)色〜黒色・殻皮あり", "管孔面がピンク(桜色)を帯びる"],
    kettede: ["褐色腐朽", "管孔面の桜色(決定的)", "担子胞子6〜9×2〜3μm・円筒形"],
    shutten: [SOURCES.handbook2017] },
  { id: 44, wamei: "カタオシロイタケ", gakumei: "Fomitopsis spraguei", kamei: "ツガサルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹や枝の心材腐朽・褐色腐朽", host: "広葉樹(ソメイヨシノ等)", part: "幹・枝", micro: false,
    mieru: ["半円形〜扇形・幅4〜12cm", "白色〜クリーム色・無環紋・無毛", "生時は硬い肉質"],
    kettede: ["褐色腐朽(白色の外見から白色腐朽と誤認しやすい:要注意)", "担子胞子5〜7×4〜5μm・卵形〜広楕円形", "分布:全国・温帯域"],
    shutten: [SOURCES.handbook2017] },
  { id: 45, wamei: "クロサルノコシカケ", gakumei: "Melanoporia castanea", kamei: "ツガサルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽・褐色腐朽", host: "広葉樹・特にナラ類やクリ", part: "幹", micro: false,
    mieru: ["多年生・大型(幅最大30cm)・黒茶色で殻皮と畝状の隆起帯・環溝", "縁が厚く鈍い"],
    kettede: ["褐色腐朽(黒い外観から白色腐朽と誤認しやすい・要注意)", "担子胞子4〜5×2〜2.5μm・円筒形", "分布:全国・温帯"],
    shutten: [SOURCES.handbook2017] },
  { id: 46, wamei: "カンバタケ", gakumei: "Piptoporus betulinus", kamei: "ツガサルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹や枝の心材腐朽・褐色腐朽", host: "カンバ類樹木のみ", part: "幹・枝", micro: false,
    mieru: ["半円形〜腎臓形・幅6〜25cm", "傘表面は狐色〜茶色・無毛・無環紋"],
    kettede: ["カンバ類にのみ発生(決定的・ナラ類に発生するのはコカンバタケ)", "担子胞子4〜5×1.5〜2μm・ソーセージ形", "生時は肉質・乾くと軽いコルク質"],
    shutten: [SOURCES.handbook2017] },
  { id: 47, wamei: "シロカイメンタケ", gakumei: "Piptoporus soloniensis", kamei: "ツガサルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽・褐色腐朽", host: "広葉樹(アラカシ等)", part: "幹", micro: false,
    mieru: ["大型(幅10〜30cm)・若時クリームイエロー→成熟でストロー〜白色", "放射状のしわ"],
    kettede: ["褐色腐朽・乾くと極めて軽いコルク質(決定的)", "アイカワタケと外観類似だが本菌は菌糸にかすがい連結あり(鑑別点)", "担子胞子4〜5×2〜2.5μm"],
    shutten: [SOURCES.handbook2017] },
  { id: 48, wamei: "コフキタケ(コフキサルノコシカケ)", gakumei: "Ganoderma applanatum", kamei: "マンネンタケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹", part: "幹・枝・地際部", micro: false,
    mieru: ["多年生・半円形・無柄・大型(幅最大50cm超)", "傘表面に環溝・胞子粉でココア色に粉をふいたようになる"],
    kettede: ["傘肉がチョコレート色(決定的・ツリガネタケは肌色〜飴色)", "管孔面を傷つけるとチョコレート色に変色", "担子胞子8〜10×5〜7.5μm・一端が欠けた卵形・琥珀色・二重壁", "ベッコウタケと並んで緑化樹木に最多発生"],
    shutten: [SOURCES.handbook2017] },
  { id: 49, wamei: "マンネンタケ", gakumei: "Ganoderma lucidum", kamei: "マンネンタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹", part: "根株・地際", micro: false,
    mieru: ["漆塗り状の光沢・偏心〜中心生の柄あり", "赤褐色〜焦茶色・環溝あり"],
    kettede: ["担子胞子9〜11×5〜7μm・黄金色〜琥珀色・二重壁・一端が欠けた卵形(決定的)", "琥珀色の顕著な結合菌糸が存在", "針葉樹発生種はマゴジャクシ(別種)"],
    shutten: [SOURCES.handbook2017] },
  { id: 50, wamei: "アズマタケ", gakumei: "Inonotus vallatus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽(マツ類を枯死させることがある)", host: "マツ類", part: "根株", micro: false,
    mieru: ["傘と柄のあるキノコ形(柄が中心性〜偏心性)", "狐色〜土色・短密毛・環紋あり・マツ類発生"],
    kettede: ["マツ類の根株心材腐朽・マツを枯死させる", "担子胞子3〜5×2.5〜4μm・類球形〜広楕円形", "分布:全国的(特に関西以西に多い)"],
    shutten: [SOURCES.handbook2017] },
  { id: 51, wamei: "オニカワウソタケ", gakumei: "Inonotus ludovicianus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・孔状白色腐朽", host: "広葉樹・特にカシ類", part: "根株・幹", micro: false,
    mieru: ["大型(幅10〜20cm)・褐色〜赤褐色", "傘表面が波状に隆起"],
    kettede: ["剛毛体がないかまれに存在(カワウソタケとの鑑別点)", "担子胞子5〜6.5×3.5〜5μm・楕円形・琥珀色", "分布:関東地方以南(暖温帯〜亜熱帯)"],
    shutten: [SOURCES.handbook2017] },
  { id: 52, wamei: "カワウソタケ", gakumei: "Inonotus mikadoi", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・孔状白色腐朽", host: "広葉樹・特にサクラ類・ウメ等バラ科", part: "幹・枝", micro: false,
    mieru: ["新鮮時は狐色・密毛あり→古くなると茶色〜黒茶色・無毛", "幅1〜6cm・多数重なる", "7月頃に大量発生(胞子で幹・枝が茶色くなる)"],
    kettede: ["剛毛体は通常存在しない(オニカワウソタケとの鑑別点)", "担子胞子4〜6×3〜4μm・広楕円形・厚壁・琥珀色", "原菌糸は橙黄色・かすがい連結を欠く"],
    shutten: [SOURCES.handbook2017] },
  { id: 53, wamei: "ヤケコゲタケ", gakumei: "Inonotus hispidus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹・特にミズナラに多い", part: "幹", micro: false,
    mieru: ["大型(幅10〜30cm)・粗毛が密生", "若時は土色〜褐色→のちに焼け焦げたように黒色", "生時は大量の水分を含む"],
    kettede: ["担子胞子9〜11×7.5〜9μm・類球形〜広楕円形・茶色(有色胞子:決定的)", "分布:全国・特に温帯域"],
    shutten: [SOURCES.handbook2017] },
  { id: 54, wamei: "カシサルノコシカケ(コブサルノコシカケ)", gakumei: "Phellinus robustus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹", part: "幹", micro: false,
    mieru: ["多年生・蹄形〜扁平・大型(幅5〜30cm)", "縁が橙黄色で内側に向かって黒色", "凹凸のある環溝"],
    kettede: ["デキストリノイドの担子胞子(メルツァー試薬で褐色:決定的)", "担子胞子6〜9×5.5〜8.5μm・類球形", "剛毛体多数存在", "旧名コブサルノコシカケ(1989年に改称)"],
    shutten: [SOURCES.handbook2017] },
  { id: 55, wamei: "キコブタケ", gakumei: "Phellinus igniarius", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹", part: "幹", micro: false,
    mieru: ["多年生・蹄形・幅最大20cm", "傘面はじめ灰白色→後に灰色〜黒茶色・亀裂あり・外縁が山吹色"],
    kettede: ["子実層に赤茶色の剛毛体が多数", "担子胞子5〜6×4〜5μm・類球形・厚壁・無色", "形態的変異が大きい(同定に注意)"],
    shutten: [SOURCES.handbook2017] },
  { id: 56, wamei: "コブサルノコシカケモドキ", gakumei: "Phellinus setulosus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "カシ類・イスノキ等の広葉樹", part: "幹", micro: false,
    mieru: ["多年生・蹄形〜半円形・大型(幅5〜30cm)", "縁が橙黄色で内側が黒色(カシサルノコシカケと類似)"],
    kettede: ["カシサルノコシカケより傘肉が濃色(土色)", "担子胞子が小さい(4.5〜6×4〜5μm)(鑑別点)", "剛毛体が多数(長さ20〜40μm)", "分布:関東以南"],
    shutten: [SOURCES.handbook2017] },
  { id: 57, wamei: "コルクタケ", gakumei: "Phellinus torulosus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "サクラ類・カシ類等の広葉樹・マツ類", part: "幹", micro: false,
    mieru: ["半円形・縁が薄く横断面が三角形", "枯色〜黄土色・微細毛", "傘肉は橙黄色・木質"],
    kettede: ["孔口が微細(1mmに5〜8個)", "剛毛体が多数存在", "担子胞子4〜6×3〜4μm・卵形〜広楕円形", "分布:本州以南"],
    shutten: [SOURCES.handbook2017] },
  { id: 58, wamei: "サビアナタケ", gakumei: "Phellinus ferruginosus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹", part: "幹・枝", micro: false,
    mieru: ["背着生・不定型・檜皮色〜錆色(赤錆色がかった)・硬い"],
    kettede: ["子実層に細長い剛毛体が多数(長さ25〜60μm:決定的)", "担子胞子4〜6×2.5〜4μm・広楕円形", "分布:本州以南"],
    shutten: [SOURCES.handbook2017] },
  { id: 59, wamei: "シマサルノコシカケ", gakumei: "Phellinus noxius", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹・イヌマキなど一部の針葉樹", part: "根株", micro: false,
    mieru: ["若時は柑子〜琥珀色→のちに焦茶〜黒茶色", "生時に管孔面が黒色(特徴)"],
    kettede: ["生時管孔面が黒色(決定的)・乾くと褐茶色に変化", "剛毛体を欠くが剛毛状菌糸あり(幅7〜12μm・先端が丸い)", "担子胞子3.5〜4.5×3〜3.5μm", "南根腐病の病原菌・根の接触で隣接木に感染・根絶困難", "分布:鹿児島以南(奄美大島以南で被害報告)"],
    shutten: [SOURCES.handbook2017] },
  { id: 60, wamei: "チャアナタケ", gakumei: "Phellinus umbrinellus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹", part: "幹・枝", micro: true,
    mieru: ["背着生・不定型・アンバー(琥珀色)〜焦茶色", "管孔が小さく(1mmに5〜7個)"],
    kettede: ["剛毛体を欠く", "担子胞子4〜5×3.5〜4μm・広楕円形〜類球形・土色〜褐色(有色)", "外部形態のみでの同定は困難・顕微鏡観察必須", "分布:本州以南"],
    shutten: [SOURCES.handbook2017] },
  { id: 61, wamei: "チャアナタケモドキ", gakumei: "Phellinus punctatus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹・針葉樹(サンブスギ等)", part: "幹・枝", micro: true,
    mieru: ["背着生・不定型(チャアナタケと外見上区別不可)"],
    kettede: ["担子胞子6〜7×5〜6μm・類球形〜球形・無色・厚壁・デキストリノイド(決定的)", "チャアナタケとの鑑別は胞子サイズと色(本種は無色・大型)", "サンブスギに発生し溝腐病を起こす", "顕微鏡観察必須", "分布:本州以南"],
    shutten: [SOURCES.handbook2017] },
  { id: 62, wamei: "ツリバリサルノコシカケ", gakumei: "Phellinus wahlbergii", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹", part: "根株", micro: false,
    mieru: ["多年生・蹄形〜扁平・幅5〜15cm", "傘表面が粗く炭質・茶色〜黒茶色", "縁は土色"],
    kettede: ["子実層に先端が鈎状に曲がった剛毛体が多数(決定的)", "担子胞子4〜5.5×3〜4μm・類球形・無色〜薄い黄色", "分布:本州以南"],
    shutten: [SOURCES.handbook2017] },
  { id: 63, wamei: "ネンドタケ", gakumei: "Phellinus gilvus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "幹・枝", micro: false,
    mieru: ["半円形〜貝殻状・狐色〜茶色〜錆色・粗面・無環紋", "管孔面は見る角度により淡色から濃色に変わる(特徴)"],
    kettede: ["剛毛体が多数存在", "担子胞子4〜5×3〜4μm・広楕円形・無色", "分布:全国"],
    shutten: [SOURCES.handbook2017] },
  { id: 64, wamei: "モミサルノコシカケ", gakumei: "Phellinus hartigii", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹辺材腐朽・白色腐朽", host: "針葉樹・特にモミ類", part: "幹", micro: false,
    mieru: ["多年生・蹄形〜丸山形・幅5〜15cm", "傘表面は橙黄色〜黒色で環溝あり", "特にモミ類に発生"],
    kettede: ["子実層に剛毛体を欠く(タバコウロコタケ科の中での特徴)", "担子胞子径6〜8μm・類球形・厚壁・無色", "モミ類の溝腐病菌として知られる", "分布:全国"],
    shutten: [SOURCES.handbook2017] },
  { id: 65, wamei: "ムサシタケ", gakumei: "Pyrrhoderma adamantinum", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹", part: "根株・地際", micro: false,
    mieru: ["多年生・半円形〜扇形・幅5〜13cm", "傘表面が黒茶色〜黒色・堅い殻皮(1mm)・無毛", "地際部に発生"],
    kettede: ["傘表面の黒色殻皮と傘肉のクリーム〜橙色のコントラスト(決定的)", "担子胞子5〜7.5×6.5〜7.5μm・類球形・無色", "分布:本州のみ(比較的珍しい種)"],
    shutten: [SOURCES.handbook2017] },
];


// ============================================================
// メインコンポーネント
// ============================================================
export default function App() {
  const [photos, setPhotos] = useState([]);
  const [host, setHost] = useState("");
  const [part, setPart] = useState("幹上部");
  const [season, setSeason] = useState(`${new Date().getMonth() + 1}月`);
  const [rotFilter, setRotFilter] = useState("不明"); // 腐朽型(材の色)フィルタ
  // ↓ 観察の補足（任意）。写真で分かりにくい形質を人が補い、判断材料にする。
  const [hasStem, setHasStem] = useState("不明"); // 柄の有無
  const [shape, setShape] = useState("不明"); // 子実体の形状
  const [capColor, setCapColor] = useState(""); // 傘表面の色
  const [underside, setUnderside] = useState("不明"); // 裏面のタイプ
  const [texture, setTexture] = useState("不明"); // 質感
  const [bruising, setBruising] = useState(""); // 傷つけたときの変色など特記
  const [showMorph, setShowMorph] = useState(false); // 詳細な形態欄の開閉
  const [answers, setAnswers] = useState({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [records, setRecords] = useState([]);
  const [activeTab, setActiveTab] = useState("identify"); // "identify"=同定 / "species"=掲載種一覧

  // 手動登録(AIの候補にない種を樹木医が直接記録する)
  const [showManual, setShowManual] = useState(false);     // 手動登録欄の開閉
  const [manualMode, setManualMode] = useState("master");  // "master"=65種から選ぶ / "free"=自由入力
  const [manualMaster, setManualMaster] = useState("");    // 選択した和名(masterモード)
  const [manualWamei, setManualWamei] = useState("");      // 自由入力の和名(freeモード)
  const [manualGakumei, setManualGakumei] = useState("");  // 自由入力の学名(freeモード)
  const [manualReason, setManualReason] = useState("");    // なぜAIと違う判断をしたかのメモ

  // 写真を読み込む。スマホ写真はそのままだと数MBあり、APIに送るには大きすぎて
  // サーバーエラーになる。canvasで長辺1280pxに縮小し、JPEG品質0.8で圧縮してから持つ。
  // (現場写真は元ファイルを端末に残しておけばよいので、送信用は軽くて十分)
  function handlePhotos(e) {
    const files = Array.from(e.target.files || []);
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const maxSide = 1280; // 長辺の上限(px)
          let { width, height } = img;
          if (width > maxSide || height > maxSide) {
            if (width >= height) {
              height = Math.round((height * maxSide) / width);
              width = maxSide;
            } else {
              width = Math.round((width * maxSide) / height);
              height = maxSide;
            }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);
          // JPEGで再エンコード(品質0.8)。送信用に十分な画質で大幅に軽くなる
          const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
          const base64 = dataUrl.split(",")[1]; // Geminiへの送信用(inline_data)
          // プレビューは Data URL ではなく Object URL を使う。
          // Data URL は巨大な文字列をstateに抱え続け、複数枚でメモリを圧迫するため。
          // base64から一度だけBlob化し、その参照URLだけをstateに持つ。
          const blob = base64ToBlob(base64, "image/jpeg");
          const url = URL.createObjectURL(blob);
          setPhotos((prev) => [...prev, { url, base64, mime: "image/jpeg" }]);
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  }

  function removePhoto(i) {
    setPhotos((prev) => {
      // 削除する画像のObject URLを解放してメモリを返す
      const target = prev[i];
      if (target && target.url) URL.revokeObjectURL(target.url);
      return prev.filter((_, idx) => idx !== i);
    });
  }

  // ============================================================
  // 腐朽型フィルタ:入力した材の色に合う候補だけに絞る
  //   "白色" を選んだ場合 → rotType が "白色" か "両方" の種のみ
  //   "褐色" を選んだ場合 → rotType が "褐色" か "両方" の種のみ
  //   "不明" の場合 → 全種(フィルタしない)
  // ※「両方」は白色・褐色どちらでも残す(誤って候補から外さないため)
  // ============================================================
  function filterByRot(list) {
    if (rotFilter === "不明") return list;
    return list.filter((s) => s.rotType === rotFilter || s.rotType === "両方" || s.rotType === "変色");
  }

  // ============================================================
  // Claude API 呼び出し(65種・腐朽型フィルタ対応版)
  // ============================================================
  async function runNarrowing(currentAnswers) {
    setError("");
    if (photos.length === 0) {
      setError("写真を1枚以上アップロードしてください。");
      return;
    }
    setLoading(true);

    // 腐朽型フィルタを適用した候補リストをAIに渡す。
    // ただし出典(長い文字列)・kenshou・rot説明文など識別に不要なものは外し、
    // AIが候補選定に使う最小限のフィールドだけに絞る。
    // (全フィールドをそのまま送るとリクエストが大きくなりすぎてサーバーエラーになる)
    const candidateList = filterByRot(speciesMaster).map((s) => ({
      wamei: s.wamei,
      gakumei: s.gakumei,
      rotType: s.rotType,
      host: s.host,
      part: s.part,
      micro: s.micro,
      mieru: s.mieru,
      kettede: s.kettede,
    }));

    const answeredText =
      Object.keys(currentAnswers).length > 0
        ? Object.entries(currentAnswers).map(([k, v]) => `・${k}:${v}`).join("\n")
        : "(まだ確認済みの決め手はありません)";

    const rotText =
      rotFilter === "不明"
        ? "未確認(腐朽型での絞り込みなし)"
        : `${rotFilter}腐朽(材がその色)`;

    // 形態の入力をまとめる。「不明」「空欄」は未入力として扱い、入力のあるものだけ渡す。
    const morphPairs = [
      ["子実体の型", shape],
      ["柄の有無", hasStem],
      ["裏面(胞子を作る面)", underside],
      ["傘表面の色", capColor],
      ["質感", texture],
      ["傷つけたときの変色・特記", bruising],
    ].filter(([, v]) => v && v !== "不明");
    const morphText =
      morphPairs.length > 0
        ? morphPairs.map(([k, v]) => `・${k}:${v}`).join("\n")
        : "(形態の入力なし)";

    const instruction = `
あなたは木材腐朽菌の同定を補助する助手です。判定者ではありません。
このシステムが扱うのは「緑化樹木の主要木材腐朽菌」です。
以下の「候補リスト」の中からのみ候補を選び、リスト外の菌は絶対に挙げないでください。
(テングタケ・シイタケ等の一般的なキノコは現時点では未収録です)

# 観察情報
- 宿主樹種:${host || "不明"}
- 発生部位:${part}
- 季節:${season}
- 腐朽型(材の色):${rotText}
- 観察された形態(人が肉眼で確認した特徴):
${morphText}
- 確認済みの決め手(人が確認した事実):
${answeredText}

# 候補リスト(腐朽型フィルタ適用済み・全${candidateList.length}種)
各種のフィールド: rotType=腐朽型 / micro=true は顕微鏡確認が必須の種
${JSON.stringify(candidateList)}

# あなたの仕事
1. 写真と観察情報から、候補を最大4つ、確信度(0〜1)付きで順位付けする。
2. 各種の mieru(肉眼で見える特徴)/ kettede(決め手)に照らして判断する。
3. 各候補で「写真から見えた特徴(mieru)」と「未確認の決め手(miketsu)」を分ける。
4. micro が true の種、または kettede に「顕微鏡」「メルツァー」「KOH」「担子胞子」など
   現地で見えない確認項目が含まれる種を候補に挙げる場合は、
   riyu に「※現地観察のみでは困難・採取して顕微鏡(または試薬)確認を推奨」と明記する。
5. 腐朽型(材の色)が確認済みの場合、それと矛盾する種は候補から外す
   (例:白色腐朽と分かっているのに褐色腐朽菌を挙げない)。
   ただし rotType が「両方」「変色」の種は除外しない。
6. 「観察された形態」(人が肉眼で確認した型・柄・裏面・色・質感・変色)は、
   写真よりも確実な事実として扱う。各種の mieru/kettede と照らし、
   形態が明らかに矛盾する種は確信度を下げるか候補から外す。
   例:裏面が「ヒダ」なら管孔をもつサルノコシカケ型の多孔菌は候補から外す。
   例:柄が「有柄」なら無柄の種は下げる。例:傷で「チョコレート色に変色」はコフキタケを支持。
   ただし「不明・入力なし」の項目は判断に使わない(減点しない)。
7. 候補を絞るために次に確認すべき決め手の質問を最大3つ出す(選択肢付き)。
   質問は候補同士を最も効率よく分けられるもの
   (腐朽型・KOH反応・断面肉色・管孔/孔口・剛毛体の有無・宿主樹種など)を優先。
8. 決め手が不足していれば断定せず hantei を「保留」にする。十分なら「確定候補」。
9. 確信度は控えめに。迷う場合は必ず保留。
10. shoken には、写真そのものから見えた特徴を樹木医に伝えるつもりで
    2〜3文の自然な日本語で書く(色・形・大きさの印象・発生位置・群生の様子など)。
    候補の絞り込みとは別に、観察の助けとして読まれる。

# 出力(厳守)
JSONのみ。前置き・後置き・コードフェンス(\`\`\`)は一切付けない。
{
 "shoken":"写真から見えた特徴の自然文(2〜3文)",
 "candidates":[{"wamei":"","gakumei":"","conf":0.0,"kenshou":"","micro":false,"mieru":[""],"miketsu":[""],"riyu":""}],
 "questions":[{"kettede":"","q":"","sentakushi":["",""]}],
 "hantei":"保留 または 確定候補",
 "comment":"次にすべきこと(打診・KOH・断面確認・採取など)を一言"
}`.trim();

    // --- Gemini形式のリクエストを組み立てる ---
    // parts に「画像（複数可）」＋「プロンプト文（instruction）」を並べる。
    // inline_data で画像のbase64を渡す（GAS画像テストで実証済みの形式）。
    const parts = [
      ...photos.map((p) => ({
        inline_data: { mime_type: p.mime || "image/jpeg", data: p.base64 },
      })),
      { text: instruction },
    ];

    const geminiBody = {
      contents: [{ parts }],
      generationConfig: {
        // 応答をJSONだけにさせる（前置きやコードフェンスを防ぐ）
        responseMimeType: "application/json",
        // 出力上限。gemini-2.5-flash は最大65,535まで可能。
        // 候補4件＋検索表3問の日本語JSONが収まるよう余裕をもたせる。
        maxOutputTokens: 8192,
        // gemini-2.5-flash は「思考」がデフォルトON。思考トークンが
        // maxOutputTokens を食い、本文JSONが途中で切れる原因になる。
        // この同定タスクでは思考不要なので 0 で無効化する。
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    try {
      // GAS（中継Web App）に送る。
      // Content-Type を text/plain にするのは CORS のプリフライトを避けるため。
      // （GAS Web App は CORS ヘッダーを自前で付けられないので、この回避策を使う）
      const res = await fetch(GAS_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(geminiBody),
      });

      if (!res.ok) {
        const t = await res.text().catch(() => "");
        setError(`中継サーバー(GAS)からHTTP ${res.status} が返りました。${t.slice(0, 200)}`);
        return;
      }

      // GASはGeminiの生レスポンス(JSON)をそのまま返す。
      // ただしGemini側がエラーのときは {error, status, detail} を返す作りにしてある。
      const raw = await res.json();

      if (raw && raw.error) {
        setError(
          "Gemini中継エラー:" +
            (raw.detail ? String(raw.detail).slice(0, 200) : raw.error)
        );
        return;
      }

      // Geminiの返事の本文を取り出す
      //   形は raw.candidates[0].content.parts[0].text
      const text =
        raw &&
        raw.candidates &&
        raw.candidates[0] &&
        raw.candidates[0].content &&
        raw.candidates[0].content.parts &&
        raw.candidates[0].content.parts[0] &&
        raw.candidates[0].content.parts[0].text;

      if (!text || !text.trim()) {
        // 安全フィルタでブロックされた等の場合も拾う
        const reason =
          (raw && raw.candidates && raw.candidates[0] && raw.candidates[0].finishReason) ||
          (raw && raw.promptFeedback && raw.promptFeedback.blockReason) ||
          "";
        setError(
          "AIから空の応答が返りました。" +
            (reason ? `理由:${reason}。` : "") +
            "写真の枚数を減らすか、別の写真でお試しください。"
        );
        return;
      }

      // responseMimeType:application/json を指定しているので基本はそのままJSON。
      // 念のためコードフェンスが付いていた場合に備えて除去してから解釈する。
      const clean = text.replace(/```json|```/g, "").trim();
      try {
        const parsed = JSON.parse(clean);
        setResult(parsed);
      } catch {
        // finishReason が MAX_TOKENS なら出力上限で途中切れ＝設定の問題と分かる
        const fr =
          (raw && raw.candidates && raw.candidates[0] && raw.candidates[0].finishReason) || "";
        if (fr === "MAX_TOKENS") {
          setError(
            "AIの応答が長すぎて途中で切れました(MAX_TOKENS)。" +
              "写真の枚数を減らすか、開発者に出力上限の調整を相談してください。"
          );
        } else {
          setError(
            "AIの応答をJSONとして解釈できませんでした。" +
              (fr ? `(終了理由:${fr})` : "") +
              "応答冒頭:" + clean.slice(0, 120)
          );
        }
      }
    } catch (err) {
      // ここに来るのは本当の通信失敗(ネットワーク断・CORS等)
      setError("通信に失敗しました:" + (err?.message || "ネットワークを確認してください"));
    } finally {
      setLoading(false);
    }
  }

  function answerQuestion(kettede, value) {
    const next = { ...answers, [kettede]: value };
    setAnswers(next);
    runNarrowing(next);
  }

  // AIの候補カードから確定したときの記録(従来からの動作)
  function saveRecord(cand) {
    const rec = makeRecord({
      wamei: cand.wamei,
      gakumei: cand.gakumei || "",
      kenshou: cand.kenshou || "",
      confidence: cand.conf,
      ai_riyu: cand.riyu || "",
      source: "from_ai", // 情報源タグ:AIの候補から確定
    });
    setRecords((prev) => [...prev, rec]);
  }

  // 手動登録(AIの候補にない種を樹木医が直接確定するときの記録)
  function saveManualRecord() {
    let wamei, gakumei, kenshou, source;
    if (manualMode === "master") {
      // 65種プルダウンから選んだ場合:speciesMasterから正確な情報を引く
      if (!manualMaster) {
        alert("種を選択してください。");
        return;
      }
      const m = speciesMaster.find((s) => s.wamei === manualMaster);
      if (!m) return;
      wamei = m.wamei;
      gakumei = m.gakumei;
      kenshou = m.kenshou;
      source = "from_master"; // 情報源タグ:65種プルダウンから選択
    } else {
      // 自由入力の場合
      if (!manualWamei.trim()) {
        alert("和名を入力してください。");
        return;
      }
      wamei = manualWamei.trim();
      gakumei = manualGakumei.trim();
      kenshou = ""; // 65種外なので検証状態はなし
      source = "from_manual"; // 情報源タグ:自由入力
    }

    const rec = makeRecord({
      wamei, gakumei, kenshou,
      confidence: null, // 手動なので確信度なし
      ai_riyu: "",
      source,
      manual_reason: manualReason.trim(), // なぜAIと違う判断をしたかのメモ
    });
    setRecords((prev) => [...prev, rec]);

    // 入力欄をリセット
    setManualMaster("");
    setManualWamei("");
    setManualGakumei("");
    setManualReason("");
    setShowManual(false);
  }

  // 記録オブジェクトを組み立てる共通処理(AI由来・手動由来で共通の項目をまとめる)
  function makeRecord({ wamei, gakumei, kenshou, confidence, ai_riyu, source, manual_reason }) {
    return {
      kakutei_wamei: wamei,
      kakutei_gakumei: gakumei,
      kenshou_joutai: kenshou,
      confidence,
      jouhougen: source, // 情報源タグ:from_ai / from_master / from_manual
      host, part, season,
      rot_filter: rotFilter,
      // 観察された形態(不明・空欄も含めてそのまま残す)
      keitai: {
        kata: shape,
        e_no_umu: hasStem,
        uramen: underside,
        shitsukan: texture,
        kasa_iro: capColor,
        henshoku: bruising,
      },
      kakuninzumi_kettede: answers,
      ai_riyu,
      ...(manual_reason ? { ningen_riyu: manual_reason } : {}),
      // AIが出した所見も記録に残す(後で精度を振り返るとき有用)
      ai_shoken: result?.shoken || "",
      kiroku_nichiji: new Date().toISOString(),
      shashin_maisu: photos.length,
    };
  }

  function exportJSON() {
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `木材腐朽菌記録_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 検証状態バッジの色(v0.3では全種「済」だが将来の混在に備えて残す)
  function kenshouBadge(k) {
    if (k === "済") return { label: "裏取り済", bg: "#E6EFE3", fg: C.sage };
    if (k === "叩き台") return { label: "叩き台・要裏取り", bg: "#FAF1D8", fg: C.amber };
    return { label: "未検証(名前のみ)", bg: "#F0E7E0", fg: C.rust };
  }

  // 腐朽型フィルタ適用後の候補数(画面表示用)
  const filteredCount = filterByRot(speciesMaster).length;

  // ============================================================
  // 画面
  // ============================================================
  return (
    <div style={{ minHeight: "100vh", background: C.paper, color: C.ink, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "20px 16px 64px" }}>

        <header style={{ borderBottom: `2px solid ${C.ink}`, paddingBottom: 12, marginBottom: 16 }}>
          <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: C.rust, letterSpacing: 1 }}>
            WOOD-DECAY FUNGI · 絞り込みPoC v0.7 · 収録65種
          </div>
          <h1 style={{ fontFamily: "Georgia, serif", fontSize: 26, margin: "4px 0 2px", fontWeight: 700 }}>
            木材腐朽菌 同定アシスト
          </h1>
          <p style={{ fontSize: 13, color: C.sub, margin: 0 }}>
            AIで候補を絞り、検索表の質問で確定に導きます。判定はあなた(樹木医)が行います。
          </p>

          {/* 対象範囲の注意書き */}
          <div style={{
            marginTop: 10, padding: "8px 12px", borderRadius: 6, fontSize: 12,
            background: "#F3F1E8", border: `1px solid ${C.line}`, color: C.sub, lineHeight: 1.6,
          }}>
            <b style={{ color: C.ink }}>対象範囲</b>:現時点では<b>緑化樹木の主要木材腐朽菌(65種)</b>のみを収録しています。
            テングタケ・タマゴタケ・シイタケ・エノキなど普段見かけるキノコは順次追加予定です。
            <br />
            データは「緑化樹木腐朽病害ハンドブック」(日本緑化センター)に基づきます。
            腐朽菌は図鑑により色表現や説明が異なるため、今後ほかの資料の記載も併記していきます。
          </div>
        </header>

        {/* タブ切り替え（同定 / 掲載種一覧） */}
        <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
          <button
            onClick={() => setActiveTab("identify")}
            style={tabStyle(activeTab === "identify")}
          >
            同定
          </button>
          <button
            onClick={() => setActiveTab("species")}
            style={tabStyle(activeTab === "species")}
          >
            掲載種一覧({speciesMaster.length})
          </button>
        </div>

        {activeTab === "identify" && (
          <>
        <section style={cardStyle()}>
          <SectionLabel>1. 観察情報を入力</SectionLabel>

          <label style={{ fontSize: 13, fontWeight: 600 }}>現場写真(複数可)</label>
          <input type="file" accept="image/*" multiple onChange={handlePhotos}
                 style={{ display: "block", marginTop: 6, fontSize: 13 }} />
          {photos.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
              {photos.map((p, i) => (
                <div key={i} style={{ position: "relative" }}>
                  <img src={p.url} alt="" style={{ width: 76, height: 76, objectFit: "cover", borderRadius: 6, border: `1px solid ${C.line}` }} />
                  <button onClick={() => removePhoto(i)} aria-label="削除"
                          style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", border: "none", background: C.ink, color: "#fff", cursor: "pointer", fontSize: 12 }}>×</button>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
            <Field label="宿主樹種">
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="例:サクラ" style={inputStyle()} />
            </Field>
            <Field label="発生部位">
              <select value={part} onChange={(e) => setPart(e.target.value)} style={inputStyle()}>
                <option>根株・幹基部</option>
                <option>幹下部</option>
                <option>幹上部</option>
                <option>枝</option>
              </select>
            </Field>
            <Field label="季節(発生時期)">
              <input value={season} onChange={(e) => setSeason(e.target.value)} style={inputStyle()} />
            </Field>
            {/* 腐朽型(材の色)フィルタ */}
            <Field label="腐朽型(材の色)">
              <select value={rotFilter} onChange={(e) => setRotFilter(e.target.value)} style={inputStyle()}>
                <option value="不明">不明・未確認</option>
                <option value="白色">白色腐朽(材が白っぽく繊維状)</option>
                <option value="褐色">褐色腐朽(材が褐色で角状に崩れる)</option>
              </select>
            </Field>
          </div>

          {/* 腐朽型フィルタの効き具合を表示 */}
          <p style={{ fontSize: 12, color: rotFilter === "不明" ? C.sub : C.sage, margin: "8px 0 0" }}>
            {rotFilter === "不明"
              ? `絞り込み対象:全${speciesMaster.length}種(腐朽型を選ぶと候補を半分以下に絞れます)`
              : `腐朽型「${rotFilter}」で絞り込み中 → 候補 ${filteredCount}種`}
          </p>

          {/* 詳細な形態(任意)：折りたたみ。分かる範囲で入れると精度が上がる */}
          <div style={{ marginTop: 12, borderTop: `1px dashed ${C.line}`, paddingTop: 10 }}>
            <button
              onClick={() => setShowMorph((v) => !v)}
              style={{ background: "none", border: "none", color: C.rust, fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 0 }}
            >
              {showMorph ? "▼" : "▶"} 詳細な形態を入力(任意・分かる範囲でOK)
            </button>

            {showMorph && (
              <div style={{ marginTop: 10 }}>
                <p style={{ fontSize: 12, color: C.sub, margin: "0 0 10px" }}>
                  写真で分かりにくい特徴ほど、入れると候補が絞れます。分からない項目は「不明」のままで構いません。
                </p>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <Field label="子実体の型">
                    <select value={shape} onChange={(e) => setShape(e.target.value)} style={inputStyle()}>
                      <option value="不明">不明</option>
                      <option value="サルノコシカケ型(棚・半円)">サルノコシカケ型(棚・半円)</option>
                      <option value="膏薬状(背着・平たく貼りつく)">膏薬状(背着・平たく貼りつく)</option>
                      <option value="キノコ型(傘と柄)">キノコ型(傘と柄)</option>
                      <option value="耳状・ゼラチン質">耳状・ゼラチン質</option>
                      <option value="その他">その他</option>
                    </select>
                  </Field>
                  <Field label="柄の有無">
                    <select value={hasStem} onChange={(e) => setHasStem(e.target.value)} style={inputStyle()}>
                      <option value="不明">不明</option>
                      <option value="無柄(柄がない)">無柄(柄がない)</option>
                      <option value="有柄(柄がある)">有柄(柄がある)</option>
                    </select>
                  </Field>
                  <Field label="裏面(胞子を作る面)">
                    <select value={underside} onChange={(e) => setUnderside(e.target.value)} style={inputStyle()}>
                      <option value="不明">不明</option>
                      <option value="管孔(細かい穴)">管孔(細かい穴)</option>
                      <option value="ヒダ">ヒダ</option>
                      <option value="針・歯牙状">針・歯牙状</option>
                      <option value="平滑・しわ状">平滑・しわ状</option>
                    </select>
                  </Field>
                  <Field label="質感">
                    <select value={texture} onChange={(e) => setTexture(e.target.value)} style={inputStyle()}>
                      <option value="不明">不明</option>
                      <option value="コルク質・木質(硬い)">コルク質・木質(硬い)</option>
                      <option value="肉質(柔らかい)">肉質(柔らかい)</option>
                      <option value="ゼラチン質">ゼラチン質</option>
                      <option value="炭質(もろい)">炭質(もろい)</option>
                    </select>
                  </Field>
                  <Field label="傘表面の色">
                    <input value={capColor} onChange={(e) => setCapColor(e.target.value)} placeholder="例:茶色、黄色、黒っぽい" style={inputStyle()} />
                  </Field>
                  <Field label="傷つけたときの変色など">
                    <input value={bruising} onChange={(e) => setBruising(e.target.value)} placeholder="例:傷でチョコレート色" style={inputStyle()} />
                  </Field>
                </div>
              </div>
            )}
          </div>

          <button onClick={() => runNarrowing(answers)} disabled={loading} style={primaryBtn(loading)}>
            {loading ? "絞り込み中…" : "候補を絞る"}
          </button>
          {error && <p style={{ color: C.rust, fontSize: 13, marginTop: 10 }}>{error}</p>}
        </section>

        {result && (
          <section style={{ ...cardStyle(), marginTop: 16 }}>
            <SectionLabel>2. 候補と判定</SectionLabel>

            <div style={{
              padding: "8px 12px", borderRadius: 6, fontSize: 13, fontWeight: 600, marginBottom: 12,
              background: result.hantei === "保留" ? "#FAF1D8" : "#E6EFE3",
              color: result.hantei === "保留" ? C.amber : C.sage,
              border: `1px solid ${result.hantei === "保留" ? C.amber : C.sage}`,
            }}>
              判定:{result.hantei}　<span style={{ fontWeight: 400, color: C.ink }}>{result.comment}</span>
            </div>

            {/* Geminiが写真から読み取った所見の自然文。候補とは別の観察補助。 */}
            {result.shoken && (
              <div style={{ marginBottom: 12, padding: 10, borderRadius: 6, background: "#F3F1E8", border: `1px solid ${C.line}` }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.rust, letterSpacing: 0.5, marginBottom: 4 }}>
                  写真から見えた特徴(AIの所見)
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.7, color: C.ink }}>
                  {result.shoken}
                </div>
              </div>
            )}

            {(result.candidates || []).map((c, i) => {
              // kenshou(検証状態)は我々のマスターデータが持つ事実なので、
              // AIの返り値ではなく speciesMaster から和名で引いて表示する。
              // (candidateListにkenshouを渡していないため、AIのc.kenshouは不正確になりうる)
              const master = speciesMaster.find((s) => s.wamei === c.wamei);
              const badge = kenshouBadge(master ? master.kenshou : c.kenshou);
              return (
                <div key={i} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: 12, marginBottom: 10, background: "#fff" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 4 }}>
                    <div>
                      <span style={{ fontWeight: 700, fontSize: 16 }}>{c.wamei}</span>
                      <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: C.sub, marginLeft: 8 }}>{c.gakumei}</span>
                    </div>
                    <span style={{ fontSize: 12, color: C.sub }}>確信度 {Math.round((c.conf || 0) * 100)}%</span>
                  </div>

                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "4px 0 2px" }}>
                    <span style={{ display: "inline-block", fontSize: 11, fontWeight: 700, padding: "1px 8px", borderRadius: 10, background: badge.bg, color: badge.fg }}>
                      {badge.label}
                    </span>
                    {/* 顕微鏡必須フラグ */}
                    {c.micro && (
                      <span style={{ display: "inline-block", fontSize: 11, fontWeight: 700, padding: "1px 8px", borderRadius: 10, background: "#FAF1D8", color: C.amber, border: `1px solid ${C.amber}` }}>
                        顕微鏡確認推奨
                      </span>
                    )}
                  </div>

                  <div style={{ height: 6, background: C.line, borderRadius: 3, margin: "6px 0 10px" }}>
                    <div style={{ width: `${Math.round((c.conf || 0) * 100)}%`, height: "100%", background: C.rust, borderRadius: 3 }} />
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    <ChipBox title="写真で見えた" color={C.sage} items={c.mieru} />
                    <ChipBox title="未確認の決め手" color={C.amber} items={c.miketsu} />
                  </div>
                  {c.riyu && <p style={{ fontSize: 12, color: C.sub, margin: "8px 0 0" }}>根拠:{c.riyu}</p>}

                  <button onClick={() => saveRecord(c)} style={ghostBtn()}>この種で確定として記録</button>
                </div>
              );
            })}

            {/* 該当候補がないときの手動登録 */}
            <div style={{ marginTop: 16, padding: 12, borderRadius: 8, border: `1px dashed ${C.line}`, background: "#FAF9F4" }}>
              <button
                onClick={() => setShowManual((v) => !v)}
                style={{ background: "none", border: "none", color: C.rust, fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 0 }}
              >
                {showManual ? "▼" : "▶"} 該当候補がない場合は手動で登録
              </button>
              {showManual && (
                <div style={{ marginTop: 12 }}>
                  <p style={{ fontSize: 12, color: C.sub, margin: "0 0 10px" }}>
                    AIが判別を外した・候補に出ていない種を樹木医が確定して記録できます。
                    記録には「手動登録」のタグが付き、後で振り返れます。
                  </p>

                  {/* モード切替:65種から選ぶ or 自由入力 */}
                  <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                    <button
                      onClick={() => setManualMode("master")}
                      style={miniTabStyle(manualMode === "master")}
                    >
                      65種から選ぶ
                    </button>
                    <button
                      onClick={() => setManualMode("free")}
                      style={miniTabStyle(manualMode === "free")}
                    >
                      自由入力(65種外)
                    </button>
                  </div>

                  {manualMode === "master" && (
                    <Field label="種(和名で選択)">
                      <select
                        value={manualMaster}
                        onChange={(e) => setManualMaster(e.target.value)}
                        style={inputStyle()}
                      >
                        <option value="">-- 選択してください --</option>
                        {speciesMaster.map((s) => (
                          <option key={s.id} value={s.wamei}>
                            {s.wamei}（{s.gakumei}）
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}

                  {manualMode === "free" && (
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <Field label="和名">
                        <input
                          value={manualWamei}
                          onChange={(e) => setManualWamei(e.target.value)}
                          placeholder="例:テングタケ"
                          style={inputStyle()}
                        />
                      </Field>
                      <Field label="学名(任意)">
                        <input
                          value={manualGakumei}
                          onChange={(e) => setManualGakumei(e.target.value)}
                          placeholder="例:Amanita pantherina"
                          style={inputStyle()}
                        />
                      </Field>
                    </div>
                  )}

                  <Field label="判断理由(任意・後で精度向上に活用)">
                    <input
                      value={manualReason}
                      onChange={(e) => setManualReason(e.target.value)}
                      placeholder="例:KOH反応で確認、宿主から確定 など"
                      style={inputStyle()}
                    />
                  </Field>

                  <button onClick={saveManualRecord} style={primaryBtn(false)}>
                    手動登録として記録
                  </button>
                </div>
              )}
            </div>
          </section>
        )}

        {result && (result.questions || []).length > 0 && (
          <section style={{ ...cardStyle(), marginTop: 16 }}>
            <SectionLabel>3. 決め手を確認(検索表)</SectionLabel>
            <p style={{ fontSize: 12, color: C.sub, marginTop: 0 }}>
              写真では分からない決め手です。現地・室内で確認し、回答すると候補を絞り直します。
            </p>
            {result.questions.map((q, i) => (
              <div key={i} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{q.q}</div>
                <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: C.rust }}>{q.kettede}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
                  {(q.sentakushi || []).map((opt, j) => {
                    const selected = answers[q.kettede] === opt;
                    return (
                      <button key={j} onClick={() => answerQuestion(q.kettede, opt)}
                              style={{
                                padding: "6px 12px", borderRadius: 16, fontSize: 13, cursor: "pointer",
                                border: `1px solid ${selected ? C.sage : C.line}`,
                                background: selected ? C.sage : "#fff",
                                color: selected ? "#fff" : C.ink,
                              }}>
                        {opt}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
        )}

        {records.length > 0 && (
          <section style={{ ...cardStyle(), marginTop: 16 }}>
            <SectionLabel>4. 記録({records.length}件)</SectionLabel>
            {records.map((r, i) => {
              // 情報源タグの見た目
              const sourceLabel =
                r.jouhougen === "from_ai"     ? { txt: "AI確定", bg: "#E6EFE3", fg: C.sage } :
                r.jouhougen === "from_master" ? { txt: "手動(65種)", bg: "#FAF1D8", fg: C.amber } :
                r.jouhougen === "from_manual" ? { txt: "手動(自由)", bg: "#F0E7E0", fg: C.rust } :
                                                 null;
              return (
                <div key={i} style={{ fontSize: 13, padding: "6px 0", borderBottom: `1px solid ${C.line}` }}>
                  {sourceLabel && (
                    <span style={{ display: "inline-block", fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8, background: sourceLabel.bg, color: sourceLabel.fg, marginRight: 6 }}>
                      {sourceLabel.txt}
                    </span>
                  )}
                  <b>{r.kakutei_wamei}</b>
                  {r.confidence != null && `(確信度 ${Math.round(r.confidence * 100)}%)`}
                  ／宿主:{r.host || "不明"}／{r.part}
                  {r.rot_filter !== "不明" && `／${r.rot_filter}腐朽`}
                </div>
              );
            })}
            <button onClick={exportJSON} style={primaryBtn(false)}>記録をJSONで書き出す</button>
          </section>
        )}
          </>
        )}

        {activeTab === "species" && <SpeciesList />}

        <footer style={{ marginTop: 32, fontSize: 11, color: C.sub, textAlign: "center" }}>
          AIは候補出しの助手です。最終判定は樹木医が検索表で確定してください。<br />
          対象は緑化樹木の主要木材腐朽菌(65種)。一般のキノコは順次追加予定。<br />
          © 2026 Koh Kitsukawa. All rights reserved.
        </footer>
      </div>
    </div>
  );
}

// ---- 小部品 ----
function SectionLabel({ children }) {
  return (
    <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: C.rust, marginBottom: 10, letterSpacing: 0.5 }}>
      {children}
    </div>
  );
}
function Field({ label, children }) {
  return (
    <div>
      <label style={{ fontSize: 12, color: C.sub, display: "block", marginBottom: 3 }}>{label}</label>
      {children}
    </div>
  );
}
function ChipBox({ title, color, items }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color, marginBottom: 4 }}>{title}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {(items || []).map((t, i) => (
          <span key={i} style={{ fontSize: 12, padding: "2px 8px", borderRadius: 4, background: "#F1F0E8", border: `1px solid ${C.line}` }}>{t}</span>
        ))}
      </div>
    </div>
  );
}

function cardStyle() {
  return { background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16 };
}
function inputStyle() {
  return { width: "100%", boxSizing: "border-box", padding: "7px 9px", fontSize: 13, border: `1px solid ${C.line}`, borderRadius: 6, background: "#fff" };
}
function primaryBtn(disabled) {
  return { width: "100%", marginTop: 14, padding: "11px", fontSize: 14, fontWeight: 700, color: "#fff", background: disabled ? C.sub : C.ink, border: "none", borderRadius: 8, cursor: disabled ? "default" : "pointer" };
}
function ghostBtn() {
  return { marginTop: 10, padding: "7px 12px", fontSize: 12, color: C.ink, background: "#fff", border: `1px solid ${C.ink}`, borderRadius: 6, cursor: "pointer" };
}

// タブボタンのスタイル（active=選択中）
function tabStyle(active) {
  return {
    flex: 1,
    padding: "9px 12px",
    fontSize: 14,
    fontWeight: 700,
    cursor: "pointer",
    color: active ? "#fff" : C.sub,
    background: active ? C.ink : "transparent",
    border: `1px solid ${active ? C.ink : C.line}`,
    borderRadius: 8,
  };
}

// 小型タブ(手動登録のモード切替用)
function miniTabStyle(active) {
  return {
    padding: "5px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    color: active ? "#fff" : C.sub,
    background: active ? C.rust : "transparent",
    border: `1px solid ${active ? C.rust : C.line}`,
    borderRadius: 6,
  };
}

// ============================================================
// 掲載種一覧タブ
//   speciesMaster（全65種）を検索・腐朽型フィルタ付きで一覧表示する。
//   ※将来：各種に photo フィールド（自分で撮った参照写真のURL等）を足せば、
//     ここに写真サムネイルを出せる。今は素材がないので未実装。
// ============================================================
function SpeciesList() {
  const [q, setQ] = useState(""); // 和名・学名・宿主で絞る
  const [rot, setRot] = useState("全て"); // 腐朽型フィルタ

  const list = speciesMaster.filter((s) => {
    // 腐朽型フィルタ
    if (rot !== "全て") {
      if (!(s.rotType === rot || s.rotType === "両方" || s.rotType === "変色")) return false;
    }
    // テキスト検索（和名・学名・宿主・科）
    if (q.trim()) {
      const hay = `${s.wamei} ${s.gakumei} ${s.host} ${s.kamei}`.toLowerCase();
      if (!hay.includes(q.trim().toLowerCase())) return false;
    }
    return true;
  });

  return (
    <section style={cardStyle()}>
      <SectionLabel>掲載種一覧({list.length} / {speciesMaster.length}種)</SectionLabel>
      <p style={{ fontSize: 12, color: C.sub, marginTop: 0 }}>
        収録している緑化樹木の主要木材腐朽菌です。和名・学名・宿主で検索できます。
      </p>

      {/* 検索・フィルタ */}
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10, marginBottom: 12 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="検索(例:サクラ / ベッコウ / Ganoderma)"
          style={inputStyle()}
        />
        <select value={rot} onChange={(e) => setRot(e.target.value)} style={inputStyle()}>
          <option value="全て">腐朽型:全て</option>
          <option value="白色">白色腐朽</option>
          <option value="褐色">褐色腐朽</option>
        </select>
      </div>

      {/* 種カード一覧 */}
      {list.map((s) => (
        <div key={s.id} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: 12, marginBottom: 10, background: "#fff" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 4 }}>
            <div>
              <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: C.rust, marginRight: 6 }}>No.{s.id}</span>
              <span style={{ fontWeight: 700, fontSize: 16 }}>{s.wamei}</span>
              <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: C.sub, marginLeft: 8 }}>{s.gakumei}</span>
            </div>
          </div>
          <div style={{ fontSize: 12, color: C.sub, margin: "2px 0 6px" }}>{s.kamei}</div>

          {/* バッジ */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            <Badge bg={s.rotType === "褐色" ? "#F0E7E0" : "#E6EFE3"} fg={s.rotType === "褐色" ? C.rust : C.sage}>
              {s.rot}
            </Badge>
            {s.micro && <Badge bg="#FAF1D8" fg={C.amber}>顕微鏡確認推奨</Badge>}
          </div>

          <div style={{ fontSize: 13, lineHeight: 1.7 }}>
            <div><b>宿主</b>:{s.host}</div>
            <div><b>発生部位</b>:{s.part}</div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 8 }}>
            <ChipBox title="見える特徴" color={C.sage} items={s.mieru} />
            <ChipBox title="決め手" color={C.amber} items={s.kettede} />
          </div>

          <div style={{ fontSize: 11, color: C.sub, marginTop: 8 }}>出典:{s.shutten.join(" / ")}</div>
        </div>
      ))}

      {list.length === 0 && (
        <p style={{ fontSize: 13, color: C.sub }}>該当する種がありません。検索条件を変えてください。</p>
      )}
    </section>
  );
}

// base64文字列をBlob(バイナリ)に変換する。プレビュー用のObject URL生成に使う。
function base64ToBlob(base64, mime) {
  const bin = atob(base64); // base64 → バイナリ文字列
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// 小さなバッジ
function Badge({ bg, fg, children }) {
  return (
    <span style={{ display: "inline-block", fontSize: 11, fontWeight: 700, padding: "1px 8px", borderRadius: 10, background: bg, color: fg }}>
      {children}
    </span>
  );
}
