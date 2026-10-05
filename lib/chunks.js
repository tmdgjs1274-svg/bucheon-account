'use strict';
// 구글시트 셀 하나에는 최대 50,000자까지만 들어간다. 장부 데이터(JSON)가 그보다 커져도
// 잘리거나 저장이 실패하지 않도록 여러 칸에 나눠 담는다.
//  - 기존(Apps Script) 형식: 데이터가 한 칸에 통째로 들어 있다 → 조각 1개짜리로 그대로 읽힌다.
//  - 새 형식: 조각이 한 칸을 넘으면 같은 행의 오른쪽 칸에 이어서 담는다.
const CHUNK_SIZE = 40000;

function splitChunks(text) {
  if (text.length === 0) return [''];
  const out = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE) out.push(text.slice(i, i + CHUNK_SIZE));
  return out;
}

// row: 시트에서 읽은 한 행, from: 데이터 조각이 시작되는 열 인덱스
function joinChunks(row, from) {
  let s = '';
  for (let i = from; i < row.length; i++) {
    const v = row[i];
    if (v === '' || v === null || v === undefined) break;
    s += String(v);
  }
  return s;
}

module.exports = { CHUNK_SIZE, splitChunks, joinChunks };
