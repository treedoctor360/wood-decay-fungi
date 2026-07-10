// ============================================================
// 木材腐朽菌 絞り込みPoC  v0.8
// 方式A':GAS経由でGemini(gemini-2.5-flash)を呼ぶオンライン版
//
// v0.7 → v0.8 の変更点(IndexedDB + GAS同期・記録タブ追加):
//   ①端末内保存(IndexedDB): 記録をブラウザのIndexedDBに永続保存。
//     アプリを閉じても消えない。オフライン環境でも記録できる。
//   ②GAS DB同期: 別途用意した記録管理GAS(DB中継WebApp)と同期。
//     - 起動時に自動同期(IndexedDB → GASアップ / GASダウン → IndexedDB)
//     - オンライン復帰時にも自動同期
//     - 手動同期ボタンも追加
//   ③記録タブ追加: 3枚目のタブ「記録」に同期済みの全記録を一覧表示。
//     - 自分の記録(contributor一致)のみ削除ボタンを表示
//     - 他の樹木医の記録も閲覧可能(削除不可)
//     - 同期状態バッジ(未同期/同期済)を各レコードに表示
//   ④同定タブの記録欄を削除(記録タブに移動)
//   ⑤makeRecord()に record_id / contributor / created_at / updated_at /
//     synced / DB列対応フィールドを追加(旧フィールドは後方互換で保持)
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
//
// 方針(再掲):AIは候補出し・観察ガイドの助手。判定者は樹木医。
//   © 2026 Koh Kitsukawa. All rights reserved.
// ============================================================

import { useState, useEffect } from "react";
import { keyPromptBlock } from "./data/searchKey";

// ============================================================
// AI接続設定（GAS経由でGeminiを呼ぶ）
//   GAS_URL は「Gemini中継Web App（GAS）」のデプロイURL。
//   GASがGeminiのAPIキーを隠して中継するので、ここにキーは書かない。
//   RELAY_TOKEN は任意。GAS側スクリプトプロパティ SHARED_TOKEN を設定した
//   場合のみ照合される（未設定なら無視される）。URLを拾ったボット除け。
//   ※クライアントJSに見えるので本気の攻撃者には無力。主防御はGAS側の
//     1日レート制限＋無料枠キー＋Cloud予算上限。
// ============================================================
const GAS_URL =
  "https://script.google.com/macros/s/AKfycbwfSHmBl8VYy635RPq0hnc_q_wJw1Cgrg0NzXDcucBmK0jTVOvDKbMxeYqvr-UtCyJ9fQ/exec";
const RELAY_TOKEN = ""; // 任意。GAS側 SHARED_TOKEN を設定したら同じ値を入れる

// ============================================================
// v0.8追加: IndexedDB(端末内保存) + GAS同期 設定
//   GAS_DB_URL と DB_TOKEN は記録管理GAS(DB中継WebApp)のURLとトークン。
//   GASデプロイ後にここを書き換えてpushする(チャットには貼らない)。
// ============================================================
const GAS_DB_URL = "https://script.google.com/macros/s/AKfycbx4YIhH5eYdW1vOfJk-iKEy4JD9VRYVlT5eLUSuzXQiPLhv01D861g5Alt42825mA/exec"; // ← デプロイ後のURLに書き換える
const DB_TOKEN   = "my_wood_decay_token_2026treedoctor"; // ← GASのスクリプトプロパティ TOKEN と一致させる

const IDB_NAME  = "fungi-records-db"; // ブラウザ内DBの名前
const IDB_VER   = 1;                  // スキーマバージョン(変えるとupgradeneededが走る)
const IDB_STORE = "records";          // ストア名(SQLのテーブルに相当)

// ── IndexedDB ユーティリティ ──
// IndexedDBを開く(なければ作る)
function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        // keyPath: "record_id" → record_idを主キーとしてストアを作る
        db.createObjectStore(IDB_STORE, { keyPath: "record_id" });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

