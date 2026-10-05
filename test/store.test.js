'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SheetsStore } = require('../lib/store-sheets');
const { createFakeSheets } = require('../lib/fake-sheets');
const { ConflictError } = require('../lib/errors');

const LEDGER = { players: ['a', 'b', 'c'], rows: [{ id: 1, date: '2026-08-10', note: '', buyin: [1, 2, 3], final: [3, 2, 1] }], cashRows: [] };

// Apps Script(기존 버전)가 만들어 둔 시트를 그대로 흉내: updated_at은 날짜 일련번호(숫자), 데이터는 C칸 한 개.
function legacySeed() {
  const serial = 46247.5; // 2026-08-13 12:00 (시트 일련번호)
  return {
    Latest: [['id', 'updated_at', 'data_json'], [1, serial, JSON.stringify(LEDGER)]],
    Backups: [['id', 'name', 'saved_at', 'data_json'], [3, '8월 정산본', serial, JSON.stringify(LEDGER)], [7, '9월', serial, JSON.stringify(LEDGER)]]
  };
}
const mk = seed => { const fake = createFakeSheets(seed); return { fake, store: new SheetsStore({ sheets: fake, spreadsheetId: 'x' }) }; };

test('기존 Apps Script 형식의 최신본/백업을 그대로 읽는다', async () => {
  const { store } = mk(legacySeed());
  const l = await store.getLatest();
  assert.deepEqual(l.data, LEDGER);
  assert.match(l.updatedAt, /^2026-08-1\d/);
  const list = await store.listBackups();
  assert.deepEqual(list.map(b => [b.id, b.name]), [[3, '8월 정산본'], [7, '9월']]);
  const b = await store.getBackup(7);
  assert.equal(b.name, '9월'); assert.deepEqual(b.data, LEDGER);
  assert.equal(await store.getBackup(99), null);
});

test('읽기만 하면 시트를 전혀 쓰지 않는다', async () => {
  const { store, fake } = mk(legacySeed());
  await store.getLatest(); await store.listBackups(); await store.getBackup(3);
  assert.equal(fake._calls.filter(c => c.startsWith('values.update') || c === 'batchUpdate').length, 0);
});

test('빈 시트에서 시작하면 탭과 헤더를 만든다 / 최신본 없음은 updatedAt null', async () => {
  const { store, fake } = mk({});
  const l = await store.getLatest();
  assert.equal(l.updatedAt, null);
  assert.deepEqual(fake._tabs.Latest.rows[0], ['id', 'updated_at', 'data_json']);
  assert.deepEqual(fake._tabs.Backups.rows[0], ['id', 'name', 'saved_at', 'data_json']);
});

test('기존 탭이 있으면 헤더/탭을 새로 만들지 않는다', async () => {
  const { store, fake } = mk(legacySeed());
  await store.getLatest();
  assert.equal(fake._calls.filter(c => c === 'batchUpdate').length, 0);
});

test('저장 → 다시 읽기 / 저장 시각이 바뀐다', async () => {
  const { store } = mk(legacySeed());
  const cur = await store.getLatest();
  const next = { ...LEDGER, rows: [...LEDGER.rows, { id: 2, date: '2026-08-11', note: 'n', buyin: [0, 0, 0], final: [0, 0, 0] }] };
  const r = await store.saveLatest(next, { expectedUpdatedAt: cur.updatedAt });
  const again = await store.getLatest();
  assert.deepEqual(again.data, next);
  assert.equal(again.updatedAt, r.updatedAt);
});

test('다른 기기가 먼저 저장했으면 충돌로 거부하고 시트는 그대로', async () => {
  const { store } = mk(legacySeed());
  const seen = (await store.getLatest()).updatedAt;
  await store.saveLatest({ ...LEDGER, players: ['x', 'y', 'z'] }, { expectedUpdatedAt: seen }); // 다른 기기
  await assert.rejects(
    store.saveLatest({ ...LEDGER, players: ['stale', 'stale', 'stale'] }, { expectedUpdatedAt: seen }),
    ConflictError
  );
  assert.deepEqual((await store.getLatest()).data.players, ['x', 'y', 'z']);
});

