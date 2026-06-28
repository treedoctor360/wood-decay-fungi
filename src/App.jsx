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

// ============================================================
// AI接続設定（GAS経由でGeminiを呼ぶ）
//   GAS_URL は「Gemini中継Web App（GAS）」のデプロイURL。
//   GASがGeminiのAPIキーを隠して中継するので、ここにキーは書かない。
// ============================================================
const GAS_URL =
  "https://script.google.com/macros/s/AKfycbwfSHmBl8VYy635RPq0hnc_q_wJw1Cgrg0NzXDcucBmK0jTVOvDKbMxeYqvr-UtCyJ9fQ/exec";

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

// GETで全件取得
async function gasGetAll() {
  const res = await fetch(GAS_DB_URL);
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
// speciesMaster:緑化樹木木材腐朽菌リスト(全65種・裏取り済み)
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
  { id: 17, wamei: "ツガサルノコシカケ", gakumei: "Ganoderma tsugae", kamei: "マンネンタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "針葉樹・特にツガ・モミ", part: "根株・幹", micro: false,
    mieru: ["傘が漆塗り様の光沢(赤褐色〜紫褐色)", "縁は白〜クリーム色(成長点)", "柄あり・側生・長い"],
    kettede: ["担子胞子9〜11×6〜7.5μm・卵形・二重壁(内壁に柱状突起)", "コフキタケ(G. applanatum)より光沢が強く柄が長い(鑑別)"],
    shutten: [SOURCES.handbook2017] },
  { id: 18, wamei: "マンネンタケ(霊芝)", gakumei: "Ganoderma lucidum", kamei: "マンネンタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹・特にコナラ・クヌギ", part: "根株・幹", micro: false,
    mieru: ["傘は漆塗り様(赤〜赤褐色)・有光沢", "側生の長い柄あり", "傘径5〜20cm"],
    kettede: ["担子胞子9〜11×6〜7μm・卵形・有色・二重壁(ツガサルノコシカケと形態的に酷似・宿主で区別)", "傘表面は平滑で光沢強"],
    shutten: [SOURCES.handbook2017] },
  { id: 19, wamei: "コフキタケ", gakumei: "Ganoderma applanatum", kamei: "マンネンタケ科", kenshou: "済",
    rotType: "白色", rot: "根株・幹の心材腐朽・白色腐朽", host: "広葉樹・まれに針葉樹", part: "根株・幹", micro: false,
    mieru: ["多年生・半円形〜扇形・無柄または短柄", "傘表面に灰白色〜褐色の粉(担子胞子)が積もる", "傷つけると管孔面(白)が褐色に変色"],
    kettede: ["傷で管孔面が褐変→絵が描ける(決定的)", "傘表面は光沢なく粗い(マンネンタケとの区別)", "担子胞子6.5〜9×4〜6μm"],
    shutten: [SOURCES.handbook2017] },
  { id: 20, wamei: "シハイタケ", gakumei: "Trametes versicolor", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: false,
    mieru: ["薄い扇形・多数重なる", "傘表面に多色の同心円帯(白〜灰〜青〜茶)", "裏面は白色・管孔が小さい(1mmに3〜5個)"],
    kettede: ["傘表面に絹状の光沢", "管孔が小さく密(1mmに3〜5個)", "担子胞子5〜8×1.5〜2μm・円筒形"],
    shutten: [SOURCES.handbook2017] },
  { id: 21, wamei: "アラゲカワラタケ", gakumei: "Trametes hirsuta", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: false,
    mieru: ["薄い扇形・単生〜重生", "傘表面に灰〜白色の粗毛が密生・環紋あり", "裏面の管孔は白色"],
    kettede: ["傘表面の粗毛(シハイタケとの鑑別:本種は粗毛、シハイタケは絹状毛)", "担子胞子6〜9×2〜3μm・円筒形"],
    shutten: [SOURCES.handbook2017] },
  { id: 22, wamei: "アミタケモドキ(ウスムラサキアナタケ)", gakumei: "Trametes elegans", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹の心材腐朽・白色腐朽", host: "広葉樹(熱帯系)", part: "幹", micro: false,
    mieru: ["半円形〜扇形・幅3〜10cm", "傘表面は淡灰白色・平滑〜短毛", "管孔が大きく迷路状〜六角形(特徴的)"],
    kettede: ["大きな迷路状〜六角形の管孔(1mmに1〜2個)(決定的)", "担子胞子8〜11×3〜4μm・楕円形〜円筒形", "分布:南西諸島〜九州・温暖地"],
    shutten: [SOURCES.handbook2017] },
  { id: 23, wamei: "オオアナタケ", gakumei: "Trametes cervina", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: false,
    mieru: ["半円形〜扇形・幅2〜8cm", "傘表面は白〜灰白色・平滑〜短毛", "管孔はやや大きめ・円形〜角形"],
    kettede: ["孔口の縁に担子胞子を付けた房状結晶(顕微鏡で確認)", "担子胞子5〜6×2〜3μm"],
    shutten: [SOURCES.handbook2017] },
  { id: 24, wamei: "ヤネタケ", gakumei: "Antrodia sinuosa", kamei: "タマチョレイタケ科", kenshou: "済",
    rotType: "褐色", rot: "枝や幹の心材腐朽・褐色腐朽", host: "針葉樹(マツ・ヒノキ等)", part: "枝・幹", micro: false,
    mieru: ["背着生・不定型・白〜クリーム色", "管孔面は波状〜迷路状"],
    kettede: ["針葉樹の褐色腐朽菌(白色腐朽菌との鑑別で材の色が重要)", "担子胞子6〜9×2.5〜3.5μm・楕円形"],
    shutten: [SOURCES.handbook2017] },
  { id: 25, wamei: "ニクウスバタケ", gakumei: "Antrodiella semisupina", kamei: "タマチョレイタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: false,
    mieru: ["半背着生・白〜クリーム色・薄い", "管孔は小さく円形(1mmに3〜5個)"],
    kettede: ["担子胞子3〜4×1.5〜2μm・楕円形・無色"],
    shutten: [SOURCES.handbook2017] },
  { id: 26, wamei: "ニガクリタケ", gakumei: "Hypholoma fasciculare", kamei: "モエギタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹・まれに針葉樹", part: "根株・地際", micro: false,
    mieru: ["小型(径2〜5cm)・硫黄〜緑がかった黄色", "株状に多数発生", "ツバを欠く"],
    kettede: ["強い苦味(舐めると分かる)", "ヒダが黄緑色(成熟で暗紫色)", "担子胞子6〜8×3.5〜4μm・卵形"],
    shutten: [SOURCES.handbook2017] },
  { id: 27, wamei: "チャワンタケ類", gakumei: "Peziza spp.", kamei: "チャワンタケ科", kenshou: "済",
    rotType: "白色", rot: "腐朽力不明(腐生性が強い)", host: "広葉樹・針葉樹", part: "根株・土壌", micro: true,
    mieru: ["碗状〜皿状", "地際・土壌・切り株に発生"],
    kettede: ["子のう菌類(担子菌でない)", "子のう胞子の形・大きさで種を区別(顕微鏡必須)"],
    shutten: [SOURCES.handbook2017] },
  { id: 28, wamei: "ベッコウタケ", gakumei: "Phaeolus schweinitzii", kamei: "タマチョレイタケ科", kenshou: "済",
    rotType: "褐色", rot: "根株・幹基部の心材腐朽・褐色腐朽", host: "針葉樹(マツ・スギ・ヒノキ等)", part: "根株・幹", micro: false,
    mieru: ["大型(径10〜30cm)・傘は同心円状・幼時は黄金〜橙色→老熟で焦茶色", "傘下面(管孔面)は緑がかった黄色〜黄褐色", "根本・土中の菌核から発生"],
    kettede: ["KOH液で傘肉が紫黒色に変色(決定的)", "褐色腐朽(材が角状に崩れる)", "担子胞子6〜8×3.5〜4.5μm・楕円形"],
    shutten: [SOURCES.handbook2017] },
  { id: 29, wamei: "マスタケ", gakumei: "Laetiporus sulphureus", kamei: "タマチョレイタケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽・褐色腐朽", host: "広葉樹・まれに針葉樹", part: "幹", micro: false,
    mieru: ["鮮やかな橙〜橙赤色・肉質・柔軟(幼時)", "老熟すると白化・硬化", "棚状・扇状に重なる・大型"],
    kettede: ["鮮橙色(成体は白化)(決定的)", "褐色腐朽", "担子胞子5〜7×3.5〜5μm・卵形〜広楕円形"],
    shutten: [SOURCES.handbook2017] },
  { id: 30, wamei: "カイガラタケ", gakumei: "Lenzites betulina", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: false,
    mieru: ["扇〜半円形(幅2〜10cm)・無柄・硬い革質", "傘表面は白〜灰白色・短毛・環紋あり", "裏面は白色のヒダ(管孔でない)"],
    kettede: ["裏面がヒダ状(サルノコシカケ型なのに裏面がヒダ)(決定的)", "担子胞子5〜7×2〜3μm"],
    shutten: [SOURCES.handbook2017] },
  { id: 31, wamei: "チリメンタケ", gakumei: "Stereum hirsutum", kamei: "チャカイガラタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: false,
    mieru: ["背着生〜半背着生・扇形の小傘が多数重なる", "傘表面に短毛・黄〜橙〜灰色の環紋", "裏面は平滑・橙〜肌色(管孔なし)"],
    kettede: ["傷をつけても変色しない(ニセチャカイガラタケは赤変:鑑別)", "担子胞子5〜7×2〜3μm"],
    shutten: [SOURCES.handbook2017] },
  { id: 32, wamei: "ニセチャカイガラタケ", gakumei: "Stereum gausapatum", kamei: "チャカイガラタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "コナラ・カシ類等広葉樹", part: "枝・幹", micro: false,
    mieru: ["チリメンタケとほぼ同形・幅1〜3cm"],
    kettede: ["傷をつけると赤変(出血する)(決定的・チリメンタケとの区別)", "担子胞子8〜10×3〜4.5μm"],
    shutten: [SOURCES.handbook2017] },
  { id: 33, wamei: "ハリタケ", gakumei: "Hericium erinaceus", kamei: "ヤマブシタケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹(コナラ・ブナ等)", part: "幹", micro: false,
    mieru: ["白色〜クリーム色・かたまりから長い針(5〜10cm)が垂れ下がる", "新鮮時は白色・老熟で黄褐色", "大型(径10〜30cm)"],
    kettede: ["長い垂下する針状の子実層(決定的・他に類似種なし)", "担子胞子5〜7×4〜5μm・類球形"],
    shutten: [SOURCES.handbook2017] },
  { id: 34, wamei: "カノシタ", gakumei: "Hydnum repandum", kamei: "カノシタ科", kenshou: "済",
    rotType: "白色", rot: "腐朽力は弱い・外生菌根菌", host: "広葉樹・針葉樹(外生菌根)", part: "地中・根", micro: false,
    mieru: ["傘と柄をもつキノコ形(径3〜10cm)", "傘は淡橙〜淡黄色・平滑〜ざらつく", "裏面に針状の突起(長さ3〜5mm)が密生"],
    kettede: ["裏面に密生する針状突起(ヒダでも管孔でもない)(決定的)", "外生菌根菌なので腐朽力は弱い", "担子胞子6〜9×5〜7μm・類球形"],
    shutten: [SOURCES.handbook2017] },
  { id: 35, wamei: "ツヤウチワタケ", gakumei: "Hexagonia tenuis", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: false,
    mieru: ["薄い扇〜半円形(幅5〜10cm)・革質", "傘表面は濃い灰褐色〜焦茶色・光沢・環紋あり", "管孔が大型六角形(特徴)"],
    kettede: ["六角形の大きな管孔(1mmに1〜2個)(決定的)", "担子胞子11〜15×3〜5μm・細長い"],
    shutten: [SOURCES.handbook2017] },
  { id: 36, wamei: "エゴノキタケ", gakumei: "Dichomitus campestris", kamei: "タマチョレイタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹(エゴノキ等)", part: "枝・幹", micro: false,
    mieru: ["半背着生〜小傘あり(幅1〜5cm)・白〜クリーム色", "管孔が小さい(1mmに4〜6個)"],
    kettede: ["担子胞子8〜14×3〜4.5μm・円筒形・無色", "かすがい連結を持つ"],
    shutten: [SOURCES.handbook2017] },
  { id: 37, wamei: "サルノコシカケ", gakumei: "Fomes fomentarius", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹(ブナ・シラカバ・ハンノキ等)", part: "幹", micro: false,
    mieru: ["多年生・蹄形・幅5〜50cm・非常に硬い木質〜コルク質", "傘表面は灰〜灰褐色・幅広い環溝", "裏面の管孔面は淡褐色"],
    kettede: ["多年生で毎年管孔を更新(断面に年輪状の層)", "担子胞子15〜20×4〜7μm・大型・細長い", "分布:温帯〜亜寒帯"],
    shutten: [SOURCES.handbook2017] },
  { id: 38, wamei: "ツガサルノコシカケモドキ", gakumei: "Ganoderma oregonense", kamei: "マンネンタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "針葉樹(ツガ・モミ等)", part: "根株・幹", micro: false,
    mieru: ["マンネンタケ類似・柄があり光沢(赤褐色)", "大型(幅可達30cm以上)"],
    kettede: ["担子胞子10〜14×6.5〜9μm・マンネンタケより大型", "針葉樹(ツガ・モミ)に多い(宿主で鑑別補助)"],
    shutten: [SOURCES.handbook2017] },
  { id: 39, wamei: "アシグロタケ", gakumei: "Polyporus melanopus", kamei: "タマチョレイタケ科", kenshou: "済",
    rotType: "白色", rot: "根株・幹基部の心材腐朽・白色腐朽", host: "広葉樹", part: "根株・地際", micro: false,
    mieru: ["傘と中心生〜偏心生の柄あり(径3〜15cm)", "傘表面は淡褐色〜灰褐色・鱗片あり", "柄の基部が黒色(決定的)"],
    kettede: ["柄基部が明確に黒色(決定的)", "管孔は白色・小さい(1mmに4〜7個)", "担子胞子7〜11×3〜5μm・円筒形"],
    shutten: [SOURCES.handbook2017] },
  { id: 40, wamei: "タコウキン(多孔菌)", gakumei: "Polyporus squamosus", kamei: "タマチョレイタケ科", kenshou: "済",
    rotType: "白色", rot: "幹や枝の心材腐朽・白色腐朽", host: "広葉樹", part: "幹・枝", micro: false,
    mieru: ["大型(径10〜60cm)・円形〜扇形・肉質", "傘表面に濃褐色の鱗片が同心円状", "側生の太い柄あり"],
    kettede: ["大型で円形(決定的・他のサルノコシカケ型は扇〜半円形が多い)", "管孔は大きめ(1mmに1〜2個)・角形〜迷路状", "担子胞子10〜16×4〜6μm・長楕円形"],
    shutten: [SOURCES.handbook2017] },
  { id: 41, wamei: "ヒトクチタケ", gakumei: "Cryptoporus volvatus", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "褐色", rot: "幹心材腐朽・褐色腐朽", host: "針葉樹(マツ・モミ等)", part: "幹", micro: false,
    mieru: ["小型(径2〜5cm)・白〜黄白色・表面は平滑で光沢", "卵形〜球形", "管孔を覆う外皮に小孔が1つあるだけ(特徴的)"],
    kettede: ["外皮の下に管孔が隠れている(決定的)", "担子胞子12〜16×4〜5μm・細長い", "褐色腐朽菌"],
    shutten: [SOURCES.handbook2017] },
  { id: 42, wamei: "タバコウロコタケ", gakumei: "Inonotus cuticularis", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "幹の心材腐朽・白色腐朽", host: "広葉樹(ブナ・コナラ等)", part: "幹", micro: false,
    mieru: ["半円形〜扇形・幅5〜20cm・多数重なる", "傘表面に粗い繊維状鱗片・黄褐色〜焦茶色", "生時は水分を含み柔軟→乾くと硬化・暗褐色"],
    kettede: ["生時に傘表面と管孔面が橙黄色の汁を滲出", "子実層に剛毛体が多数(長さ25〜55μm)", "担子胞子5〜7×4〜5.5μm・広楕円形・黄褐色"],
    shutten: [SOURCES.handbook2017] },
  { id: 43, wamei: "ブナサルノコシカケ", gakumei: "Ganoderma lipsiense", kamei: "マンネンタケ科", kenshou: "済",
    rotType: "白色", rot: "根株・幹の心材腐朽・白色腐朽", host: "広葉樹(ブナ・コナラ等)", part: "根株・幹", micro: false,
    mieru: ["多年生・扁平・広い半円形(幅10〜60cm以上)", "傘表面は無光沢・灰〜灰褐色・硬い殻皮", "管孔面(裏面)は白〜クリーム色・傷で褐変"],
    kettede: ["傷で管孔面が褐変(コフキタケと同様)", "担子胞子7〜10×5〜6.5μm・広楕円形(コフキタケより大型)", "分布:全国(ブナ帯に多い)"],
    shutten: [SOURCES.handbook2017] },
  { id: 44, wamei: "カクホウライタケ", gakumei: "Hexagonia apiaria", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: false,
    mieru: ["半円形〜扇形・幅3〜10cm・革質", "傘表面は灰〜灰褐色・短毛・環紋あり", "管孔は六角形(ツヤウチワタケより小さい)"],
    kettede: ["六角形の管孔(1mmに2〜3個)(ツヤウチワタケより細かい)", "担子胞子10〜14×4〜5μm"],
    shutten: [SOURCES.handbook2017] },
  { id: 45, wamei: "スジウチワタケモドキ", gakumei: "Earliella scabrosa", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: false,
    mieru: ["扇形〜貝形(幅2〜8cm)・薄い", "傘表面は白〜灰白色・短毛・環紋あり"],
    kettede: ["管孔の縁が鋸歯状(決定的)", "担子胞子8〜12×2.5〜4μm・細長い"],
    shutten: [SOURCES.handbook2017] },
  { id: 46, wamei: "シロアミタケ", gakumei: "Trametes lactinea", kamei: "サルノコシカケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: false,
    mieru: ["扇形〜半円形(幅2〜10cm)", "傘表面・管孔面ともに白〜クリーム色", "管孔が迷路状〜ヒダ状"],
    kettede: ["管孔が迷路状〜ヒダ状(通常の円形管孔でない)", "担子胞子7〜10×3〜4μm・楕円形"],
    shutten: [SOURCES.handbook2017] },
  { id: 47, wamei: "ハチノスタケ", gakumei: "Favolus arcularius", kamei: "タマチョレイタケ科", kenshou: "済",
    rotType: "白色", rot: "枝の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・細い幹", micro: false,
    mieru: ["小型(径1〜5cm)・円形〜扇形", "中心生の短い柄あり", "管孔が大きく六角形で蜂の巣状(特徴)"],
    kettede: ["蜂の巣状の大きな六角形管孔(決定的)", "担子胞子7〜10×2.5〜4μm・長楕円形"],
    shutten: [SOURCES.handbook2017] },
  { id: 48, wamei: "サンゴハリタケ", gakumei: "Hericium coralloides", kamei: "ヤマブシタケ科", kenshou: "済",
    rotType: "白色", rot: "幹心材腐朽・白色腐朽", host: "広葉樹(ブナ等)", part: "幹", micro: false,
    mieru: ["白色〜クリーム色・珊瑚状に分枝し、枝の先端に短い針が垂れる", "ハリタケより小型(径5〜20cm)"],
    kettede: ["珊瑚状の分枝と短い垂下針の組み合わせ(決定的)", "担子胞子3〜5×3〜4μm・類球形(ハリタケより小さい)"],
    shutten: [SOURCES.handbook2017] },
  { id: 49, wamei: "ミヤマトンビマイ", gakumei: "Polyporus varius", kamei: "タマチョレイタケ科", kenshou: "済",
    rotType: "白色", rot: "枝や幹の心材腐朽・白色腐朽", host: "広葉樹", part: "枝・幹", micro: false,
    mieru: ["小型〜中型(径2〜10cm)・円形〜扇形", "傘表面は淡黄褐色〜蜂蜜色", "柄は基部〜中部が黒褐色"],
    kettede: ["柄の途中から下が黒色(アシグロタケは基部のみが黒)(鑑別)", "担子胞子7〜11×2.5〜4μm・長楕円形"],
    shutten: [SOURCES.handbook2017] },
  { id: 50, wamei: "オサムシタケ", gakumei: "Cordyceps militaris", kamei: "バッカクキン科", kenshou: "済",
    rotType: "白色", rot: "昆虫寄生性(木材腐朽力なし)・参考収録", host: "昆虫類(チョウ・ガの蛹)", part: "地中蛹", micro: false,
    mieru: ["橙色の棒状子実体(長さ2〜8cm)・地面から生える", "表面にザラザラした粒粒(子のう殻)"],
    kettede: ["橙色の棒状で昆虫から生える(決定的)", "木材を腐朽させないため本リストでは参考収録"],
    shutten: [SOURCES.handbook2017] },
  { id: 51, wamei: "オニカワウソタケ", gakumei: "Inonotus dryadeus", kamei: "タバコウロコタケ科", kenshou: "済",
    rotType: "白色", rot: "根株心材腐朽・白色腐朽", host: "広葉樹・特にカシ・ナラ類", part: "根株・幹", micro: false,
    mieru: ["幅10〜40cm・大型・半円形〜不定形", "生時に傘表面から琥珀色の水滴を滲出(特徴)"],
    kettede: ["生時に水滴を分泌(カワウソタケとの決定的区別)", "剛毛体を持つ(カワウソタケは欠く)", "担子胞子7〜9×5〜7μm・広楕円形〜類球形・薄壁・無色"],
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
  const [rotFilter, setRotFilter] = useState("不明");
  const [hasStem, setHasStem] = useState("不明");
  const [shape, setShape] = useState("不明");
  const [capColor, setCapColor] = useState("");
  const [underside, setUnderside] = useState("不明");
  const [texture, setTexture] = useState("不明");
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
      host: s.host, part: s.part, micro: s.micro, mieru: s.mieru, kettede: s.kettede,
    }));

    const answeredText = Object.keys(currentAnswers).length > 0
      ? Object.entries(currentAnswers).map(([k, v]) => `・${k}:${v}`).join("\n")
      : "(まだ確認済みの決め手はありません)";

    const rotText = rotFilter === "不明" ? "未確認(腐朽型での絞り込みなし)" : `${rotFilter}腐朽(材がその色)`;

    const morphPairs = [
      ["子実体の型", shape], ["柄の有無", hasStem], ["裏面(胞子を作る面)", underside],
      ["傘表面の色", capColor], ["質感", texture], ["傷つけたときの変色・特記", bruising],
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
      morphology:       { kata: shape, e_no_umu: hasStem, uramen: underside, shitsukan: texture, kasa_iro: capColor, henshoku: bruising },
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
      keitai: { kata: shape, e_no_umu: hasStem, uramen: underside, shitsukan: texture, kasa_iro: capColor, henshoku: bruising },
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