// 全レコードを取得
async function idbGetAll() {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(IDB_STORE, "readonly")
                  .objectStore(IDB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

// 1件保存(新規 or 上書き)
async function idbPut(rec) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(rec);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

// 1件削除
async function idbRemove(record_id) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(record_id);
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

// ── GAS DB通信 ──
// Content-Type: text/plain で送る(CORS回避。既存Gemini中継と同じ方式)
async function gasPost(body) {
  const res = await fetch(GAS_DB_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({ token: DB_TOKEN, ...body }),
  });
  return JSON.parse(await res.text());
}

// GETで全件取得（トークンをクエリで送る。GAS側はGETもトークン必須）
async function gasGetAll() {
  const url = GAS_DB_URL + "?token=" + encodeURIComponent(DB_TOKEN);
  const res = await fetch(url);
  return JSON.parse(await res.text());
}

// GASに送るときにオブジェクトフィールドをJSON文字列に変換
function toGasRecord(r) {
  return {
    ...r,
    morphology:    typeof r.morphology    === "object" ? JSON.stringify(r.morphology)    : (r.morphology    || ""),
    kettede:       typeof r.kettede       === "object" ? JSON.stringify(r.kettede)       : (r.kettede       || ""),
    ai_candidates: typeof r.ai_candidates === "object" ? JSON.stringify(r.ai_candidates) : (r.ai_candidates || ""),
  };
}

// GASから受け取ったJSON文字列フィールドをパース
function fromGasRecord(r) {
  try { r.morphology    = JSON.parse(r.morphology);    } catch(e) {}
  try { r.kettede       = JSON.parse(r.kettede);       } catch(e) {}
  try { r.ai_candidates = JSON.parse(r.ai_candidates); } catch(e) {}
  r.synced = true;
  return r;
}

// 記録を新しい順にソート
function sortRecords(arr) {
  return [...arr].sort((a, b) => (b.created_at || "") > (a.created_at || "") ? 1 : -1);
}

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
// ============================================================
const SOURCES = {
  handbook2017: "緑化樹木腐朽病害ハンドブック,ゴルフ緑化促進会(編),日本緑化センター,2017(第3刷),ISBN978-4-931085-41-1",
};

// ============================================================
// speciesMaster:緑化樹木木材腐朽菌リスト(全65種)
//   ・和名/並び順は公式リスト(緑化樹木木材腐朽菌リスト.md)と完全一致
//   ・記載内容はNotebookLM見直し版に全面置換(図鑑2017ベース)
//   ・gakumeiは命名者を除いた省略形
//   ・microは全種false(顕微鏡判定が必要な種は今後の校正で個別指定)
// ============================================================
const speciesMaster = [
  { id: 1, wamei: "オオミコブタケ", gakumei: "Kretzschmaria deusta", kamei: "クロサイワイタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹", part: "根株付近", micro: true,
    lifespan: "一年生", texture: "炭質", underside: "平坦(子のう殻の孔口がある)", tissueColor: "内部は白色〜灰色",
    mieru: ["不定型でかさぶた状(幅1〜5cm、厚さ1〜3mm)", "未熟な子座はパールグレイ(薄い灰色)で柔軟", "成熟すると黒色、炭質でもろく、樹皮から容易に剥がれる"],
    kettede: ["子のう胞子は紡錘形〈30〜40×8〜12μm〉で発芽スリットを有する", "子のうの先端部にアミロイド反応を呈する大型のプラグがある", "子のう殻は大型で直径1mm程度", "材の中に黒い帯線〈境界線〉が形成される", "子座は炭質で脆く、樹皮から剥がれやすい"],
    shutten: [SOURCES.handbook2017] },
  { id: 2, wamei: "アラゲキクラゲ", gakumei: "Auricularia polytricha", kamei: "キクラゲ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹", part: "幹・枝", micro: true,
    lifespan: "一年生", texture: "ゼラチン質(乾くと革質〜軟骨質)", underside: "平坦(平滑)", tissueColor: "黒茶色",
    mieru: ["ロート状〜椀状〜耳状(径2〜6cm、厚さ0.5〜1cm)", "生時はゼラチン質、乾時は革質〜軟骨質", "背面は灰色〜朽葉色で短毛が密生する"],
    kettede: ["担子器は細長い円筒形で、横隔壁により4室に分かれる", "担子胞子は腎臓形〜ソーセージ形〈8〜13×3〜5μm〉", "生時はゼラチン質だが、乾燥すると革質〜軟骨質となる", "背面に短毛が密生する"],
    shutten: [SOURCES.handbook2017] },
  { id: 3, wamei: "ヒラタケ", gakumei: "Pleurotus ostreatus", kamei: "ヒラタケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹、まれに針葉樹", part: "幹・枝", micro: true,
    lifespan: "一年生", texture: "肉質(柔軟)", underside: "ヒダ状", tissueColor: "白色",
    mieru: ["扇形〜半円形(幅5〜15cm)、しばしば数個が重なって形成される", "表面は平滑、はじめ勝色〜黒色、のちに灰白色〜茶鼠色〜枯草色になる", "ヒダは垂生、白色、柔軟"],
    kettede: ["担子胞子は円筒形〜楕円形〈8〜12×3〜4μm〉", "構成菌糸はかすがい連結を有する1菌糸型", "傘の表皮下にゼラチン層を欠く", "近縁のオオヒラタケは柄の基部に黒い分生子束を形成することで区別できる"],
    shutten: [SOURCES.handbook2017] },
  { id: 4, wamei: "スエヒロタケ", gakumei: "Schizophyllum commune", kamei: "スエヒロタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹、時に針葉樹", part: "枝・幹", micro: true,
    lifespan: "一年生", texture: "革質", underside: "ヒダ状", tissueColor: "白色〜灰白色",
    mieru: ["扇形、無柄(幅最大3cm程度)、しばしば多くの傘が重なって形成される", "表面には粗毛が密生し、白色〜灰白色", "子実層托はヒダ状、白〜灰桜色、乾燥するとヒダが縦に2枚に裂ける"],
    kettede: ["1枚のヒダが縦に2枚に裂ける", "担子胞子は円筒形〈4〜6×1.5〜2μm〉", "菌糸型は1菌糸型でかすがい連結を有する", "肉は革質で、傘肉と子実層の組織ははっきりと分かれる"],
    shutten: [SOURCES.handbook2017] },
  { id: 5, wamei: "ナラタケ", gakumei: "Armillaria mellea", kamei: "キシメジ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹、一部の針葉樹(ヒノキ、クロマツ)", part: "根株", micro: true,
    lifespan: "一年生", texture: "肉質(柔軟)", underside: "ヒダ状", tissueColor: "白色〜練色",
    mieru: ["傘は山吹色〜金茶色〜琥珀色、中央部には鱗片、周縁部に条線がある", "ヒダは白色〜練色、直生〜やや垂生", "柄は繊維質、上部に厚い白色〜クリーム色のツバを有する"],
    kettede: ["被害木の樹皮下に白色の菌糸膜を形成する", "土壌中や柄の基部に焦茶〜黒色の根状菌糸束を形成する", "構成菌糸にかすがい連結を欠く", "担子胞子は広楕円形〈7〜8.5×5〜5.5μm〉で発芽孔を欠く", "柄の上部に厚いツバを有する"],
    shutten: [SOURCES.handbook2017] },
  { id: 6, wamei: "ナラタケモドキ", gakumei: "Armillaria tabescens", kamei: "キシメジ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹", part: "根株", micro: true,
    lifespan: "一年生", texture: "肉質(柔軟)", underside: "ヒダ状", tissueColor: "記載なし",
    mieru: ["傘は枯草色〜山吹色〜土色、しばしば多数の子実体が束生する", "ヒダは白色〜杏色、直生〜垂生", "柄は細長く、傘と同色だが下部は色が濃い"],
    kettede: ["柄にツバを欠くことでナラタケと区別される", "ナラタケと異なり土中に根状菌糸束を形成しない", "被害木の樹皮下に白色の菌糸膜を形成し、辺材部を腐朽させる", "担子胞子は広楕円形〈6〜8×5〜6μm〉で、構成菌糸はかすがい連結を欠く"],
    shutten: [SOURCES.handbook2017] },
  { id: 7, wamei: "ヤナギマツタケ", gakumei: "Agrocybe cylindracea", kamei: "オキナタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: true,
    lifespan: "一年生", texture: "肉質(柔軟)", underside: "ヒダ状", tissueColor: "白色",
    mieru: ["傘はじめ丸山形、のち平らに開く(径5〜10cm)", "表面は平滑、狐色〜褐色", "柄の上部に顕著なツバを有する", "ヒダは密で柄に直生、はじめ白色、のちに焦茶色"],
    kettede: ["柄の上部に顕著な大型のツバを有する", "担子胞子は広楕円形で大きく〈8.5〜11×5.5〜7μm〉、はっきりした発芽孔がある", "成熟するとヒダが焦茶色になり、胞子紋も茶色を呈する", "傘の表皮が子実層状の組織からなり、モエギタケ科菌類と区別される"],
    shutten: [SOURCES.handbook2017] },
  { id: 8, wamei: "クリタケ", gakumei: "Hypholoma sublateritium", kamei: "モエギタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹", part: "根株・地際", micro: true,
    lifespan: "一年生", texture: "肉質(柔軟)", underside: "ヒダ状", tissueColor: "記載なし",
    mieru: ["傘はじめ丸山形、後まんじゅう形〜平ら(径3〜8cm)", "表面は平滑、黄茶色〜狐色〜煉瓦色、周辺部は練色", "ヒダは直生〜湾生、はじめ練色、後に焦茶色〜黒茶色"],
    kettede: ["担子胞子は卵形で琥珀色〈5〜7.5×3.5〜4.5μm〉、平滑で厚壁", "構成菌糸にかすがい連結を有する", "近縁のニガクリタケは本種より小型で黄色味が強く、強い苦味があることで区別できる"],
    shutten: [SOURCES.handbook2017] },
  { id: 9, wamei: "ヌメリスギタケモドキ", gakumei: "Pholiota aurivella", kamei: "モエギタケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹", part: "幹", micro: true,
    lifespan: "一年生", texture: "肉質(柔軟・生時粘性)", underside: "ヒダ状", tissueColor: "記載なし",
    mieru: ["傘はじめ丸山形、のちに平ら(黄金色〜狐色)", "表面は生時粘性を帯び、三角形の鱗片が多数存在", "柄は不完全なツバを有し、下部に細かい鱗片があるが後に平滑"],
    kettede: ["傘に三角形の鱗片が多数存在し、生時は著しい粘性を帯びる", "担子胞子は楕円形〈6〜9×4〜5μm〉で、一端に発芽孔がある", "胞子紋は焦茶色を呈する", "ヌメリスギタケ〈胞子 5〜6.5×3〜4μm〉よりも胞子が大型である"],
    shutten: [SOURCES.handbook2017] },
  { id: 10, wamei: "コガネコウヤクタケ", gakumei: "Phlebia chrysocrea", kamei: "コウヤクタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹、ヒノキ", part: "根株", micro: false,
    lifespan: "一年生", texture: "記載なし", underside: "平坦(平滑)", tissueColor: "卵色",
    mieru: ["背着生で不定形に広がり、卵色〜山吹色", "表面平坦で、乾くと亀裂が生じる(厚さ0.2〜0.5mm)", "基質から剥がれにくい"],
    kettede: ["5% KOH溶液を滴下すると、鮮やかな卵色の組織がワインレッド色に変色する", "子実体は背着生で基質から剥がれにくく、乾燥すると亀裂が生じる", "子実層に先端が細く尖ったシスチジアが存在する", "担子胞子は楕円形〜円筒形〈4〜5×2〜2.5μm〉"],
    shutten: [SOURCES.handbook2017] },
  { id: 11, wamei: "チヂレタケ", gakumei: "Plicaturopsis crispa", kamei: "コウヤクタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹(特にサクラ類)", part: "枝・幹", micro: true,
    lifespan: "一年生", texture: "記載なし(肉質)", underside: "ヒダ状", tissueColor: "白色〜灰桜色",
    mieru: ["杓子形〜扇形〜円形(径0.5〜3cm)、しばしば群生", "傘表面に短密毛と不明瞭な環紋、卵色〜狐色", "ヒダは放射状に広がり分岐し、しばしば縮れる"],
    kettede: ["子実層托がヒダ状で、放射状に広がって分岐し、しわ状に縮れる", "担子胞子はソーセージ形〈3〜4×1〜1.5μm〉", "構成菌糸はかすがい連結を有するが、厚壁でも骨格菌糸ではない", "乾燥すると全体が強く縮れる"],
    shutten: [SOURCES.handbook2017] },
  { id: 12, wamei: "サガリハリタケ", gakumei: "Radulodon copelandii", kamei: "コウヤクタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: true,
    lifespan: "一年生", texture: "記載なし", underside: "針状", tissueColor: "白色〜淡黄色〜狐色",
    mieru: ["背着生で不定形に広がり、白色〜淡黄色〜狐色", "子実層托は針状で密生、長さ0.5〜1cm", "基質に固着し剥がれにくい"],
    kettede: ["子実層托が長さ0.5〜1cmに達する長い針状で、密生して垂れ下がる", "担子胞子は類球形〈5.5〜7×5〜6μm〉", "菌糸型は1菌糸型で、かすがい連結を有する", "乾燥すると針状突起が褐色を呈する"],
    shutten: [SOURCES.handbook2017] },
  { id: 13, wamei: "アナタケ", gakumei: "Schizopora flavipora", kamei: "コウヤクタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: true,
    lifespan: "一年生", texture: "記載なし", underside: "管孔状(迷路状)", tissueColor: "白色〜クリーム色〜枯色",
    mieru: ["背着生で不定形に広がり、白色〜クリーム色〜枯色", "厚さは最大で3mm程度", "子実層托は管孔状、孔口は角形〜迷路状(1mm間に3〜5個)"],
    kettede: ["子実層托は管孔状で、孔口は角形〜迷路状〈1mm間に3〜5個〉", "子実層内に先端が球形の形質ある菌糸（頭状菌糸）が存在する", "担子胞子は楕円形〈3.5〜5×2.5〜3.5μm〉", "菌糸型は1〜2菌糸型で、かすがい連結を有する"],
    shutten: [SOURCES.handbook2017] },
  { id: 14, wamei: "ウスバタケ", gakumei: "Irpex lacteus", kamei: "ニクハリタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: true,
    lifespan: "一年生", texture: "記載なし", underside: "歯牙状", tissueColor: "白色",
    mieru: ["不定形に薄く広がり、上縁が反転して狭い傘を形成(半背着生)", "傘表面は白色で短毛と環紋がある", "子実層托は薄く短い歯牙状(長さ1〜2mm)、白色〜クリーム色"],
    kettede: ["子実層托は薄い歯牙状〈長さ1〜2mm〉で、白色〜クリーム色", "子実層に先端に結晶を被る厚壁のシスチジア（ランプシスチジア）が多数存在する", "担子胞子は楕円形〜円筒形〈4〜6×2〜3μm〉", "構成菌糸はかすがい連結を欠く"],
    shutten: [SOURCES.handbook2017] },
  { id: 15, wamei: "カンゾウタケ", gakumei: "Fistulina hepatica", kamei: "カンゾウタケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽・褐色腐朽", host: "シイ、カシ等広葉樹", part: "幹", micro: false,
    lifespan: "一年生", texture: "肉質", underside: "管孔状(独立した管)", tissueColor: "鮮やかな赤色(白色の筋模様)",
    mieru: ["扇形〜へら形(径10〜20cm、厚さ2〜3cm)、緋色〜赤茶色", "肉は柔らかく、赤色の汁を多く含み、緋色と白色の筋模様がある", "子実層托は管孔状(サーモンピンク)、管孔が1本ずつ独立している"],
    kettede: ["肉は鮮やかな赤色で、白色の筋模様（霜降り状）を呈し、多量の赤色の液汁を含む", "子実層托は多数の管が互いに独立したストロー状の集合体である", "担子胞子は卵形〈4〜5×2.5〜3.3μm〉", "シイ、カシ類の幹心材に褐色の腐朽を引き起こす"],
    shutten: [SOURCES.handbook2017] },
  { id: 16, wamei: "マツオウジ", gakumei: "Neolentinus lepideus", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "心材腐朽・褐色腐朽", host: "針葉樹(特にマツ類)", part: "幹(心材)", micro: false,
    lifespan: "一年生", texture: "強靭な肉質", underside: "ヒダ状", tissueColor: "白色〜クリーム色",
    mieru: ["傘は白色〜クリーム色(径5〜20cm)、黄金色〜茶色の鱗片が同心円状に並ぶ", "ヒダは湾生〜垂生、白色", "柄にはささくれた茶色の鱗片があり、ツバはほとんどない"],
    kettede: ["子実体全体から強いヤニ臭（アニス臭）がする", "肉は白く強靭な肉質で、乾燥すると非常に硬くなる", "担子胞子は円筒形で大型〈10〜11×4〜5μm〉", "松の切り株や建築材に発生し、褐色の腐朽を引き起こす"],
    shutten: [SOURCES.handbook2017] },
  { id: 17, wamei: "ヒトクチタケ", gakumei: "Cryptoporus volvatus", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の辺材腐朽・白色腐朽", host: "針葉樹、特にマツ類", part: "幹・枝", micro: false,
    lifespan: "一年生", texture: "記載なし", underside: "管孔状(内部)", tissueColor: "はじめ白色、のちにストロー(麦わら)色",
    mieru: ["ハマグリ形、無柄あるいは短柄(幅1〜4cm、厚さ1〜3cm)", "傘表面は無毛で光沢があり、黄色〜栗色", "裏面は白色〜黄色の薄い膜で覆われ、基部近くに楕円形の穴がある"],
    kettede: ["子実体の裏面が薄膜で覆われ、基部付近に甲虫が脱出した楕円形の穴がある", "胞子は膜に守られた内部の管孔で作られ、穴から出入りする虫によって運ばれる", "担子胞子は楕円形〈10〜13×4〜6μm〉", "菌糸型は3菌糸型で、かすがい連結を有する"],
    shutten: [SOURCES.handbook2017] },
  { id: 18, wamei: "シロアメタケ", gakumei: "Tyromyces fissilis", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹(クリ、リンゴ、ブナ等)", part: "幹", micro: false,
    lifespan: "一年生", texture: "肉質(多湿で柔軟)", underside: "管孔状", tissueColor: "白色(乾燥するとストロー色)",
    mieru: ["半円形〜棚状(幅5〜20cm、厚さは1〜5cm)", "生時は多湿で柔軟、白色だが、乾燥すると狐色〜茶色に変色する", "肉は厚く、乾燥するとストロー(麦わら)色になる"],
    kettede: ["生の子実体を白紙の上に置くと、液汁が出て茶色のしみがつく", "乾燥すると傘の表面は狐色〜茶色、管孔部は茶色〜褐色に著しく変色し、膠質（硬い飴状）になる", "担子胞子は広楕円形〈4〜6×3〜4μm〉", "肉は多湿で柔らかく、1菌糸型でかすがい連結を有する"],
    shutten: [SOURCES.handbook2017] },
  { id: 19, wamei: "ヤニタケ", gakumei: "Ischnoderma resinosum", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "針葉樹、広葉樹", part: "幹", micro: false,
    lifespan: "一年生", texture: "生時肉質、乾くとコルク質", underside: "管孔状", tissueColor: "灰白色〜枯草色〜小麦色",
    mieru: ["半円形〜棚状(幅5〜30cm、厚さ1〜2cm)", "表面は狐色〜茶色、黒茶色の明瞭な環紋と溝がある", "生時は水分を多く含み肉質、乾くとコルク質"],
    kettede: ["生時に強いアニス臭があり、管孔面を傷つけると褐色に変色する", "傘の表面に褐色〜黒色の毛羽立った薄い殻皮があり、明瞭な環紋がある", "担子胞子はソーセージ形〈5〜6×1.5〜2μm〉", "菌糸型は2菌糸型で、かすがい連結を有する"],
    shutten: [SOURCES.handbook2017] },
  { id: 20, wamei: "シハイタケ", gakumei: "Trichaptum abietinum", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "枯死木の幹辺材腐朽・白色孔状腐朽", host: "針葉樹、特にマツ属", part: "枯死木の幹", micro: true,
    lifespan: "一年生", texture: "革質", underside: "管孔状(のちに歯牙状)", tissueColor: "梅鼠色(はじめ薄紫色)",
    mieru: ["半円形で薄く(幅1〜5cm)、多数重なって形成される", "傘表面は白色〜灰白色で短毛があり、不明瞭な環紋がある", "子実層托は管孔状、はじめ薄紫色で後に薄茶色"],
    kettede: ["子実層托は浅い管孔状で、紫色のち褐色を帯びる。孔口は縁部で歯牙状になる", "子実層の先端に結晶を付着したシスチジアが多数存在する", "担子胞子は湾曲した円筒形〜ソーセージ形〈5〜7×2〜3μm〉", "ウスバハイタケは本種に似るが、子実層托が薄歯状で管孔状にならないことで区別できる"],
    shutten: [SOURCES.handbook2017] },
  { id: 21, wamei: "ハカワラタケ", gakumei: "Trichaptum biforme", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: true,
    lifespan: "一年生", texture: "記載なし", underside: "管孔状(のちに歯牙状)", tissueColor: "パステルピンク〜狐色〜茶色",
    mieru: ["扇形〜半円形(幅1〜6cm、厚さ1〜2mm)", "傘表面には白色、灰色、狐色などの明瞭な環紋と短密毛がある", "子実層托ははじめ浅い管孔状、のちに乱れて歯牙状となり、はじめはパステルピンク色"],
    kettede: ["子実層托は薄歯状で、鮮やかな紫色（パステルピンク）を呈する", "子実層の先端に結晶を付着したシスチジアが存在する", "担子胞子は円筒形〈5〜7×2〜2.5μm〉", "広葉樹の枝や幹に発生し、シハイタケ（針葉樹に発生）と寄主で区別できる"],
    shutten: [SOURCES.handbook2017] },
  { id: 22, wamei: "ニクウスバタケ", gakumei: "Cerrena consors", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹、特にナラ類", part: "幹", micro: true,
    lifespan: "一年生", texture: "革質", underside: "薄歯状", tissueColor: "白色〜肌色〜枯草色",
    mieru: ["半円形〜貝殻状(幅1〜3cm)、多数重なって形成される", "表面は橙色〜狐色で無毛", "子実層托は薄歯状(長さ1〜2.5mm)、白色〜肌色〜枯草色"],
    kettede: ["子実層托が薄歯状で、長さ1〜2.5mm、白色〜肌色〜枯草色を呈する", "菌糸型は3菌糸型で、骨格菌糸が発達し、かすがい連結を有する", "担子胞子は楕円形〈4.5〜6×2〜3μm〉", "子実体は半背着生で薄茶色の傘が多数重なって形成される"],
    shutten: [SOURCES.handbook2017] },
  { id: 23, wamei: "ミダレアミタケ", gakumei: "Cerrena unicolor", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹", part: "幹・枝", micro: true,
    lifespan: "一年生", texture: "記載なし", underside: "迷路状(のちに薄歯状)", tissueColor: "白色〜小麦色",
    mieru: ["半円形〜棚状(幅2〜8cm、厚さ1mm以下)", "表面は灰白色〜小麦色、軟毛を有し、環紋と環溝がある", "子実層托ははじめ迷路状、のちに薄歯状、錬色〜焦茶色"],
    kettede: ["傘の肉に褐色の帯線が存在し、肉が上下2層に分かれる", "子実層托ははじめ迷路状で、のちに薄歯状、緑色〜焦茶色となる", "担子胞子は円筒形〜楕円形〈3.5〜5×2.5〜3.5μm〉", "ヒラアシキバチと共生関係にあり、ハチによって樹木に植え付けられる"],
    shutten: [SOURCES.handbook2017] },
  { id: 24, wamei: "カイガラタケ", gakumei: "Lenzites betulina", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: true,
    lifespan: "一年生", texture: "記載なし", underside: "ヒダ状", tissueColor: "灰色〜クリーム色〜狐色〜褐色",
    mieru: ["半円形〜扇形(幅2〜10cm、厚さ0.3〜1cm)", "表面には軟毛が密生し、灰色〜狐色〜褐色の環紋がある", "子実層托はヒダ状で、互いに連絡する"],
    kettede: ["子実層托が比較的硬いヒダ状で、分岐や連絡（脈絡）がある", "子実層に剣状の形をした厚壁の菌糸（剣状菌糸）が多数存在する", "担子胞子は湾曲した円筒形〜ソーセージ形〈5〜6×2〜3μm〉", "菌糸型は3菌糸型で、かすがい連結を有する"],
    shutten: [SOURCES.handbook2017] },
  { id: 25, wamei: "ウサギタケ", gakumei: "Trametes trogii", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹、特にヤナギ科", part: "幹・枝", micro: true,
    lifespan: "一年生", texture: "記載なし", underside: "管孔状(迷路状)", tissueColor: "白色〜クリーム色",
    mieru: ["半円形で厚く(径2〜8cm、厚さ1〜3cm)、しばしば重なって形成される", "表面には粗い毛の束が密生し、クリーム色〜狐色〜褐色", "子実層托は管孔状、孔口は角形〜迷路状"],
    kettede: ["傘の表面に粗い毛の束が密生し、基部が厚く垂れ下がる（垂生）", "子実層托は管孔状で、孔口は大型〈1mm間に2〜3個〉で角形〜迷路状", "担子胞子は大型の円筒形〈8〜12×3.5〜4μm〉", "菌糸型は3菌糸型で、かすがい連結を有する"],
    shutten: [SOURCES.handbook2017] },
  { id: 26, wamei: "オオチリメンタケ", gakumei: "Trametes gibbosa", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹", part: "幹", micro: true,
    lifespan: "一年生", texture: "記載なし", underside: "管孔状(迷路状)", tissueColor: "白色〜クリーム色",
    mieru: ["半円形(幅5〜15cm、厚さ1〜5cm)", "表面は白色〜灰色で環溝があり、藻類の付着により緑色を呈することが多い", "子実層托は管孔状、孔口は円形〜角形〜放射状に長い迷路状"],
    kettede: ["担子胞子は楕円形〈4〜6×2〜3μm〉", "菌糸型は3菌糸型で、原菌糸にかすがい連結を有する", "管孔の孔口が放射状に長くなるのが特徴", "肉は白色〜クリーム色で、1mm間に2〜3個の管孔を有する"],
    shutten: [SOURCES.handbook2017] },
  { id: 27, wamei: "カワラタケ", gakumei: "Trametes versicolor", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹、針葉樹", part: "幹・枝", micro: true,
    lifespan: "一年生", texture: "薄く強靭", underside: "管孔状", tissueColor: "白色",
    mieru: ["半円形(幅2〜7cm、厚さ1〜2mm)、多数の傘が重なる", "灰色、黄茶色、褐色、黒色等の変化に富む環紋", "表面には短毛が密生"],
    kettede: ["担子胞子はやや湾曲した円筒形〈5〜7×1.5〜2.5μm〉", "菌糸型は3菌糸型で、原菌糸にかすがい連結を有する", "白色腐朽力が極めて強く、材を著しく白く軽量化させる", "子実層に異形細胞を欠く"],
    shutten: [SOURCES.handbook2017] },
  { id: 28, wamei: "クジラタケ", gakumei: "Trametes orientalis", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹", part: "幹", micro: true,
    lifespan: "一年生", texture: "肉質(強靭)", underside: "管孔状", tissueColor: "白色〜練色",
    mieru: ["半円形、無柄(幅5〜20cm、厚さ0.5〜1cm)", "傘面は灰色〜茶鼠色、はじめ平坦だが後にしわ状を呈し無環紋", "肉は白色〜練色、強靱で肉厚"],
    kettede: ["担子胞子は円筒形〈5〜7×2〜3μm〉", "菌糸型は3菌糸型で、原菌糸にかすがい連結を有する", "管孔は小さな円形。オオチリメンタケやホウロクタケのように迷路状にはならない", "肉は比較的厚く、灰色味を帯びる"],
    shutten: [SOURCES.handbook2017] },
  { id: 29, wamei: "シロアミタケ", gakumei: "Trametes suaveolens", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹、特にヤナギ属樹木", part: "幹・枝", micro: true,
    lifespan: "一年生〜多年生", texture: "肉厚でやや硬い", underside: "管孔状", tissueColor: "白色〜肌色",
    mieru: ["半円形で丸山形、無柄(幅5〜12cm、厚さ1〜3cm)", "表面は白色〜灰白色〜バフ色、微細な軟毛を被るか無毛、環紋なし", "肉は白色、木質"],
    kettede: ["生時に強いアニス臭（精油の香り）を有する", "担子胞子は円筒形〈8〜10×3〜4.5μm〉", "菌糸型は3菌糸型で、原菌糸にかすがい連結を有する", "ヤナギ属樹木の幹や枝に白色腐朽を引き起こす"],
    shutten: [SOURCES.handbook2017] },
  { id: 30, wamei: "ヒイロタケ", gakumei: "Pycnoporus coccineus", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹、針葉樹", part: "幹・枝", micro: true,
    lifespan: "一年生", texture: "コルク質", underside: "管孔状", tissueColor: "朱色",
    mieru: ["扇形〜半円形(幅3〜10cm、厚さ3〜7mm)", "表面は無毛、平滑で鮮やかな朱色〜緋色、環紋は不明瞭", "縁は薄い"],
    kettede: ["管孔の孔口が非常に細かく〈1mm間に6〜8個〉、肉眼で確認できるシュタケ〈1mm間に2〜3個〉と区別される", "担子胞子は湾曲した円筒形〈4〜5×2〜2.5μm〉", "菌糸型は3菌糸型で、原菌糸にかすがい連結を有する", "肉はコルク質で鮮やかな朱色を呈する"],
    shutten: [SOURCES.handbook2017] },
  { id: 31, wamei: "チャカイガラタケ", gakumei: "Daedaleopsis tricolor", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹、特にサクラ類", part: "幹・枝", micro: true,
    lifespan: "一年生", texture: "コルク質", underside: "ヒダ状", tissueColor: "灰白色〜ストロー(麦わら)色",
    mieru: ["半円形(幅2〜8cm、厚さ0.5〜1cm)、しばしば多数重なる", "表面は無毛、褐色、黒茶色、土色などからなる明瞭な環紋がある", "子実層托はヒダ状、ヒダの幅は2〜6mm"],
    kettede: ["子実層に有棘糸状体が存在する", "担子胞子は円筒形〜ソーセージ形〈7〜9×2〜3μm〉", "菌糸型は3菌糸型で、原菌糸にかすがい連結を有する", "肉はコルク質で、子実層托は硬いヒダ状となる"],
    shutten: [SOURCES.handbook2017] },
  { id: 32, wamei: "ツリガネタケ", gakumei: "Fomes fomentarius", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹", part: "幹", micro: true,
    lifespan: "多年生", texture: "フェルト質", underside: "管孔状", tissueColor: "枯草色",
    mieru: ["蹄形〜釣鐘形(小形は径2〜5cm、厚さ2〜5cm)または丸山形〜扁平な円形(大型は幅最大70cm、厚さは30cmに達する)", "表面は無毛、灰白色、茶鼠色、枯草色、褐色などの環紋と環溝がある", "肉はフェルト質、枯草色"],
    kettede: ["担子胞子は円筒形で大型〈12〜18×4〜5μm〉", "菌糸型は3菌糸型で、原菌糸にかすがい連結を有する", "傘肉はフェルト質で枯草色。チョコレート色を呈するコフキタケと組織の色で区別できる", "傘の表面には褐色の硬い殻皮がある"],
    shutten: [SOURCES.handbook2017] },
  { id: 33, wamei: "ウズラタケ", gakumei: "Perenniporia ochroleuca", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹、特にウメ、サクラ等バラ科", part: "幹・枝", micro: true,
    lifespan: "多年生", texture: "コルク質", underside: "管孔状", tissueColor: "白色〜クリーム色",
    mieru: ["蹄形〜半円形(径1〜4cm、厚さ1〜2cm)", "表面はクリーム色〜枯草色、環紋を有する", "肉はコルク質、白色〜クリーム色"],
    kettede: ["担子胞子は一端が切形の卵形〜楕円形〈12〜15×6〜10μm〉", "菌糸型は3菌糸型で、原菌糸にかすがい連結を有する", "肉はコルク質で、子実体は比較的小型で基質に固着する"],
    shutten: [SOURCES.handbook2017] },
  { id: 34, wamei: "ベッコウタケ", gakumei: "Perenniporia fraxinea", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹、まれに針葉樹", part: "根株", micro: true,
    lifespan: "一年生", texture: "強靭な繊維質", underside: "管孔状", tissueColor: "白茶色",
    mieru: ["半円形(幅5〜20cm、厚さ0.5〜2cm)、しばしば数個が重なる", "はじめ黄色、のちに琥珀色〜褐色〜黒色となり、周縁部は淡色", "不明瞭な環紋と浅い環溝がある"],
    kettede: ["傘肉や腐朽材の中に、類球形〜広楕円形の厚壁胞子が多数形成される", "担子胞子は一端の尖った類球形〈5〜7×4.5〜5.5μm〉", "菌糸型は2菌糸型で、原菌糸にかすがい連結を有する", "病原性が非常に強く、被害木の地際部を腐朽させて急激な倒伏（根返り）を引き起こす"],
    shutten: [SOURCES.handbook2017] },
  { id: 35, wamei: "シイサルノコシカケ", gakumei: "Loweporus tephroporus", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹、特にシイ類", part: "幹・枝", micro: true,
    lifespan: "多年生", texture: "木質(硬い)", underside: "管孔状", tissueColor: "灰色〜焦茶色",
    mieru: ["半背着生で狭い傘を作る。楕円形(長径7〜20cm、厚さ0.5〜3cm)", "表面は粗面、環溝を有し、焦茶色〜黒茶色", "肉は木質で極めて硬く、朽葉色〜焦茶色"],
    kettede: ["担子胞子および骨格菌糸がヨード液で茶色に染まる〈デキストリノイド反応〉", "担子胞子の一端が欠けた広楕円形〈4.5〜6×3.5〜4.5μm〉", "菌糸型は3菌糸型で、原菌糸にかすがい連結を有する", "骨格菌糸が芥子色〜朽葉色を呈することで他の種と区別できる"],
    shutten: [SOURCES.handbook2017] },
  { id: 36, wamei: "ニレサルノコシカケ", gakumei: "Rigidoporus ulmarius", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹(ニレ類)、針葉樹(スギ老木)", part: "根株", micro: true,
    lifespan: "多年生", texture: "生時繊維質、乾くと強靭な革質", underside: "管孔状", tissueColor: "白色〜白茶色〜薄桃色",
    mieru: ["半円形(幅最大30cm、厚さ6cm)", "表面は白色〜クリーム色〜珊瑚色、平滑あるいは小さな突起があり、無環紋", "生時は繊維質だが、乾くと強靱な革質となる"],
    kettede: ["子実層に先端が細く尖ったシスチジアが存在する", "担子胞子は類球形〈径6〜10μm〉", "菌糸型は1〜2菌糸型で、原菌糸はかすがい連結を欠く", "肉は生時繊維質だが、乾燥すると極めて強靭な革質となる"],
    shutten: [SOURCES.handbook2017] },
  { id: 37, wamei: "カイメンタケ", gakumei: "Phaeolus schweinitzii", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "根株心材腐朽・褐色腐朽", host: "針葉樹、特にカラマツ", part: "根株", micro: true,
    lifespan: "一年生", texture: "生時軟らかい、乾くと脆いウレタン状", underside: "管孔状〜やや歯牙状", tissueColor: "褐色",
    mieru: ["半円形〜円形(径5〜30cm、厚さ0.5〜1cm)、多数重なる", "表面は土色〜褐色〜焦茶色、軟毛を密生し、環紋がある", "肉は褐色、生時は軟らかいが乾くと脆いウレタン状"],
    kettede: ["菌糸型は1菌糸型で、原菌糸にかすがい連結を欠く", "担子胞子は広楕円形〈5〜8×3.5〜4.5μm〉", "培養菌糸に厚壁胞子を形成する", "針葉樹の根株に褐色の腐朽を引き起こし、腐朽力が非常に大きい"],
    shutten: [SOURCES.handbook2017] },
  { id: 38, wamei: "アイカワタケ", gakumei: "Laetiporus sulphureus", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹や枝の心材腐朽・褐色腐朽", host: "広葉樹(特にスダジイ、コジイ)", part: "幹・枝", micro: true,
    lifespan: "一年生", texture: "肉質(脆い)", underside: "管孔状", tissueColor: "黄色",
    mieru: ["半円形、無柄(幅10〜30cm、厚さ1〜3cm)", "表面は鮮やかな黄色〜小麦色。肉は水分を多く含み脆い肉質で黄色", "傘が展開せずコブ状になるものはヒラフスベと呼ばれる"],
    kettede: ["菌糸型は2菌糸型で、原菌糸にかすがい連結を欠く", "担子胞子は卵形〜楕円形〈5〜8×4〜5μm〉", "ヒラフスベ型の場合、組織内部に多数の厚壁胞子が形成される", "材の著しい褐色の心材腐朽を引き起こす"],
    shutten: [SOURCES.handbook2017] },
  { id: 39, wamei: "マスタケ", gakumei: "Laetiporus sulphureus var. miniatus", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽・褐色腐朽", host: "広葉樹、針葉樹", part: "幹", micro: true,
    lifespan: "一年生", texture: "肉質(脆い)", underside: "管孔状", tissueColor: "ピンク〜サーモンピンク",
    mieru: ["半円形、無柄(幅10〜30cm、厚さ1〜3cm)", "表面は鮮やかなサーモンピンク〜クロームオレンジ。肉は水分を多く含み脆い肉質でピンク〜サーモンピンク"],
    kettede: ["菌糸型は2菌糸型で、原菌糸にかすがい連結を欠く", "担子胞子は卵形〜楕円形〈5〜8×4〜5μm〉", "材に褐色の心材腐朽を引き起こす", "最近の遺伝子解析により広葉樹発生のものと針葉樹発生のものは別種とされる可能性がある"],
    shutten: [SOURCES.handbook2017] },
  { id: 40, wamei: "アオゾメタケ", gakumei: "Postia caesia", kamei: "ツガサルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "枝や幹の心材腐朽・褐色腐朽", host: "針葉樹、サクラ等の広葉樹", part: "枝・幹", micro: true,
    lifespan: "一年生", texture: "肉質(柔軟)", underside: "管孔状", tissueColor: "青白色",
    mieru: ["半円形、無柄(幅5〜6cm、厚さは最大2cm程度)", "表面は薄藍色〜白色。生時は水分を多く含み柔軟", "肉は青白色"],
    kettede: ["胞子紋が青みを帯びる", "担子胞子はソーセージ形〈5〜7×1.5μm〉", "菌糸型は1菌糸型で、原菌糸にかすがい連結を有する", "子実体は肉質で水分を多く含み、非常に柔らかい"],
    shutten: [SOURCES.handbook2017] },
  { id: 41, wamei: "ホウロクタケ", gakumei: "Daedalea dickinsii", kamei: "ツガサルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽・褐色腐朽", host: "広葉樹", part: "幹", micro: true,
    lifespan: "一年生〜多年生", texture: "コルク質", underside: "管孔状(のちに迷路状)", tissueColor: "ストロー(麦わら)色〜枯草色",
    mieru: ["半円形〜多生(幅5〜20cm、厚さ1〜2.5cm)", "表面は無毛、平滑あるいは小さないぼがあり、ストロー色〜枯草色〜コルク色", "不明瞭な環紋と環溝がある"],
    kettede: ["子実層托は管孔状だが、しばしば形が崩れて迷路状となる", "菌糸型は3菌糸型で、原菌糸にかすがい連結を有する", "肉はストロー色〜枯草色で、コルク質の薄茶色い子実体を形成する", "担子胞子のサイズ：図鑑に記載なし"],
    shutten: [SOURCES.handbook2017] },
  { id: 42, wamei: "ツガサルノコシカケ", gakumei: "Fomitopsis pinicola", kamei: "ツガサルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽・褐色腐朽", host: "針葉樹、一部の広葉樹(サクラ等)", part: "幹", micro: true,
    lifespan: "多年生", texture: "木質", underside: "管孔状", tissueColor: "クリーム色",
    mieru: ["丸山形〜扁平な半円形(幅最大20cm)", "表面は無毛、はじめ練色で、のちに黒色〜焦茶色〜赤錆色の鮮やかな環紋が現れる", "ニスを塗ったような光沢がある"],
    kettede: ["子実層にこん棒状の細長いシスチジアが存在する", "担子胞子は広楕円形〈6〜8×4〜5μm〉", "菌糸型は3菌糸型で、原菌糸にかすがい連結を有する", "肉は木質でクリーム色。傘の表面に鮮やかな赤錆色の環紋が現れる"],
    shutten: [SOURCES.handbook2017] },
  { id: 43, wamei: "バライロサルノコシカケ", gakumei: "Fomitopsis rosea", kamei: "ツガサルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽：褐色腐朽", host: "針葉樹、サクラ類などの広葉樹", part: "幹", micro: true,
    lifespan: "多年生", texture: "木質", underside: "管孔状", tissueColor: "灰桜色",
    mieru: ["蹄形〜丸山形(幅1〜10cm)", "傘の表面には殻皮があり、滅紫色(けしむらさきいろ)〜焦茶色〜黒色、環紋を有する", "子実層托は管孔状、桜色〜灰桜色、孔口は円形〜角形(1mm間に3〜5個)", "傘肉は木質、灰桜色"],
    kettede: ["子実層托〈管孔面〉がピンク色（桜色〜灰桜色）を帯びる", "担子胞子は円筒形〈6〜9×2〜3μm〉", "菌糸型は2菌糸型で、原菌糸にかすがい連結を有する", "傘の表面に硬い殻皮を有する"],
    shutten: [SOURCES.handbook2017] },
  { id: 44, wamei: "カタオシロイタケ", gakumei: "Fomitopsis spraguei", kamei: "ツガサルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹や枝の心材腐朽：褐色腐朽", host: "広葉樹", part: "幹や枝", micro: true,
    lifespan: "一年生", texture: "生時硬い肉質、乾時木質", underside: "管孔状", tissueColor: "白色",
    mieru: ["半円形〜扇形(幅4〜12cm、厚さ0.5〜2cm)", "表面は白色〜クリーム色〜部分的に褐色、無毛、多くは無環紋", "傘肉は生時硬い肉質、乾時木質、白色", "子実層托は管孔状、白色〜淡黄色、孔口は円形〜角形(1mm間に3〜5個)"],
    kettede: ["担子胞子は卵形〜広楕円形〈5〜7×4〜5μm〉", "菌糸型は3菌糸型で、原菌糸にかすがい連結を有する", "肉は生時硬い肉質だが、乾燥すると木質となる", "材に著しい褐色腐朽を引き起こす"],
    shutten: [SOURCES.handbook2017] },
  { id: 45, wamei: "クロサルノコシカケ", gakumei: "Melanoporia castanea", kamei: "ツガサルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽：褐色腐朽", host: "広葉樹、特にナラ類やクリ", part: "幹", micro: true,
    lifespan: "多年生", texture: "コルク質(硬い)", underside: "管孔状", tissueColor: "焦茶色",
    mieru: ["蹄形〜丸山形、時に背着生(幅最大30cm、厚さ最大15cm)", "表面ははじめ焦茶色で微細毛を有し、後に黒茶色で殻皮を形成、畝状の隆起帯と環溝を有する", "傘肉は焦茶色、コルク質", "子実層托は管孔状、多層、各管孔は長さ0.3〜1cm、焦茶色、円形(1mm間に5〜6個)"],
    kettede: ["管孔は多層で、各層は長さ0.3〜1cmに達する", "担子胞子は円筒形〈4〜5×2〜2.5μm〉", "菌糸型は2菌糸型である", "肉は焦茶色でコルク質。材に著しい褐色腐朽を引き起こす"],
    shutten: [SOURCES.handbook2017] },
  { id: 46, wamei: "カンバタケ", gakumei: "Piptoporus betulinus", kamei: "ツガサルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹や枝の心材腐朽：褐色腐朽", host: "カンバ類樹木", part: "幹や枝", micro: true,
    lifespan: "一年生", texture: "肉質、乾くと軽いコルク質", underside: "管孔状", tissueColor: "白色",
    mieru: ["半円形〜腎臓形、やや扁平な饅頭形(幅6〜25cm、厚さ2〜7cm)", "表面は狐色〜茶色、無毛、無環紋", "肉は白色、コルク質", "子実層托は管孔状、白色、円形(1mm間に3〜5個)"],
    kettede: ["寄主がカンバ類樹木に特異的である", "担子胞子はソーセージ形〈4〜5×1.5〜2μm〉", "菌糸型は2(3)菌糸型で、原菌糸にかすがい連結を有する", "生時は水分を多く含み肉質だが、乾くと非常に軽いコルク質になる"],
    shutten: [SOURCES.handbook2017] },
  { id: 47, wamei: "シロカイメンタケ", gakumei: "Piptoporus soloniensis", kamei: "ツガサルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽：褐色腐朽", host: "広葉樹", part: "幹", micro: true,
    lifespan: "一年生", texture: "肉質、乾くと軽いコルク質", underside: "管孔状", tissueColor: "はじめサーモンピンク、のちに白色",
    mieru: ["半円形(幅10〜30cm、厚さ1〜3cm)", "表面ははじめクリームイエローだが、次第に褪せてストロー色〜白色、無環紋、放射状にしわができる", "傘肉ははじめサーモンピンク、次第に褪せて白色、生時は水分を多く含み肉質、乾くと軽いコルク質"],
    kettede: ["近縁のアイカワタケとは、原菌糸にかすがい連結を有することで区別される", "担子胞子は楕円形〈4〜5×2〜2.5μm〉", "菌糸型は2菌糸型である", "生時は柔軟な肉質だが、乾燥すると極めて軽くなる"],
    shutten: [SOURCES.handbook2017] },
  { id: 48, wamei: "コフキタケ（コフキサルノコシカケ）", gakumei: "Ganoderma applanatum", kamei: "マンネンタケ科", kenshou: "済",
    rotType: "白色", rot: "白色腐朽", host: "広葉樹", part: "幹や枝の心材腐朽、地際部にも発生", micro: true,
    lifespan: "多年生", texture: "繊維質(表面直下は硬い組織)", underside: "管孔状", tissueColor: "チョコレート色",
    mieru: ["多年生、扁平な半円形〜やや丸山形(当年生は幅10〜20cm、厚さ2〜4cm程度。年数を経たものは幅50cm以上、厚さ40cmに達する)", "表面は無毛、環溝を有し、灰白色〜黄土色〜茶色", "大量の胞子が傘の上に積もりココアの粉をまぶしたようになる"],
    kettede: ["担子胞子は二重壁を有し、琥珀色で一端が欠けた卵形〈8〜10×5〜7.5μm〉", "傘肉（組織）はチョコレート色。枯草色のツリガネタケと肉の色で明確に区別できる", "菌糸型は3菌糸型で、原菌糸にかすがい連結を有する", "多肉で硬い黒茶色の組織が表面直下に存在する"],
    shutten: [SOURCES.handbook2017] },
  { id: 49, wamei: "マンネンタケ", gakumei: "Ganoderma lucidum", kamei: "マンネンタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹", part: "根株", micro: true,
    lifespan: "一年生", texture: "コルク質", underside: "管孔状", tissueColor: "クリーム色〜白茶色、のちに焦茶色",
    mieru: ["一年生、傘と柄を有し、柄は偏心生〜中心生(傘径5〜15cm、厚さ1〜2cm)", "表面は光沢があり、はじめ黄色、のちに代赭色〜弁柄色〜焦茶色", "環溝を有する。柄は傘と同色〜黒色で光沢がある"],
    kettede: ["担子胞子は二重壁を有し、一端が欠けた卵形〈9〜11×5〜7μm〉", "傘肉はコルク質で、組織が上下2層に分かれる", "菌糸型は3菌糸型で、琥珀色の顕著な結合菌糸が存在する", "針葉樹に発生するマゴジャクシとは形態的な区別が困難である"],
    shutten: [SOURCES.handbook2017] },
  { id: 50, wamei: "アズマタケ", gakumei: "Inonotus vallatus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "マツ類", part: "根株", micro: true,
    lifespan: "一年生", texture: "記載なし(やや硬い)", underside: "管孔状", tissueColor: "狐色",
    mieru: ["一年生、傘と柄を有する(傘径3〜13cm、厚さ最大1cm程度)", "表面は狐色〜土色、短密毛を有し、環紋がある", "肉は狐色、やや硬く、傘表面から少し下に暗褐色の下殻が形成される"],
    kettede: ["主にアカマツなどマツ類の根から発生し、寄主を枯死させることがある", "構成菌糸（1菌糸型）にかすがい連結を欠く", "傘の肉の少し下に暗褐色の下殻が形成される", "担子胞子は類球形〜広楕円形〈3〜5×2.5〜4μm〉"],
    shutten: [SOURCES.handbook2017] },
  { id: 51, wamei: "オニカワウソタケ", gakumei: "Inonotus ludovicianus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・孔状白色腐朽", host: "広葉樹、特にカシ類に多い", part: "根株", micro: true,
    lifespan: "一年生", texture: "記載なし", underside: "管孔状", tissueColor: "褐色",
    mieru: ["一年生、坐生、無柄、傘は半円形(横幅10〜20cm、厚さ2〜3cm)", "表面は液状に隆起し、褐色〜赤褐色、不明瞭な環紋を有する", "肉は褐色"],
    kettede: ["材に孔状白色腐朽を引き起こし、辺材部まで侵すことがある", "担子胞子は琥珀色の楕円形〈5〜6.5×3.5〜5μm〉", "構成菌糸はかすがい連結を欠く1菌糸型", "子実層に剛毛体〈setae〉はないか、まれに存在する"],
    shutten: [SOURCES.handbook2017] },
  { id: 52, wamei: "カワウソタケ", gakumei: "Inonotus mikadoi", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・孔状白色腐朽", host: "広葉樹、特にサクラ類、ウメ等バラ科樹木", part: "幹や枝", micro: true,
    lifespan: "一年生", texture: "肉厚(生時柔らかい)", underside: "管孔状", tissueColor: "狐色〜橙黄色",
    mieru: ["一年生、半円形〜扇形(幅1〜6cm、厚さ1〜2.5cm)、しばしば多数重なって発生する", "表面は新鮮な時、狐色で密毛があるが、古くなると茶色〜黒茶色で無毛となる", "子実層托は管孔状、はじめ亜麻色、のちに褐色〜焦茶色"],
    kettede: ["材に孔状白色腐朽を引き起こし、大量の胞子放出により寄主表面を茶色く染める", "担子胞子は琥珀色の広楕円形、厚壁〈4〜6×3〜4μm〉", "子実体組織は1菌糸型で、原菌糸にかすがい連結を欠く", "子実層に剛毛体〈setae〉は通常存在しない"],
    shutten: [SOURCES.handbook2017] },
  { id: 53, wamei: "ヤケコゲタケ", gakumei: "Inonotus hispidus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹、特にミズナラに多い", part: "幹", micro: true,
    lifespan: "一年生", texture: "肉厚(多湿)", underside: "管孔状", tissueColor: "土色〜褐色",
    mieru: ["一年生、無柄、半円形(幅10〜30cm、厚さ3〜7cm)、時に数個が重なる", "表面には粗毛が密生し、土色〜褐色、のちに焼け焦げたように黒色になる", "肉は生時大量の水を含み、土色〜褐色で厚い毛被を持つ"],
    kettede: ["担子胞子は茶色の類球形〜広楕円形で大型〈9〜11×7.5〜9μm〉", "子実体組織は2菌糸型で、原菌糸にかすがい連結を欠く", "子実層に剛毛体〈setae〉を有しない", "生時は大量の水分を含み、老熟すると焼け焦げたように黒くなる"],
    shutten: [SOURCES.handbook2017] },
  { id: 54, wamei: "カシサルノコシカケ（コブサルノコシカケ）", gakumei: "Phellinus robustus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹", part: "幹", micro: true,
    lifespan: "多年生", texture: "記載なし", underside: "管孔状", tissueColor: "橙黄色",
    mieru: ["多年生、蹄形〜扁平〜半背着生(幅5〜30cm、厚さ3〜15cm)", "表面には凹凸がある環紋があり、縁は鈍縁で橙黄色、内側は焦茶色〜黒色", "肉は橙黄色"],
    kettede: ["担子胞子は類球形〈6〜9×5.5〜8.5μm〉で、デキストリノイド反応〈メルツァー試薬で褐色に変色〉を呈する", "子実層に剛毛体〈setae〉が少なく、まれに存在する程度である", "子実体組織は2菌糸型で、原菌糸にかすがい連結を欠く", "肉は木質で橙黄色、孔口は非常に細かく1mm間に4〜6個"],
    shutten: [SOURCES.handbook2017] },
  { id: 55, wamei: "キコブタケ", gakumei: "Phellinus igniarius", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹", part: "幹", micro: true,
    lifespan: "多年生", texture: "木質", underside: "管孔状", tissueColor: "焦茶色",
    mieru: ["多年生、蹄形〜半背着生(幅最大20cm、厚さは15cmに達する)", "表面ははじめ灰白色で平滑、のちに灰色〜黒茶色となり多数の環溝と亀裂を生じる", "縁部は山吹色。肉は焦茶色で木質"],
    kettede: ["子実層に赤茶色の剛毛体〈setae〉が多数存在する", "担子胞子は類球形で無色、厚壁〈5〜6×4〜5μm〉", "子実体組織は2菌糸型で、原菌糸にかすがい連結を欠く", "肉は褐色の木質で、材に白色腐朽を引き起こす"],
    shutten: [SOURCES.handbook2017] },
  { id: 56, wamei: "コブサルノコシカケモドキ", gakumei: "Phellinus setulosus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "カシ類、イスノキ等の広葉樹", part: "幹", micro: true,
    lifespan: "多年生", texture: "記載なし", underside: "管孔状", tissueColor: "土色",
    mieru: ["多年生、蹄形〜基部の厚い半円形〜背着生(幅5〜30cm、厚さ3〜15cm)", "傘の表面は平坦あるいは小さなこぶがあり、環溝を有し、縁は鈍縁で橙黄色、内側は焦茶色〜黒色", "傘肉は土色、子実層托は管孔状(1mm間に4〜6個)"],
    kettede: ["子実層に長さ20〜40μmの剛毛体〈setae〉が多数存在する", "担子胞子は無色の類球形〜広楕円形〈4.5〜6×4〜5μm〉", "カシサルノコシカケとは、傘肉の色がより濃いこと、剛毛体が多数あること、胞子が小さいことで区別される", "構成菌糸は2菌糸型で、原菌糸にかすがい連結を欠く"],
    shutten: [SOURCES.handbook2017] },
  { id: 57, wamei: "コルクタケ", gakumei: "Phellinus torulosus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "サクラ類、カシ類等の広葉樹、マツ類", part: "幹", micro: true,
    lifespan: "多年生", texture: "木質", underside: "管孔状", tissueColor: "橙黄色",
    mieru: ["多年生、坐生〜半背着生、無柄、半円形で縁は薄く、横断面は三角形(幅2〜10cm、厚さ1〜7cm)", "表面は微細毛を有するか無毛、環溝があり、粗面、枯色〜黄土色", "傘肉は橙黄色、木質"],
    kettede: ["子実層に多数の剛毛体〈setae〉を有する", "担子胞子は無色の広楕円形〈4〜6×3〜4μm〉", "子実体の横断面は三角形を呈する", "構成菌糸は2菌糸型で、原菌糸にかすがい連結を欠く", "肉は橙黄色で木質、傘の表面には微細な毛または環溝がある"],
    shutten: [SOURCES.handbook2017] },
  { id: 58, wamei: "サビアナタケ", gakumei: "Phellinus ferruginosus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹", part: "幹・枝", micro: true,
    lifespan: "一年生", texture: "硬い(背着生)", underside: "管孔状", tissueColor: "記載なし(表面は檜皮色〜錆色)",
    mieru: ["一年生、背着生で不定形に広がり基質に固着、檜皮色〜錆色", "厚さ1〜10mm程度、子実層托は管孔状、孔口は円形(1mm間に4〜6個)"],
    kettede: ["子実層に長さ25〜60μmの細長い剛毛体〈setae〉が多数存在する", "菌糸組織（subiculum）内に先端の尖った剛毛状菌糸が存在する", "担子胞子は広楕円形〈4〜6×2.5〜4μm〉", "子実体は背着生で、基質に固着し剥がれにくい"],
    shutten: [SOURCES.handbook2017] },
  { id: 59, wamei: "シマサルノコシカケ", gakumei: "Phellinus noxius", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹、イヌマキなど一部の針葉樹", part: "根株", micro: true,
    lifespan: "多年生", texture: "木質", underside: "管孔状", tissueColor: "土色〜琥珀色",
    mieru: ["多年生、坐生〜半背着生(幅5〜25cm、厚さ1〜5cm)", "表面ははじめ微細毛を被り紺子色〜琥珀色、のちに殻皮に覆われ焦茶色〜黒色", "肉は土色〜琥珀色。子実層托は管孔状で生時黒色、乾くと褐色〜焦茶色"],
    kettede: ["被害木の根の表面に、土砂を噛み込んだ厚い茶色〜黒色の菌糸膜を形成する", "腐朽材の内部に褐色の網目状帯線が形成される", "子実層に剛毛体はないが、先端が丸い太い剛毛状菌糸〈幅7〜12μm〉が突出する", "担子胞子は広楕円形〈3.5〜4.5×3〜3.5μm〉", "熱帯〜亜熱帯地域で最も警戒すべき根株腐朽菌（南根腐病菌）である"],
    shutten: [SOURCES.handbook2017] },
  { id: 60, wamei: "チャアナタケ", gakumei: "Phellinus umbrinellus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹", part: "幹・枝", micro: true,
    lifespan: "多年生", texture: "木質", underside: "管孔状", tissueColor: "記載なし",
    mieru: ["多年生、背着生で樹皮上に不定形に広がる。厚さ5mm程度", "子実層托は管孔状、アンバー〜茶色〜焦茶色、孔口は円形(1mm間に5〜7個)", "肉は木質"],
    kettede: ["担子胞子は茶色の広楕円形〈4〜5×3.5〜4μm〉", "子実層に剛毛体〈setae〉を欠く", "外部形態の特徴だけで同定することは困難で、顕微鏡観察が不可欠とされる", "孔口は円形で非常に細かく、1mm間に5〜7個", "構成菌糸は2菌糸型で、原菌糸にかすがい連結を欠く"],
    shutten: [SOURCES.handbook2017] },
  { id: 61, wamei: "チャアナタケモドキ", gakumei: "Phellinus punctatus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹、針葉樹", part: "幹・枝", micro: true,
    lifespan: "多年生", texture: "木質", underside: "管孔状", tissueColor: "記載なし",
    mieru: ["多年生、背着生で樹皮上に不定形に広がる。厚さ1〜10mm", "子実層托は管孔状、小麦色〜土色、孔口は円形(1mm間に6〜8個)", "肉は木質"],
    kettede: ["担子胞子は無色の類球形〜球形〈6〜7×5〜6μm〉で、デキストリノイド反応を呈する", "外見が酷似するチャアナタケとは、大型で無色の担子胞子を持つことで区別できる", "子実層に剛毛体はないが、まれに存在する", "構成菌糸は2菌糸型で、原菌糸にかすがい連結を欠く"],
    shutten: [SOURCES.handbook2017] },
  { id: 62, wamei: "ツリバリサルノコシカケ", gakumei: "Phellinus wahlbergii", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹", part: "根株", micro: true,
    lifespan: "多年生", texture: "木質", underside: "管孔状", tissueColor: "茶色",
    mieru: ["多年生、坐生〜半背着生、蹄形〜扁平な半円形(幅5〜15cm、高さ2〜10cm)", "表面は皮質で粗く茶色〜黒茶色、縁は土色", "肉は茶色、木質。子実層托は管孔状、土色〜錆色"],
    kettede: ["子実層に、先端が曲がった鈎状の剛毛体〈setae〉が多数存在する", "担子胞子は類球形〈4〜5.5×3〜4μm〉で、無色〜薄い黄色を呈する", "骨格菌糸が茶色〜褐色で、原菌糸にかすがい連結を欠く2菌糸型である", "管孔の孔口は非常に細かく、1mm間に7〜8個"],
    shutten: [SOURCES.handbook2017] },
  { id: 63, wamei: "ネンドタケ", gakumei: "Phellinus gilvus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: true,
    lifespan: "一年生", texture: "コルク質", underside: "管孔状", tissueColor: "狐色〜茶色",
    mieru: ["一年生、坐生〜半背着生、半円形〜貝殻状(幅3〜10cm、厚さ0.5〜1.5cm)", "表面には細突起と粗毛があり無環紋、狐色〜茶色〜錆色", "傘肉は狐色〜茶色、コルク質。子実層托は管孔状で茶色〜錆色"],
    kettede: ["子実層に赤茶色で厚壁、先端が鋭く尖った剛毛体が多数存在する", "管孔面が、見る角度によって淡色から濃色に色を変える特徴がある", "担子胞子は無色の広楕円形〈4〜5×3〜4μm〉", "構成菌糸は2菌糸型で、原菌糸にかすがい連結を欠く"],
    shutten: [SOURCES.handbook2017] },
  { id: 64, wamei: "モミサルノコシカケ", gakumei: "Phellinus hartigii", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹辺材腐朽・白色腐朽", host: "針葉樹、特にモミ類", part: "幹辺", micro: true,
    lifespan: "多年生", texture: "木質", underside: "管孔状", tissueColor: "橙黄色〜狐色",
    mieru: ["多年生、坐生、蹄形〜丸山形〜半背着生(幅5〜15cm、厚さ3〜15cm)", "表面は橙黄色〜焦茶色〜黒色、環溝がある。縁は色が薄く、基部は濃い", "肉は橙黄色〜狐色、木質。子実層托は管孔状でクリーム色〜橙黄色"],
    kettede: ["子実層に剛毛体〈setae〉を欠く", "担子胞子は無色・類球形で厚壁〈6〜7.5×5〜6.5μm。図鑑本文の径6〜8mmは単位の誤植と判断し学術記載値を採用〉", "構成菌糸は2菌糸型で、原菌糸にかすがい連結を欠く", "針葉樹、特にモミ属樹木の溝腐病菌として知られ、材に白色腐朽を引き起こす"],
    shutten: [SOURCES.handbook2017] },
  { id: 65, wamei: "ムサシタケ", gakumei: "Pyrrhoderma adamantinum", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹", part: "根株", micro: true,
    lifespan: "多年生", texture: "コルク質", underside: "管孔状", tissueColor: "クリーム色〜飴色〜橙色",
    mieru: ["多年生、無柄〜有柄、半円形〜扇形(幅5〜13cm、厚さ1〜2cm)", "表面は黒茶色〜黒色、無毛で不明瞭な環溝・環紋がある。厚さ1mmの硬い殻皮を持つ", "内部(肉)はクリーム色〜飴色〜橙色、コルク質"],
    kettede: ["子実体を切断すると、傘表面に黒色の厚い殻皮があり、傘肉はクリーム色〜橙色を呈する", "担子胞子は無色、類球形〈5〜7.5×6.5〜7.5μm〉", "管孔の孔口は非常に細かく、1mm間に6〜8個", "構成菌糸は2菌糸型で、原菌糸にかすがい連結を欠く"],
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
  const [rotFilter, setRotFilter] = useState("不明");
  const [hasStem, setHasStem] = useState("不明");
  const [shape, setShape] = useState("不明");
  const [capColor, setCapColor] = useState("");
  const [underside, setUnderside] = useState("不明");
  const [texture, setTexture] = useState("不明");
  const [lifespan, setLifespan] = useState("不明");
  const [bruising, setBruising] = useState("");
  const [showMorph, setShowMorph] = useState(false);
  const [answers, setAnswers] = useState({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [records, setRecords] = useState([]);
  const [activeTab, setActiveTab] = useState("identify"); // "identify" / "species" / "records"

  // v0.8追加: 手動登録
  const [showManual, setShowManual] = useState(false);
  const [manualMode, setManualMode] = useState("master");
  const [manualMaster, setManualMaster] = useState("");
  const [manualWamei, setManualWamei] = useState("");
  const [manualGakumei, setManualGakumei] = useState("");
  const [manualReason, setManualReason] = useState("");

  // v0.8追加: 同期・登録者
  const [syncStatus, setSyncStatus] = useState("idle"); // "idle"/"syncing"/"ok"/"error"
  const [myContributor, setMyContributor] = useState(""); // 自分の登録者名
  const [savedCandIdx, setSavedCandIdx] = useState(new Set()); // 確定済み候補のindex(2重押し防止)

  // ── 同期処理 ──
  async function doSync() {
    if (!navigator.onLine || GAS_DB_URL === "***") return;
    try {
      setSyncStatus("syncing");
      const all = await idbGetAll();

      // 1. 未同期レコードをアップ
      const unsynced = all.filter(r => !r.synced && !r.deleted);
      if (unsynced.length > 0) {
        await gasPost({ action: "save", records: unsynced.map(toGasRecord) });
        for (const r of unsynced) await idbPut({ ...r, synced: true });
      }

      // 2. 削除待ち(tombstone=削除印)をGASに送って端末からも消す
      const toDelete = all.filter(r => r.deleted);
      if (toDelete.length > 0) {
        await gasPost({ action: "delete", ids: toDelete.map(r => r.record_id) });
        for (const r of toDelete) await idbRemove(r.record_id);
      }

      // 3. GAS全件をダウンして端末に取り込む(他の樹木医の記録を受け取る)
      const gasRes = await gasGetAll();
      if (gasRes.ok && gasRes.records) {
        const localMap = {};
        all.forEach(r => { localMap[r.record_id] = r; });
        for (const gr of gasRes.records) {
          const local = localMap[gr.record_id];
          // ローカルにないか、GASの方が新しければ取り込む
          if (!local || (gr.updated_at || "") > (local.updated_at || "")) {
            await idbPut(fromGasRecord(gr));
          }
        }
      }

      // 4. IndexedDBを再読み込みしてstateを更新
      const fresh = await idbGetAll();
      setRecords(sortRecords(fresh.filter(r => !r.deleted)));
      setSyncStatus("ok");
    } catch (err) {
      console.error("同期エラー:", err);
      setSyncStatus("error");
    }
  }

  // 起動時とオンライン復帰時に自動同期
  useEffect(() => {
    // 登録者名をlocalStorageから復元
    const saved = localStorage.getItem("fungi_contributor") || "";
    setMyContributor(saved);

    // IndexedDBから即時読み込み(オフラインでも見られる)
    idbGetAll().then(all => {
      setRecords(sortRecords(all.filter(r => !r.deleted)));
    });

    // オンラインなら即同期
    doSync();

    // オンライン復帰時にも自動同期
    window.addEventListener("online", doSync);
    return () => window.removeEventListener("online", doSync);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 写真読み込み・圧縮
  function handlePhotos(e) {
    const files = Array.from(e.target.files || []);
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => {
          const maxSide = 1280;
          let { width, height } = img;
          if (width > maxSide || height > maxSide) {
            if (width >= height) { height = Math.round((height * maxSide) / width); width = maxSide; }
            else { width = Math.round((width * maxSide) / height); height = maxSide; }
          }
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = height;
          canvas.getContext("2d").drawImage(img, 0, 0, width, height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
          const base64 = dataUrl.split(",")[1];
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
      const target = prev[i];
      if (target && target.url) URL.revokeObjectURL(target.url);
      return prev.filter((_, idx) => idx !== i);
    });
  }

  // 腐朽型フィルタ
  function filterByRot(list) {
    if (rotFilter === "不明") return list;
    return list.filter((s) => s.rotType === rotFilter || s.rotType === "両方" || s.rotType === "変色");
  }

  // Gemini呼び出し
  async function runNarrowing(currentAnswers) {
    setError("");
    if (photos.length === 0) { setError("写真を1枚以上アップロードしてください。"); return; }
    setLoading(true);

    const candidateList = filterByRot(speciesMaster).map((s) => ({
      wamei: s.wamei, gakumei: s.gakumei, rotType: s.rotType,
      host: s.host, part: s.part, micro: s.micro,
      lifespan: s.lifespan, texture: s.texture, underside: s.underside, tissueColor: s.tissueColor,
      mieru: s.mieru, kettede: s.kettede,
    }));

    const answeredText = Object.keys(currentAnswers).length > 0
      ? Object.entries(currentAnswers).map(([k, v]) => `・${k}:${v}`).join("\n")
      : "(まだ確認済みの決め手はありません)";

    const rotText = rotFilter === "不明" ? "未確認(腐朽型での絞り込みなし)" : `${rotFilter}腐朽(材がその色)`;

    // 図鑑の簡易検索表のうち、観察状況(宿主・部位)に該当する群を注入する
    const searchKeyBlock = keyPromptBlock({ host, part });

    const morphPairs = [
      ["子実体の型", shape], ["柄の有無", hasStem], ["裏面(胞子を作る面)", underside],
      ["傘表面の色", capColor], ["質感", texture], ["寿命", lifespan], ["傷つけたときの変色・特記", bruising],
    ].filter(([, v]) => v && v !== "不明");
    const morphText = morphPairs.length > 0
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

${searchKeyBlock}

# 候補リスト(腐朽型フィルタ適用済み・全${candidateList.length}種)
各種のフィールド: rotType=腐朽型 / micro=true は顕微鏡確認が必須 / lifespan=寿命(一年生/多年生) / texture=質感 / underside=裏面形態 / tissueColor=組織(断面)の色
${JSON.stringify(candidateList)}

# あなたの仕事
1. 写真と観察情報から、候補を最大4つ、確信度(0〜1)付きで順位付けする。
2. 各種の mieru(肉眼で見える特徴)/ kettede(決め手)に照らして判断する。
3. 各候補で「写真から見えた特徴(mieru)」と「未確認の決め手(miketsu)」を分ける。
4. micro が true の種、または kettede に「顕微鏡」「メルツァー」「KOH」「担子胞子」など
   現地で見えない確認項目が含まれる種を候補に挙げる場合は、
   riyu に「※現地観察のみでは困難・採取して顕微鏡(または試薬)確認を推奨」と明記する。
5. 【判定ロジックの優先順位】上に提示した「図鑑の簡易検索表(該当群)」の分岐を最優先の骨組みとし、次の順で上位から絞り込む。
   上位の条件が矛盾する種は、下位(色・形・サイズ)が似ていても候補から外す(または確信度を極小化する)。
   ただし各項目が「不明・入力なし」のときは、その段は判断に使わない(減点しない)。
   (1) 寄主樹種(host):針葉樹/広葉樹。宿主と矛盾する種を外す。
   (2) 発生部位(part):根株/幹・枝。部位と矛盾する種を外す。
   (3) 寿命・質感(lifespan/texture):一年生・軟質(肉質・革質)/多年生・硬質(木質・コルク質)。
       質感が「肉質(柔らかい)」なら多年生の木質菌を外す。「木質(硬い)」なら一年生の軟質菌を外す。
   (4) 裏面の形態(underside):ヒダ状/管孔状/針・歯牙状/平滑。
       裏面形態の矛盾は、色やサイズの類似より優先して除外材料とする。
       例:裏面が「ヒダ」なら管孔をもつサルノコシカケ型の多孔菌を外す。
   (5) 組織色・腐朽型(tissueColor/rotType):
       組織が黄色〜狐色〜茶色系ならタバコウロコタケ科(D1)を優先。
       組織が淡色〜チョコレート色系は、白色腐朽ならサルノコシカケ科(D2)、褐色腐朽ならツガサルノコシカケ科(D3)を優先。
       腐朽型が確認済みなら、それと矛盾する種は外す(rotTypeが「両方」「変色」の種は除外しない)。
6. 上記の優先順位を、写真の見た目の印象より優先する。
   上位階層(寄主・部位・質感)で矛盾がある種は、写真がどれほど似ていても候補に挙げない。
   例:柄が「有柄」なら無柄の種は下げる。例:傷で「チョコレート色に変色」はコフキタケを支持。
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

    const parts = [
      ...photos.map((p) => ({ inline_data: { mime_type: p.mime || "image/jpeg", data: p.base64 } })),
      { text: instruction },
    ];
    const geminiBody = {
      contents: [{ parts }],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    try {
      const relayUrl = RELAY_TOKEN
        ? GAS_URL + "?token=" + encodeURIComponent(RELAY_TOKEN)
        : GAS_URL;
      const res = await fetch(relayUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(geminiBody),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        setError(`中継サーバー(GAS)からHTTP ${res.status} が返りました。${t.slice(0, 200)}`);
        return;
      }
      const raw = await res.json();
      if (raw && raw.error) {
        setError("Gemini中継エラー:" + (raw.detail ? String(raw.detail).slice(0, 200) : raw.error));
        return;
      }
      const text = raw?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text || !text.trim()) {
        const reason = raw?.candidates?.[0]?.finishReason || raw?.promptFeedback?.blockReason || "";
        setError("AIから空の応答が返りました。" + (reason ? `理由:${reason}。` : "") + "写真の枚数を減らすか、別の写真でお試しください。");
        return;
      }
      const clean = text.replace(/```json|```/g, "").trim();
      try {
        setResult(JSON.parse(clean));
        setSavedCandIdx(new Set()); // 候補が更新されたら「記録済み」状態をリセット
      } catch {
        const fr = raw?.candidates?.[0]?.finishReason || "";
        if (fr === "MAX_TOKENS") {
          setError("AIの応答が長すぎて途中で切れました(MAX_TOKENS)。写真の枚数を減らすか、開発者に出力上限の調整を相談してください。");
        } else {
          setError("AIの応答をJSONとして解釈できませんでした。" + (fr ? `(終了理由:${fr})` : "") + "応答冒頭:" + clean.slice(0, 120));
        }
      }
    } catch (err) {
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

  // AIの候補カードから確定したときの記録
  function saveRecord(cand) {
    const rec = makeRecord({
      wamei: cand.wamei, gakumei: cand.gakumei || "",
      kenshou: cand.kenshou || "", confidence: cand.conf,
      ai_riyu: cand.riyu || "", source: "from_ai",
    });
    setRecords((prev) => [rec, ...prev]);
    idbPut(rec).then(() => { if (navigator.onLine) doSync(); });
  }

  // 手動登録
  function saveManualRecord() {
    let wamei, gakumei, kenshou, source;
    if (manualMode === "master") {
      if (!manualMaster) { alert("種を選択してください。"); return; }
      const m = speciesMaster.find((s) => s.wamei === manualMaster);
      if (!m) return;
      wamei = m.wamei; gakumei = m.gakumei; kenshou = m.kenshou; source = "from_master";
    } else {
      if (!manualWamei.trim()) { alert("和名を入力してください。"); return; }
      wamei = manualWamei.trim(); gakumei = manualGakumei.trim(); kenshou = ""; source = "from_manual";
    }
    const rec = makeRecord({ wamei, gakumei, kenshou, confidence: null, ai_riyu: "", source, manual_reason: manualReason.trim() });
    setRecords((prev) => [rec, ...prev]);
    idbPut(rec).then(() => { if (navigator.onLine) doSync(); });
    setManualMaster(""); setManualWamei(""); setManualGakumei(""); setManualReason(""); setShowManual(false);
  }

  // 記録オブジェクトを組み立てる共通処理
  function makeRecord({ wamei, gakumei, kenshou, confidence, ai_riyu, source, manual_reason }) {
    const now = new Date().toISOString();
    return {
      // v0.8追加: DB同期に必要なフィールド
      record_id:        crypto.randomUUID(), // 重複しない一意ID(UUID)
      contributor:      myContributor,       // 登録者名
      created_at:       now,
      updated_at:       now,
      synced:           false,               // false=未同期・次回オンライン時にアップ
      // スプレッドシートのCOLS列に対応するフィールド
      host_tree:        host,
      substrate:        part,
      rot_type:         rotFilter,
      morphology:       { kata: shape, e_no_umu: hasStem, uramen: underside, shitsukan: texture, jumyo: lifespan, kasa_iro: capColor, henshoku: bruising },
      kettede:          answers,
      ai_candidates:    result?.candidates || [],
      ai_shoken:        result?.shoken || "",
      final_species:    wamei,
      final_species_id: speciesMaster.find(s => s.wamei === wamei)?.id ?? null,
      jouhougen:        source,
      confidence,
      ningen_riyu:      manual_reason || "",
      note:             "",
      // 旧フィールド(後方互換で残す)
      kakutei_wamei:   wamei,
      kakutei_gakumei: gakumei,
      kenshou_joutai:  kenshou,
      ai_riyu,
      ...(manual_reason ? { ningen_riyu: manual_reason } : {}),
      keitai: { kata: shape, e_no_umu: hasStem, uramen: underside, shitsukan: texture, jumyo: lifespan, kasa_iro: capColor, henshoku: bruising },
      kakuninzumi_kettede: answers,
      kiroku_nichiji:  now,
      shashin_maisu:   photos.length,
      season,
      rot_filter:      rotFilter,
    };
  }

  // JSONエクスポート
  function exportJSON() {
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `木材腐朽菌記録_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 自分の記録を削除(端末 + GAS)
  async function deleteRecord(record_id) {
    if (!confirm("この記録を削除しますか？\nこの操作は取り消せません。")) return;
    if (navigator.onLine && GAS_DB_URL !== "***") {
      try {
        await gasPost({ action: "delete", ids: [record_id] });
        await idbRemove(record_id);
      } catch {
        // GAS失敗時はtombstone(削除印)で後回し
        const all = await idbGetAll();
        const rec = all.find(r => r.record_id === record_id);
        if (rec) await idbPut({ ...rec, deleted: true });
      }
    } else {
      // オフライン: tombstone。次回オンライン同期時に削除される
      const all = await idbGetAll();
      const rec = all.find(r => r.record_id === record_id);
      if (rec) await idbPut({ ...rec, deleted: true });
    }
    const fresh = await idbGetAll();
    setRecords(sortRecords(fresh.filter(r => !r.deleted)));
  }

  // 検証状態バッジの色
  function kenshouBadge(k) {
    if (k === "済") return { label: "裏取り済", bg: "#E6EFE3", fg: C.sage };
    if (k === "叩き台") return { label: "叩き台・要裏取り", bg: "#FAF1D8", fg: C.amber };
    return { label: "未検証(名前のみ)", bg: "#F0E7E0", fg: C.rust };
  }

  const filteredCount = filterByRot(speciesMaster).length;

  // ============================================================
  // 画面
  // ============================================================
  return (
    <div style={{ minHeight: "100vh", background: C.paper, color: C.ink, fontFamily: "system-ui, sans-serif" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "20px 16px 64px" }}>

        <header style={{ borderBottom: `2px solid ${C.ink}`, paddingBottom: 12, marginBottom: 16 }}>
          <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: C.rust, letterSpacing: 1 }}>
            WOOD-DECAY FUNGI · 絞り込みPoC v0.8 · 収録65種
          </div>
          <h1 style={{ fontFamily: "Georgia, serif", fontSize: 26, margin: "4px 0 2px", fontWeight: 700 }}>
            木材腐朽菌 同定アシスト
          </h1>
          <p style={{ fontSize: 13, color: C.sub, margin: 0 }}>
            AIで候補を絞り、検索表の質問で確定に導きます。判定はあなた(樹木医)が行います。
          </p>
          <div style={{ marginTop: 10, padding: "8px 12px", borderRadius: 6, fontSize: 12, background: "#F3F1E8", border: `1px solid ${C.line}`, color: C.sub, lineHeight: 1.6 }}>
            <b style={{ color: C.ink }}>対象範囲</b>:現時点では<b>緑化樹木の主要木材腐朽菌(65種)</b>のみを収録しています。
            テングタケ・タマゴタケ・シイタケ・エノキなど普段見かけるキノコは順次追加予定です。<br />
            データは「緑化樹木腐朽病害ハンドブック」(日本緑化センター)に基づきます。
            腐朽菌は図鑑により色表現や説明が異なるため、今後ほかの資料の記載も併記していきます。
          </div>
        </header>

        {/* タブ切り替え（同定 / 掲載種一覧 / 記録） */}
        <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
          <button onClick={() => setActiveTab("identify")} style={tabStyle(activeTab === "identify")}>同定</button>
          <button onClick={() => setActiveTab("species")}  style={tabStyle(activeTab === "species")}>掲載種一覧({speciesMaster.length})</button>
          <button onClick={() => setActiveTab("records")}  style={tabStyle(activeTab === "records")}>
            記録{records.length > 0 ? `(${records.length})` : ""}
            {syncStatus === "syncing" && " ⟳"}
            {syncStatus === "error"   && " ⚠"}
          </button>
        </div>

        {/* ── 同定タブ ── */}
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
                <Field label="腐朽型(材の色)">
                  <select value={rotFilter} onChange={(e) => setRotFilter(e.target.value)} style={inputStyle()}>
                    <option value="不明">不明・未確認</option>
                    <option value="白色">白色腐朽(材が白っぽく繊維状)</option>
                    <option value="褐色">褐色腐朽(材が褐色で角状に崩れる)</option>
                  </select>
                </Field>
              </div>

              <p style={{ fontSize: 12, color: rotFilter === "不明" ? C.sub : C.sage, margin: "8px 0 0" }}>
                {rotFilter === "不明"
                  ? `絞り込み対象:全${speciesMaster.length}種(腐朽型を選ぶと候補を半分以下に絞れます)`
                  : `腐朽型「${rotFilter}」で絞り込み中 → 候補 ${filteredCount}種`}
              </p>

              <div style={{ marginTop: 12, borderTop: `1px dashed ${C.line}`, paddingTop: 10 }}>
                <button onClick={() => setShowMorph((v) => !v)}
                        style={{ background: "none", border: "none", color: C.rust, fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 0 }}>
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
                      <Field label="寿命(子実体の生存期間)">
                        <select value={lifespan} onChange={(e) => setLifespan(e.target.value)} style={inputStyle()}>
                          <option value="不明">不明</option>
                          <option value="一年生">一年生(その年で枯れる)</option>
                          <option value="多年生">多年生(年々成長し硬い)</option>
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
                <div style={{ padding: "8px 12px", borderRadius: 6, fontSize: 13, fontWeight: 600, marginBottom: 12, background: result.hantei === "保留" ? "#FAF1D8" : "#E6EFE3", color: result.hantei === "保留" ? C.amber : C.sage, border: `1px solid ${result.hantei === "保留" ? C.amber : C.sage}` }}>
                  判定:{result.hantei}　<span style={{ fontWeight: 400, color: C.ink }}>{result.comment}</span>
                </div>

                {result.shoken && (
                  <div style={{ marginBottom: 12, padding: 10, borderRadius: 6, background: "#F3F1E8", border: `1px solid ${C.line}` }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.rust, letterSpacing: 0.5, marginBottom: 4 }}>写真から見えた特徴(AIの所見)</div>
                    <div style={{ fontSize: 13, lineHeight: 1.7, color: C.ink }}>{result.shoken}</div>
                  </div>
                )}

                {(result.candidates || []).map((c, i) => {
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
                        <span style={{ display: "inline-block", fontSize: 11, fontWeight: 700, padding: "1px 8px", borderRadius: 10, background: badge.bg, color: badge.fg }}>{badge.label}</span>
                        {c.micro && <span style={{ display: "inline-block", fontSize: 11, fontWeight: 700, padding: "1px 8px", borderRadius: 10, background: "#FAF1D8", color: C.amber, border: `1px solid ${C.amber}` }}>顕微鏡確認推奨</span>}
                      </div>
                      <div style={{ height: 6, background: C.line, borderRadius: 3, margin: "6px 0 10px" }}>
                        <div style={{ width: `${Math.round((c.conf || 0) * 100)}%`, height: "100%", background: C.rust, borderRadius: 3 }} />
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <ChipBox title="写真で見えた" color={C.sage} items={c.mieru} />
                        <ChipBox title="未確認の決め手" color={C.amber} items={c.miketsu} />
                      </div>
                      {c.riyu && <p style={{ fontSize: 12, color: C.sub, margin: "8px 0 0" }}>根拠:{c.riyu}</p>}
                      <button
                        onClick={() => {
                          if (!savedCandIdx.has(i)) {
                            saveRecord(c);
                            setSavedCandIdx(prev => new Set([...prev, i]));
                          }
                        }}
                        disabled={savedCandIdx.has(i)}
                        style={savedCandIdx.has(i)
                          ? { ...ghostBtn(), background: "#E6EFE3", color: C.sage, border: `1px solid ${C.sage}`, cursor: "default" }
                          : ghostBtn()
                        }
                      >
                        {savedCandIdx.has(i) ? "✓ 記録済み(記録タブで確認)" : "この種で確定として記録"}
                      </button>
                    </div>
                  );
                })}

                {/* 手動登録 */}
                <div style={{ marginTop: 16, padding: 12, borderRadius: 8, border: `1px dashed ${C.line}`, background: "#FAF9F4" }}>
                  <button onClick={() => setShowManual((v) => !v)}
                          style={{ background: "none", border: "none", color: C.rust, fontSize: 13, fontWeight: 700, cursor: "pointer", padding: 0 }}>
                    {showManual ? "▼" : "▶"} 該当候補がない場合は手動で登録
                  </button>
                  {showManual && (
                    <div style={{ marginTop: 12 }}>
                      <p style={{ fontSize: 12, color: C.sub, margin: "0 0 10px" }}>
                        AIが判別を外した・候補に出ていない種を樹木医が確定して記録できます。記録には「手動登録」のタグが付き、後で振り返れます。
                      </p>
                      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                        <button onClick={() => setManualMode("master")} style={miniTabStyle(manualMode === "master")}>65種から選ぶ</button>
                        <button onClick={() => setManualMode("free")}   style={miniTabStyle(manualMode === "free")}>自由入力(65種外)</button>
                      </div>
                      {manualMode === "master" && (
                        <Field label="種(和名で選択)">
                          <select value={manualMaster} onChange={(e) => setManualMaster(e.target.value)} style={inputStyle()}>
                            <option value="">-- 選択してください --</option>
                            {speciesMaster.map((s) => <option key={s.id} value={s.wamei}>{s.wamei}（{s.gakumei}）</option>)}
                          </select>
                        </Field>
                      )}
                      {manualMode === "free" && (
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                          <Field label="和名">
                            <input value={manualWamei} onChange={(e) => setManualWamei(e.target.value)} placeholder="例:テングタケ" style={inputStyle()} />
                          </Field>
                          <Field label="学名(任意)">
                            <input value={manualGakumei} onChange={(e) => setManualGakumei(e.target.value)} placeholder="例:Amanita pantherina" style={inputStyle()} />
                          </Field>
                        </div>
                      )}
                      <Field label="判断理由(任意・後で精度向上に活用)">
                        <input value={manualReason} onChange={(e) => setManualReason(e.target.value)} placeholder="例:KOH反応で確認、宿主から確定 など" style={inputStyle()} />
                      </Field>
                      <button onClick={saveManualRecord} style={primaryBtn(false)}>手動登録として記録</button>
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
                                  style={{ padding: "6px 12px", borderRadius: 16, fontSize: 13, cursor: "pointer", border: `1px solid ${selected ? C.sage : C.line}`, background: selected ? C.sage : "#fff", color: selected ? "#fff" : C.ink }}>
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </section>
            )}
          </>
        )}

        {/* ── 掲載種一覧タブ ── */}
        {activeTab === "species" && <SpeciesList />}

        {/* ── 記録タブ ── */}
        {activeTab === "records" && (
          <section style={cardStyle()}>
            <SectionLabel>診断記録</SectionLabel>

            {/* 登録者名の設定 & 同期状態 */}
            <div style={{ marginBottom: 12, padding: "8px 12px", background: "#F3F1E8", borderRadius: 6, fontSize: 13, display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
              <span><b>登録者名:</b>{" "}
                {myContributor
                  ? <>{myContributor}
                      <button onClick={() => {
                        const v = prompt("登録者名を変更:", myContributor);
                        if (v?.trim()) { setMyContributor(v.trim()); localStorage.setItem("fungi_contributor", v.trim()); }
                      }} style={{ marginLeft: 6, fontSize: 11, padding: "1px 6px", cursor: "pointer" }}>変更</button>
                    </>
                  : <span style={{ color: C.rust }}>未設定
                      <button onClick={() => {
                        const v = prompt("登録者名を入力(自分の記録のみ削除できるようになります):");
                        if (v?.trim()) { setMyContributor(v.trim()); localStorage.setItem("fungi_contributor", v.trim()); }
                      }} style={{ marginLeft: 6, fontSize: 11, padding: "1px 6px", cursor: "pointer" }}>設定する</button>
                    </span>
                }
              </span>
              <span style={{ fontSize: 11, color: syncStatus === "error" ? C.rust : C.sub }}>
                {syncStatus === "idle"    && "未同期"}
                {syncStatus === "syncing" && "⟳ 同期中…"}
                {syncStatus === "ok"      && "✓ 同期済"}
                {syncStatus === "error"   && "⚠ 同期エラー"}
              </span>
              <button onClick={doSync} style={{ fontSize: 11, padding: "2px 8px", cursor: "pointer" }}>手動同期</button>
            </div>

            {/* 記録一覧 */}
            {records.length === 0
              ? <p style={{ color: C.sub, fontSize: 13 }}>記録はまだありません。「同定」タブで候補を確定すると、ここに自動保存されます。</p>
              : records.map(rec => {
                  const sourceLabel =
                    rec.jouhougen === "from_ai"     ? { txt: "AI確定",      bg: "#E6EFE3", fg: C.sage  } :
                    rec.jouhougen === "from_master" ? { txt: "手動(65種)",  bg: "#FAF1D8", fg: C.amber } :
                    rec.jouhougen === "from_manual" ? { txt: "手動(自由)",  bg: "#F0E7E0", fg: C.rust  } : null;
                  return (
                    <div key={rec.record_id} style={{ borderBottom: `1px solid ${C.line}`, padding: "10px 0" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                        <div>
                          <b style={{ fontSize: 15 }}>{rec.final_species || rec.kakutei_wamei}</b>
                          {" "}
                          {sourceLabel && (
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 8, background: sourceLabel.bg, color: sourceLabel.fg, marginLeft: 4 }}>
                              {sourceLabel.txt}
                            </span>
                          )}
                          {" "}
                          <span style={{ fontSize: 10, color: rec.synced ? C.sage : C.amber }}>
                            {rec.synced ? "✓同期済" : "●未同期"}
                          </span>
                        </div>
                        {/* 削除ボタン: 自分の登録のみ表示 */}
                        {(!myContributor || rec.contributor === myContributor) && (
                          <button onClick={() => deleteRecord(rec.record_id)}
                                  style={{ fontSize: 11, padding: "2px 8px", color: C.rust, border: `1px solid ${C.rust}`, borderRadius: 4, background: "white", cursor: "pointer" }}>
                            削除
                          </button>
                        )}
                      </div>
                      <div style={{ color: C.sub, fontSize: 12, marginTop: 3 }}>
                        {rec.host_tree || rec.host || "宿主不明"} / {rec.substrate || rec.part}
                        {" · "}
                        {(rec.created_at || rec.kiroku_nichiji || "").slice(0, 10)}
                        {rec.contributor && ` · ${rec.contributor}`}
                      </div>
                      {(rec.ningen_riyu || rec.ai_riyu) && (
                        <div style={{ fontSize: 12, marginTop: 2, color: C.sub }}>
                          理由: {rec.ningen_riyu || rec.ai_riyu}
                        </div>
                      )}
                    </div>
                  );
                })
            }

            {records.length > 0 && (
              <button onClick={exportJSON} style={{ ...primaryBtn(false), marginTop: 16 }}>
                記録をJSONで書き出す({records.length}件)
              </button>
            )}
          </section>
        )}

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

function cardStyle()   { return { background: C.card, border: `1px solid ${C.line}`, borderRadius: 10, padding: 16 }; }
function inputStyle()  { return { width: "100%", boxSizing: "border-box", padding: "7px 9px", fontSize: 13, border: `1px solid ${C.line}`, borderRadius: 6, background: "#fff" }; }
function primaryBtn(disabled) { return { width: "100%", marginTop: 14, padding: "11px", fontSize: 14, fontWeight: 700, color: "#fff", background: disabled ? C.sub : C.ink, border: "none", borderRadius: 8, cursor: disabled ? "default" : "pointer" }; }
function ghostBtn()    { return { marginTop: 10, padding: "7px 12px", fontSize: 12, color: C.ink, background: "#fff", border: `1px solid ${C.ink}`, borderRadius: 6, cursor: "pointer" }; }

function tabStyle(active) {
  return { flex: 1, padding: "9px 12px", fontSize: 14, fontWeight: 700, cursor: "pointer", color: active ? "#fff" : C.sub, background: active ? C.ink : "transparent", border: `1px solid ${active ? C.ink : C.line}`, borderRadius: 8 };
}
function miniTabStyle(active) {
  return { padding: "5px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer", color: active ? "#fff" : C.sub, background: active ? C.rust : "transparent", border: `1px solid ${active ? C.rust : C.line}`, borderRadius: 6 };
}

// ============================================================
// 掲載種一覧タブ
// ============================================================
function SpeciesList() {
  const [q, setQ] = useState("");
  const [rot, setRot] = useState("全て");

  const list = speciesMaster.filter((s) => {
    if (rot !== "全て") {
      if (!(s.rotType === rot || s.rotType === "両方" || s.rotType === "変色")) return false;
    }
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
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 10, marginBottom: 12 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="検索(例:サクラ / ベッコウ / Ganoderma)" style={inputStyle()} />
        <select value={rot} onChange={(e) => setRot(e.target.value)} style={inputStyle()}>
          <option value="全て">腐朽型:全て</option>
          <option value="白色">白色腐朽</option>
          <option value="褐色">褐色腐朽</option>
        </select>
      </div>
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
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            <Badge bg={s.rotType === "褐色" ? "#F0E7E0" : "#E6EFE3"} fg={s.rotType === "褐色" ? C.rust : C.sage}>{s.rot}</Badge>
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
      {list.length === 0 && <p style={{ fontSize: 13, color: C.sub }}>該当する種がありません。検索条件を変えてください。</p>}
    </section>
  );
}

function base64ToBlob(base64, mime) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function Badge({ bg, fg, children }) {
  return (
    <span style={{ display: "inline-block", fontSize: 11, fontWeight: 700, padding: "1px 8px", borderRadius: 10, background: bg, color: fg }}>
      {children}
    </span>
  );
}
