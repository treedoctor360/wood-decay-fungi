// ============================================================
// 記録DB中継Web App  v2.0  （単一責務・作り直し版）
//
// 役割: 木材腐朽菌アプリの記録をスプレッドシートに保存/取得する中継。
//       このプロジェクトは「記録DB」だけを持つ。Gemini中継とは別プロジェクト
//       (gemini-relay.gs) に完全分離する。1プロジェクト=1責務。
//
// 旧版からの重要な変更（露出URL前提のハードニング）:
//   ①GET にもトークンを必須化。旧版は GET が素通しで、URLを知る誰でも
//     全記録をダウンロードできてしまっていた。これを塞ぐ。
//   ②ヘッダ駆動のupsert。シート1行目のヘッダ名をそのまま列スキーマとして扱う。
//     record_id 列をキーに、既存行があれば上書き、なければ追記する。
//     アプリ側のフィールドが増えてもヘッダに列を足すだけで対応できる。
//
// スクリプトプロパティ（プロジェクトの設定 → スクリプト プロパティ）:
//   TOKEN      … 必須。アプリの DB_TOKEN と一致させる共有トークン。
//   SHEET_ID   … 任意。対象スプレッドシートのID。未設定ならバインド中のシート。
//   SHEET_NAME … 任意。対象シート名（既定 "records"）。
//
// アプリとの通信契約（フロントの gasPost / gasGetAll と一致）:
//   GET  ?token=... &group=... → { ok:true, records:[...] }  ※group一致の記録のみ返す
//   POST { token, action:"save",   records:[...] }         → { ok:true, saved:n }
//   POST { token, action:"delete", ids:[...], group:"..." } → { ok:true, deleted:n }
//   ※Content-Type は text/plain（CORSプリフライト回避のため）。
//
// v2.1: 共有キーワード(group)によるグループ分けを追加。
//   各記録に group 列を持ち、GETは同じgroupの記録だけ返す（不特定多数の混入防止）。
//   deleteも同じgroupの記録だけ消せるようにサーバー側で確認（他グループを守る）。
//   ※groupは“グループの合言葉”であり個人認証ではない。同一group内では共有の鍵。
//
//   © 2026 Koh Kitsukawa. All rights reserved.
// ============================================================

const SHEET_NAME_DEFAULT = "records";
const KEY_COL            = "record_id"; // 主キーにする列名

// ------------------------------------------------------------
// 対象シートを取得（SHEET_ID があればそれ、なければバインド中のシート）
// ------------------------------------------------------------
function getSheet_() {
  const props = PropertiesService.getScriptProperties();
  const sheetName = props.getProperty("SHEET_NAME") || SHEET_NAME_DEFAULT;
  const sheetId   = props.getProperty("SHEET_ID");
  const ss = sheetId
    ? SpreadsheetApp.openById(sheetId)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error("スプレッドシートが見つかりません。スクリプトプロパティ SHEET_ID を設定してください。");
  }
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = ss.insertSheet(sheetName);
  return sheet;
}

// ヘッダ行（1行目）を配列で取得。空なら空配列。
function getHeader_(sheet) {
  const lastCol = sheet.getLastColumn();
  if (lastCol === 0) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
}

// トークン照合。TOKEN 未設定なら拒否（保存先を無防備にしないため必須運用）。
function tokenOK_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty("TOKEN");
  if (!expected) return false; // 未設定＝全拒否（安全側）
  return token === expected;
}

