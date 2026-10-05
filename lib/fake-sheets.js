'use strict';
// 메모리 안에서 동작하는 가짜 구글시트 클라이언트 (실제 @googleapis/sheets 와 같은 모양으로 쓰는 부분만 구현).
// 용도: ① 자동 테스트 ② 구글 계정 없이 로컬에서 앱 돌려보기 (STORE=memory).
// 운영에서는 쓰지 않는다.
function colToNum(c) { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }

function parseRange(range) {
  const m = /^(.+)!([A-Z]+)(\d*)(?::([A-Z]+)(\d*))?$/.exec(range);
  if (!m) throw new Error('fake-sheets: 지원하지 않는 range ' + range);
  const [, tab, c1, r1, c2, r2] = m;
  return {
    tab, c1: colToNum(c1), r1: r1 ? Number(r1) : 1,
    c2: c2 ? colToNum(c2) : colToNum(c1), r2: c2 ? (r2 ? Number(r2) : Infinity) : (r1 ? Number(r1) : 1),
    single: !c2
  };
}

function createFakeSheets(seed = {}) {
  let nextSheetId = 1;
  const tabs = {}; // title -> { sheetId, rows: [[...]] }
  for (const [title, rows] of Object.entries(seed)) tabs[title] = { sheetId: nextSheetId++, rows: rows.map(r => r.slice()) };
  const calls = []; // 테스트에서 어떤 호출이 있었는지 확인용

  const tabOf = title => { if (!tabs[title]) throw new Error('fake-sheets: 탭 없음 ' + title); return tabs[title]; };

  return {
    _tabs: tabs, _calls: calls,
    spreadsheets: {
      async get() {
        calls.push('get');
        return { data: { sheets: Object.entries(tabs).map(([title, t]) => ({ properties: { title, sheetId: t.sheetId } })) } };
      },
      async batchUpdate({ requestBody }) {
        calls.push('batchUpdate');
        const replies = [];
        for (const rq of requestBody.requests) {
          if (rq.addSheet) {
            const title = rq.addSheet.properties.title;
            if (tabs[title]) throw new Error('fake-sheets: 이미 있는 탭 ' + title);
            tabs[title] = { sheetId: nextSheetId++, rows: [] };
            replies.push({ addSheet: { properties: { title, sheetId: tabs[title].sheetId } } });
          } else if (rq.deleteDimension) {
            const { sheetId, startIndex, endIndex } = rq.deleteDimension.range;
            const t = Object.values(tabs).find(x => x.sheetId === sheetId);
            t.rows.splice(startIndex, endIndex - startIndex);
            replies.push({});
          } else throw new Error('fake-sheets: 지원하지 않는 요청');
        }
        return { data: { replies } };
      },
      values: {
        async get({ range }) {
          calls.push('values.get ' + range);
          const p = parseRange(range);
          const t = tabOf(p.tab);
          const out = [];
          const last = Math.min(p.r2, t.rows.length);
          for (let r = p.r1; r <= last; r++) {
            const src = t.rows[r - 1] || [];
            const row = [];
            for (let c = p.c1; c <= Math.min(p.c2, src.length === 0 ? 0 : 1e9); c++) {
              const v = src[c - 1];
              row.push(v === undefined ? '' : v);
            }
            while (row.length && row[row.length - 1] === '') row.pop();
            out.push(row);
          }
          while (out.length && out[out.length - 1].length === 0) out.pop();
          return { data: { values: out.length ? out : undefined } };
        },
        async update({ range, requestBody }) {
          calls.push('values.update ' + range);
          const p = parseRange(range);
          const t = tabOf(p.tab);
          requestBody.values.forEach((vals, i) => {
            const r = p.r1 - 1 + i;
            while (t.rows.length <= r) t.rows.push([]);
            const row = t.rows[r];
            vals.forEach((v, j) => { row[p.c1 - 1 + j] = v; });
          });
          return { data: {} };
        }
      }
    }
  };
}

module.exports = { createFakeSheets };