test('강제 덮어쓰기는 덮이는 최신본을 먼저 백업으로 남긴다', async () => {
  const { store } = mk(legacySeed());
  const before = await store.listBackups();
  await store.saveLatest({ ...LEDGER, players: ['n', 'e', 'w'] }, { expectedUpdatedAt: 'wrong', force: true });
  const after = await store.listBackups();
  assert.equal(after.length, before.length + 1);
  const auto = after[after.length - 1];
  assert.match(auto.name, /자동백업/);
  assert.deepEqual((await store.getBackup(auto.id)).data, LEDGER);
  assert.deepEqual((await store.getLatest()).data.players, ['n', 'e', 'w']);
});

test('5만 자가 넘는 데이터도 잘리지 않고 저장/복원된다 (줄었다가 늘어도 찌꺼기 없음)', async () => {
  const { store, fake } = mk(legacySeed());
  const bigRows = Array.from({ length: 900 }, (_, i) => ({ id: i + 1, date: '2026-01-01', note: 'x'.repeat(80), buyin: [1, 2, 3], final: [3, 2, 1] }));
  const big = { ...LEDGER, rows: bigRows };
  assert.ok(JSON.stringify(big).length > 100000);
  let upd = (await store.getLatest()).updatedAt;
  upd = (await store.saveLatest(big, { expectedUpdatedAt: upd })).updatedAt;
  assert.deepEqual((await store.getLatest()).data, big);
  for (const cell of fake._tabs.Latest.rows[1]) if (typeof cell === 'string') assert.ok(cell.length <= 50000);
  await store.saveLatest(LEDGER, { expectedUpdatedAt: upd }); // 다시 작게
  assert.deepEqual((await store.getLatest()).data, LEDGER);
  const row = fake._tabs.Latest.rows[1];
  assert.ok(row.slice(3).every(c => c === '' || c === undefined), '남은 조각 칸이 비어 있어야 함');
});

test('백업 추가/삭제: id는 최대값+1, 삭제는 해당 행만', async () => {
  const { store } = mk(legacySeed());
  const a = await store.addBackup('새 백업', LEDGER);
  assert.equal(a.id, 8);
  assert.equal(await store.deleteBackup(3), true);
  assert.equal(await store.deleteBackup(3), false);
  const list = await store.listBackups();
  assert.deepEqual(list.map(b => b.id), [7, 8]);
  assert.deepEqual((await store.getBackup(7)).data, LEDGER);
});

test('이름이 =로 시작해도 수식이 아니라 글자로 저장된다(RAW)', async () => {
  const { store, fake } = mk(legacySeed());
  await store.addBackup('=HYPERLINK("x")', LEDGER);
  assert.ok(fake._calls.some(c => c.startsWith('values.update Backups')));
  assert.equal((await store.listBackups()).pop().name, '=HYPERLINK("x")');
});

test('동시에 여러 번 저장해도 직렬화되어 마지막 값이 남는다', async () => {
  const { store } = mk(legacySeed());
  const base = (await store.getLatest()).updatedAt;
  const results = await Promise.allSettled([
    store.saveLatest({ ...LEDGER, players: ['1', '1', '1'] }, { expectedUpdatedAt: base }),
    store.saveLatest({ ...LEDGER, players: ['2', '2', '2'] }, { expectedUpdatedAt: base })
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason instanceof ConflictError).length, 1);
});

test('깨진 JSON이면 에러를 내고 아무것도 쓰지 않는다', async () => {
  const seed = legacySeed(); seed.Latest[1][2] = '{깨진';
  const { store, fake } = mk(seed);
  await assert.rejects(store.getLatest(), /JSON 형식 오류/);
  await assert.rejects(store.saveLatest(LEDGER, { expectedUpdatedAt: null }), /JSON 형식 오류/);
  assert.equal(fake._calls.filter(c => c.startsWith('values.update')).length, 0);
});
