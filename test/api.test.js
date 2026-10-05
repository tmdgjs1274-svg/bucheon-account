'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { createAuth, createLoginLimiter } = require('../lib/auth');
const { SheetsStore } = require('../lib/store-sheets');
const { createFakeSheets } = require('../lib/fake-sheets');

const PW = 'test-pw-123';
const sample = { players: ['가', '나', '다'], rows: [{ id: 1, date: '2026-08-10', note: '', buyin: [1, 1, 1], final: [1, 1, 1] }], cashRows: [] };

async function start(seed, limiter) {
  const fake = createFakeSheets(seed);
  const store = new SheetsStore({ sheets: fake, spreadsheetId: 't' });
  const app = createApp({ store, auth: createAuth({ password: PW }), limiter });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: (body === undefined || method === 'GET' || method === 'HEAD') ? undefined : JSON.stringify(body)
    });
    let json = null; try { json = await res.json(); } catch (e) {}
    return { status: res.status, json, headers: res.headers };
  };
  const login = async () => (await call('POST', '/api/login', { password: PW })).json.token;
  return { fake, call, login, close: () => { server.closeAllConnections(); server.close(); } };
}

test('로그인 없이는 데이터 API가 모두 401', async () => {
  const s = await start();
  for (const [m, p] of [['GET', '/api/latest'], ['PUT', '/api/latest'], ['GET', '/api/backups'], ['POST', '/api/backups'], ['DELETE', '/api/backups/1']]) {
    assert.equal((await s.call(m, p, {})).status, 401, m + ' ' + p);
  }
  assert.equal((await s.call('GET', '/api/latest', undefined, 'garbage.token')).status, 401);
  s.close();
});

test('틀린 비밀번호는 401, 맞으면 토큰 발급', async () => {
  const s = await start();
  assert.equal((await s.call('POST', '/api/login', { password: 'x' })).status, 401);
  assert.equal((await s.call('POST', '/api/login', {})).status, 401);
  const ok = await s.call('POST', '/api/login', { password: PW });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.token);
  assert.ok(!JSON.stringify(ok.json).includes(PW), '응답에 비밀번호가 들어가면 안 됨');
  s.close();
});

test('로그인 실패 10회 후에는 올바른 비밀번호도 429', async () => {
  const s = await start(undefined, createLoginLimiter({ max: 3 }));
  for (let i = 0; i < 3; i++) await s.call('POST', '/api/login', { password: 'bad' });
  assert.equal((await s.call('POST', '/api/login', { password: PW })).status, 429);
  s.close();
});

test('빈 시트: 최신본 읽기는 빈 데이터, 읽기만으로는 데이터를 쓰지 않는다', async () => {
  const s = await start();
  const t = await s.login();
  const r = await s.call('GET', '/api/latest', undefined, t);
  assert.equal(r.status, 200);
  assert.equal(r.json.updatedAt, null);
  assert.deepEqual(r.json.data.rows, []);
  assert.equal(s.fake._tabs.Latest.rows.length, 1); // 헤더 1줄뿐
  s.close();
});

test('저장 → 읽기 왕복, 그리고 낡은 baseUpdatedAt는 409', async () => {
  const s = await start();
  const t = await s.login();
  const put1 = await s.call('PUT', '/api/latest', { data: sample, baseUpdatedAt: null }, t);
  assert.equal(put1.status, 200);
  const get = await s.call('GET', '/api/latest', undefined, t);
  assert.deepEqual(get.json.data, sample);
  assert.equal(get.json.updatedAt, put1.json.updatedAt);
  // 다른 기기가 아직 null 기준으로 저장 시도 → 충돌
  const stale = await s.call('PUT', '/api/latest', { data: { ...sample, players: ['x', 'y', 'z'] }, baseUpdatedAt: null }, t);
  assert.equal(stale.status, 409);
  assert.equal(stale.json.conflict, true);
  assert.deepEqual((await s.call('GET', '/api/latest', undefined, t)).json.data, sample); // 그대로
  s.close();
});

test('force 저장은 이전 최신본을 백업으로 남긴다', async () => {
  const s = await start();
  const t = await s.login();
  await s.call('PUT', '/api/latest', { data: sample, baseUpdatedAt: null }, t);
  const next = { ...sample, players: ['x', 'y', 'z'] };
  assert.equal((await s.call('PUT', '/api/latest', { data: next, force: true }, t)).status, 200);
  const list = (await s.call('GET', '/api/backups', undefined, t)).json.backups;
  assert.equal(list.length, 1);
  const b = await s.call('GET', '/api/backups/' + list[0].id, undefined, t);
  assert.deepEqual(b.json.data, sample);
  s.close();
});

test('잘못된 형식의 데이터는 400이고 시트를 건드리지 않는다', async () => {
  const s = await start();
  const t = await s.login();
  const before = JSON.stringify(s.fake._tabs);
  for (const bad of [null, {}, { players: ['a'], rows: [], cashRows: [] }, { players: ['a', 'b', 'c'], rows: 'x', cashRows: [] }]) {
    assert.equal((await s.call('PUT', '/api/latest', { data: bad, baseUpdatedAt: null }, t)).status, 400);
  }
  assert.equal(JSON.stringify(s.fake._tabs), before);
  s.close();
});

test('백업 추가/조회/삭제와 없는 id는 404', async () => {
  const s = await start();
  const t = await s.login();
  const add = await s.call('POST', '/api/backups', { name: '8월 정산본', data: sample }, t);
  assert.equal(add.status, 200);
  const got = await s.call('GET', '/api/backups/' + add.json.id, undefined, t);
  assert.equal(got.json.name, '8월 정산본');
  assert.equal((await s.call('GET', '/api/backups/999', undefined, t)).status, 404);
  assert.equal((await s.call('DELETE', '/api/backups/' + add.json.id, undefined, t)).status, 200);
  assert.equal((await s.call('DELETE', '/api/backups/' + add.json.id, undefined, t)).status, 404);
  s.close();
});

test('깨진 JSON이 시트에 있으면 500으로 알리고 아무것도 덮어쓰지 않는다', async () => {
  const s = await start({ Latest: [['id', 'updated_at', 'data_json'], [1, '2026-08-01T00:00:00.000Z', '{broken']], Backups: [['id', 'name', 'saved_at', 'data_json']] });
  const t = await s.login();
  assert.equal((await s.call('GET', '/api/latest', undefined, t)).status, 500);
  const put = await s.call('PUT', '/api/latest', { data: sample, baseUpdatedAt: '2026-08-01T00:00:00.000Z' }, t);
  assert.equal(put.status, 500);
  assert.equal(s.fake._tabs.Latest.rows[1][2], '{broken');
  s.close();
});

test('보안 헤더와 /healthz, API 응답은 캐시 금지', async () => {
  const s = await start();
  const t = await s.login();
  const r = await s.call('GET', '/api/latest', undefined, t);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  s.close();
});
