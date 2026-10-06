// ============================================================
// Gemini中継Web App  v1.5  （単一責務・作り直し版）
//
// 役割: フロント(GitHub Pages)からのPOSTを受け、Geminiに中継する。
//       このプロジェクトは「Gemini中継」だけを持つ。記録DBは別プロジェクト
//       (records-db.gs) に完全分離する。1プロジェクト=1責務=doGet1個/doPost1個。
//
// v1.4 → v1.5 の変更点（混雑503対策）:
//   ①モデルをフォールバック方式に変更。503(混雑)/429/404なら次の候補で再試行。
//     "gemini-flash-latest" の実体は人気が集中して無料枠だと混みやすいため、
//     軽量版(flash-lite)などに自動で逃がす。
//   ②スクリプトプロパティ GEMINI_MODEL で最優先モデルを指定可能（コード修正不要）。
//   ③doGet に ?models=1 を追加。そのキーで使えるモデル一覧を表示する診断用。
//   ④エラー応答に tried（試したモデルとHTTPコード）を含め、原因を切り分けやすくした。
//
// v1.3 → v1.4 の変更点（露出URL前提のハードニング）:
//   ①1日あたりのレート制限を追加（PropertiesService + LockService）。
//     URLを拾った第三者にタダ乗りされても、1日の中継回数に上限がかかり
//     被害が頭打ちになる。呼び出し元が誰でも効く本命の防御。
//   ②任意の共有トークン（?token=...）に対応。スクリプトプロパティ
//     SHARED_TOKEN を設定すると有効化。URLだけ拾ったボット/スキャナを弾く。
//     ※フロントJSにトークンは見えるので本気の攻撃者は突破可能。あくまで
//       ハードルを上げるための補助。未設定なら従来どおりトークン不要。
//   ③APIキーはスクリプトプロパティ GEMINI_API_KEY から取得（v1.3から継続）。
//
// スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）:
//   GEMINI_API_KEY … 必須。Geminiのキー本体。
//   SHARED_TOKEN   … 任意。設定するとトークン照合が有効になる。
//   DAILY_LIMIT    … 任意。1日の中継上限（未設定なら下の既定値）。
//   GEMINI_MODEL   … 任意。最優先で使うモデル名（例 gemini-flash-lite-latest）。
//
//   © 2026 Koh Kitsukawa. All rights reserved.
// ============================================================

// モデル名。新規プロジェクトのキーでは古い固定名(gemini-2.5-flash等)が
// 使えないことがある。既定は常に最新のflashを指すエイリアス。
//
// ただし "gemini-flash-latest" の実体(最新flash)は人気が集中しやすく、
// 無料枠だと 503 UNAVAILABLE("high demand") が続くことがある。
// そこで候補を順に試すフォールバック方式にする。
//   503(混雑) / 429(レート超過) / 404(そのキーでは使えない) → 次の候補へ
//   200 → そのまま返す
//   400(リクエスト書式エラー) → 他モデルでも同じなので即座に返す
// スクリプトプロパティ GEMINI_MODEL を設定すると、それを最優先で試す。
const GEMINI_MODEL_FALLBACKS = [
  "gemini-flash-latest",      // 最新flash(高性能だが混雑しやすい)
  "gemini-flash-lite-latest", // 軽量flash。混雑時でも通りやすい
  "gemini-2.5-flash",         // 旧世代。既存ユーザーのキーなら使える
];
const DAILY_LIMIT_DEFAULT = 300; // スクリプトプロパティ DAILY_LIMIT 未設定時の既定

// 実際に試すモデルの並び。GEMINI_MODEL が設定されていれば先頭に置く。
function getModelCandidates_() {
  const pinned = PropertiesService.getScriptProperties().getProperty("GEMINI_MODEL");
  const list = GEMINI_MODEL_FALLBACKS.slice();
  if (pinned) {
    const i = list.indexOf(pinned);
    if (i >= 0) list.splice(i, 1);
    list.unshift(pinned);
  }
  return list;
}

// ------------------------------------------------------------
// スクリプトプロパティ取得ヘルパー
// ------------------------------------------------------------
function getApiKey_() {
  const key = PropertiesService.getScriptProperties().getProperty("GEMINI_API_KEY");
  if (!key) {
    throw new Error(
      "GEMINI_API_KEY がスクリプトプロパティに設定されていません。" +
      "GAS の「プロジェクトの設定 → スクリプト プロパティ」で登録してください。"
    );
  }
  return key;
}

function getDailyLimit_() {
  const v = Number(PropertiesService.getScriptProperties().getProperty("DAILY_LIMIT"));
  return (v && v > 0) ? v : DAILY_LIMIT_DEFAULT;
}

