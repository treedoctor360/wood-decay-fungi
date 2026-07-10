// ============================================================
// Gemini中継Web App  v1.4  （単一責務・作り直し版）
//
// 役割: フロント(GitHub Pages)からのPOSTを受け、Geminiに中継する。
//       このプロジェクトは「Gemini中継」だけを持つ。記録DBは別プロジェクト
//       (records-db.gs) に完全分離する。1プロジェクト=1責務=doGet1個/doPost1個。
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
//
//   © 2026 Koh Kitsukawa. All rights reserved.
// ============================================================

const GEMINI_MODEL       = "gemini-2.5-flash";
const DAILY_LIMIT_DEFAULT = 300; // スクリプトプロパティ DAILY_LIMIT 未設定時の既定

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
// ------------------------------------------------------------
function doGet() {
  return ContentService
    .createTextOutput("Gemini中継Web App は動いています（v1.4）")
    .setMimeType(ContentService.MimeType.TEXT);
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

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      GEMINI_MODEL +
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

    if (code !== 200) {
      return jsonOut({ error: "Gemini APIエラー", status: code, detail: body });
    }
    return ContentService
      .createTextOutput(body)
      .setMimeType(ContentService.MimeType.JSON);
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
