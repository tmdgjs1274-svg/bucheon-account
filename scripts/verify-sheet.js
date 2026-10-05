'use strict';
// 실제 구글시트를 "읽기만" 해서 새 서버가 기존 데이터를 제대로 해석하는지 확인한다. (아무것도 쓰지 않음)
//   사용:  SPREADSHEET_ID=... GOOGLE_SERVICE_ACCOUNT_JSON='{...}' npm run verify-sheet
const { buildStoreFromEnv } = require('../server');
const { joinChunks } = require('../lib/chunks');
const { toIso } = require('../lib/store-sheets');
const { validateLedger } = require('../lib/validate');

(async () => {
  const store = buildStoreFromEnv();
  const { sheets, id } = store;
  const meta = await sheets.spreadsheets.get({ spreadsheetId: id, fields: 'properties.title,sheets.properties(title,sheetId)' });
  let problems = 0;
  const titles = (meta.data.sheets || []).map(s => s.properties.title);
  console.log('탭 목록    :', titles.join(', '));
  for (const t of ['Latest', 'Backups']) {
    if (!titles.includes(t)) { problems++; console.log(`⚠ '${t}' 탭이 없습니다. (서버가 처음 실행될 때 빈 탭을 새로 만듭니다. 기존 시트라면 탭 이름을 확인하세요.)`); }
  }

  const read = async range => (await sheets.spreadsheets.values.get({ spreadsheetId: id, range, valueRenderOption: 'UNFORMATTED_VALUE' })).data.values || [];

  if (titles.includes('Latest')) {
    const row = (await read('Latest!A2:Z2'))[0];
    if (!row || !row[2]) console.log('Latest     : 비어 있음 (최신본 없음)');
    else {
      try {
        const text = joinChunks(row, 2);
        const data = JSON.parse(text);
        const bad = validateLedger(data);
        console.log(`Latest     : 저장 시각 ${toIso(row[1])} · 글자 수 ${text.length} · 게임기록 ${data.rows ? data.rows.length : '?'}건 · 현금기록 ${data.cashRows ? data.cashRows.length : '?'}건 · 플레이어 ${JSON.stringify(data.players)}`);
        if (bad) { problems++; console.log('⚠ 형식 문제:', bad); }
      } catch (e) { problems++; console.log('✖ Latest JSON을 읽을 수 없습니다:', e.message); }
    }
  }
  if (titles.includes('Backups')) {
    const rows = (await read('Backups!A2:Z')).filter(r => r[0] !== '' && r[0] !== undefined);
    let ok = 0;
    for (const r of rows) {
      try { const d = JSON.parse(joinChunks(r, 3)); if (!validateLedger(d)) ok++; else { problems++; console.log(`⚠ 백업 #${r[0]} 형식 문제`); } }
      catch (e) { problems++; console.log(`✖ 백업 #${r[0]} (${r[1]}) JSON 오류`); }
    }
    console.log(`Backups    : ${rows.length}건 중 ${ok}건 정상`);
  }
  console.log(problems ? `\n확인 필요한 항목 ${problems}개` : '\n✓ 이상 없음. 기존 데이터를 그대로 읽을 수 있습니다.');
  process.exit(problems ? 1 : 0);
})().catch(e => { console.error('✖ 실패:', e.message); process.exit(2); });