// 共有トークン照合。SHARED_TOKEN 未設定なら常に true（従来互換）。
function tokenOK_(e) {
  const expected = PropertiesService.getScriptProperties().getProperty("SHARED_TOKEN");
  if (!expected) return true; // 未設定＝トークン不要
  const got = (e && e.parameter && e.parameter.token) || "";
  return got === expected;
}

// ------------------------------------------------------------
// 1日レート制限。JSTの日付キーで当日カウントし、上限を超えたら false。
// LockService で同時アクセス時のカウント抜けを防ぐ。古い日付キーは掃除する。
// ------------------------------------------------------------
function underDailyLimit_() {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    // ロックが取れないときは止めない（フェイルオープン）。上限は多少甘くなる。
    return true;
  }
  try {
    const props = PropertiesService.getScriptProperties();
    const today = Utilities.formatDate(new Date(), "Asia/Tokyo", "yyyyMMdd");
    const key   = "count_" + today;
    const cur   = Number(props.getProperty(key) || "0");
    if (cur >= getDailyLimit_()) return false;
    props.setProperty(key, String(cur + 1));
    // 過去日のカウントキーを掃除（プロパティ肥大化を防ぐ）
    const all = props.getProperties();
    Object.keys(all).forEach(k => {
      if (k.indexOf("count_") === 0 && k !== key) props.deleteProperty(k);
    });
    return true;
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------
// 生存確認用：デプロイ後、ブラウザでWeb AppのURLを開くとこれが動く
//   ?models=1 を付けると、このキーで実際に使えるモデル一覧を表示する。
//   「モデル名が変わった/使えない」を疑ったときの確認用。
// ------------------------------------------------------------
function doGet(e) {
  if (e && e.parameter && e.parameter.models) {
    return ContentService
      .createTextOutput(listModels_())
      .setMimeType(ContentService.MimeType.TEXT);
  }
  return ContentService
    .createTextOutput(
      "Gemini中継Web App は動いています（v1.5）\n" +
      "モデル候補: " + getModelCandidates_().join(" → ") + "\n" +
      "このキーで使えるモデル一覧: URLの末尾に ?models=1 を付けて開く"
    )
    .setMimeType(ContentService.MimeType.TEXT);
}

// このAPIキーで generateContent が使えるモデル名を一覧する（診断用）
function listModels_() {
  try {
    const res = UrlFetchApp.fetch(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
      { headers: { "x-goog-api-key": getApiKey_() }, muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) {
      return "モデル一覧の取得に失敗 (HTTP " + res.getResponseCode() + ")\n" + res.getContentText();
    }
    const models = (JSON.parse(res.getContentText()).models || [])
      .filter(m => (m.supportedGenerationMethods || []).indexOf("generateContent") >= 0)
      .map(m => String(m.name).replace("models/", ""));
    return "generateContent が使えるモデル (" + models.length + "件)\n" + models.join("\n");
  } catch (err) {
    return "モデル一覧の取得で例外: " + String(err);
  }
}

// ------------------------------------------------------------
// 本番用：フロントからのPOSTを受けてGeminiに中継する
// ------------------------------------------------------------
function doPost(e) {
  try {
    if (!tokenOK_(e)) {
      return jsonOut({ error: "認証エラー: トークンが一致しません" });
    }
    if (!underDailyLimit_()) {
      return jsonOut({ error: "本日の利用上限に達しました。時間をおいて再度お試しください。", limited: true });
    }

    const reqBody = (e && e.postData && e.postData.contents) || "";
    if (!reqBody) {
      return jsonOut({ error: "リクエスト本体が空です" });
    }

    const models = getModelCandidates_();
    const tried  = [];
    let lastCode = 0;
    let lastBody = "";

    // 混雑(503)・レート超過(429)・未提供(404)は、次のモデル候補で試す
    for (let i = 0; i < models.length; i++) {
      const url =
        "https://generativelanguage.googleapis.com/v1beta/models/" +
        models[i] +
        ":generateContent";

      const res = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        headers: { "x-goog-api-key": getApiKey_() },
        payload: reqBody,
        muteHttpExceptions: true,
      });

      const code = res.getResponseCode();
      const body = res.getContentText();
      tried.push(models[i] + ":" + code);
      lastCode = code;
      lastBody = body;

      if (code === 200) {
        return ContentService
          .createTextOutput(body)
          .setMimeType(ContentService.MimeType.JSON);
      }
      // リクエスト書式のエラーは、どのモデルでも同じ結果になるので即返す
      if (code !== 503 && code !== 429 && code !== 404) break;
    }

    return jsonOut({
      error: "Gemini APIエラー",
      status: lastCode,
      detail: lastBody,
      tried: tried.join(", "), // どのモデルで何が返ったか（原因切り分け用）
    });
  } catch (err) {
    return jsonOut({ error: "中継中に例外", detail: String(err) });
  }
}

// JSONを返すための小さな補助関数
function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
