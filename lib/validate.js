'use strict';
// 서버로 들어오는 장부 데이터가 앱이 쓰는 모양인지 확인한다 — 이상한 데이터가
// 시트의 정상 데이터를 덮어쓰지 못하게 하는 마지막 관문.
function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function validateLedger(data) {
  if (!isPlainObject(data)) return '데이터 형식이 올바르지 않습니다.';
  if (!Array.isArray(data.players) || data.players.length !== 3 || !data.players.every(p => typeof p === 'string')) {
    return 'players는 문자열 3개여야 합니다.';
  }
  if (!Array.isArray(data.rows) || !data.rows.every(isPlainObject)) return 'rows 형식이 올바르지 않습니다.';
  if (!Array.isArray(data.cashRows) || !data.cashRows.every(isPlainObject)) return 'cashRows 형식이 올바르지 않습니다.';
  return null;
}

// 앱이 저장하는 필드만 남긴다 (알 수 없는 큰 값이 시트로 흘러 들어가는 것 방지).
function normalizeLedger(data) {
  return { players: data.players, rows: data.rows, cashRows: data.cashRows };
}

module.exports = { validateLedger, normalizeLedger };