// ------------------------------------------------------------
// GET: 全記録を返す（トークン必須）
// ------------------------------------------------------------
function doGet(e) {
  try {
    const token = (e && e.parameter && e.parameter.token) || "";
    if (!tokenOK_(token)) return jsonOut({ ok: false, error: "認証エラー" });
    const group = (e && e.parameter && e.parameter.group) || ""; // 共有キーワード

    const sheet  = getSheet_();
    const header = getHeader_(sheet);
    const lastRow = sheet.getLastRow();
    if (header.length === 0 || lastRow < 2) return jsonOut({ ok: true, records: [] });

    const values = sheet.getRange(2, 1, lastRow - 1, header.length).getValues();
    let records = values.map(row => {
      const obj = {};
      header.forEach((h, i) => { obj[h] = row[i]; });
      return obj;
    });
    // 共有キーワード(group)が一致する記録だけ返す（不特定多数の混入を防ぐ）
    records = records.filter(r => String(r.group || "") === group);
    return jsonOut({ ok: true, records });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

// ------------------------------------------------------------
// POST: save / delete（トークン必須）
// ------------------------------------------------------------
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (_) {
    return jsonOut({ ok: false, error: "混雑しています。時間をおいて再度お試しください。" });
  }
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (!tokenOK_(body.token)) return jsonOut({ ok: false, error: "認証エラー" });

    if (body.action === "save")   return saveRecords_(body.records || []);
    if (body.action === "delete") return deleteRecords_(body.ids || [], body.group || "");
    return jsonOut({ ok: false, error: "未知のaction: " + body.action });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------
// save: record_id をキーにupsert。新しい列が来たらヘッダを自動拡張。
// ------------------------------------------------------------
function saveRecords_(records) {
  if (records.length === 0) return jsonOut({ ok: true, saved: 0 });
  const sheet = getSheet_();
  let header  = getHeader_(sheet);

  // ヘッダが未作成なら、最初のレコードのキーで作る（record_id を先頭に）
  if (header.length === 0) {
    const keys = Object.keys(records[0]);
    header = [KEY_COL].concat(keys.filter(k => k !== KEY_COL));
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
  }

  // 未知のキーが来たらヘッダ末尾に列を追加
  const known = new Set(header);
  const newCols = [];
  records.forEach(r => Object.keys(r).forEach(k => {
    if (!known.has(k)) { known.add(k); newCols.push(k); }
  }));
  if (newCols.length > 0) {
    sheet.getRange(1, header.length + 1, 1, newCols.length).setValues([newCols]);
    header = header.concat(newCols);
  }

  // 既存 record_id → 行番号 の対応表を作る
  const keyIdx = header.indexOf(KEY_COL);
  const lastRow = sheet.getLastRow();
  const rowOf = {};
  if (lastRow >= 2) {
    const keyVals = sheet.getRange(2, keyIdx + 1, lastRow - 1, 1).getValues();
    keyVals.forEach((v, i) => { rowOf[String(v[0])] = i + 2; });
  }

  let saved = 0;
  records.forEach(r => {
    const rowArr = header.map(h => (r[h] !== undefined ? r[h] : ""));
    const id = String(r[KEY_COL]);
    const existing = rowOf[id];
    if (existing) {
      sheet.getRange(existing, 1, 1, header.length).setValues([rowArr]);
    } else {
      const newRow = sheet.getLastRow() + 1;
      sheet.getRange(newRow, 1, 1, header.length).setValues([rowArr]);
      rowOf[id] = newRow;
    }
    saved++;
  });
  return jsonOut({ ok: true, saved });
}

// ------------------------------------------------------------
// delete: record_id 群に一致する行を削除（下から削除して行ずれを防ぐ）
//   group を指定した場合は、同じ group の行だけ削除する（他グループを守る）。
// ------------------------------------------------------------
function deleteRecords_(ids, group) {
  if (ids.length === 0) return jsonOut({ ok: true, deleted: 0 });
  const sheet = getSheet_();
  const header = getHeader_(sheet);
  const keyIdx = header.indexOf(KEY_COL);
  const grpIdx = header.indexOf("group");
  const lastRow = sheet.getLastRow();
  if (keyIdx < 0 || lastRow < 2) return jsonOut({ ok: true, deleted: 0 });

  const idSet = new Set(ids.map(String));
  const values = sheet.getRange(2, 1, lastRow - 1, header.length).getValues();
  const rowsToDelete = [];
  values.forEach((row, i) => {
    const idMatch  = idSet.has(String(row[keyIdx]));
    // group列がある場合は、リクエストのgroupと一致する行だけ削除対象にする
    const grpMatch = (grpIdx < 0) || (String(row[grpIdx] || "") === (group || ""));
    if (idMatch && grpMatch) rowsToDelete.push(i + 2);
  });

  rowsToDelete.sort((a, b) => b - a).forEach(rowNum => sheet.deleteRow(rowNum));
  return jsonOut({ ok: true, deleted: rowsToDelete.length });
}

// JSONを返すための小さな補助関数
function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
