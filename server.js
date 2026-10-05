'use strict';
const path = require('path');
const express = require('express');
const { createAuth, createLoginLimiter } = require('./lib/auth');
const { validateLedger, normalizeLedger } = require('./lib/validate');
const { ConflictError, TooLargeError, DataCorruptError } = require('./lib/errors');

function createApp({ store, auth, limiter = createLoginLimiter() }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Render 같은 프록시 뒤에서 실제 접속자 IP를 쓰기 위해

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'"
    });
    next();
  });

  app.get('/healthz', (req, res) => res.type('text').send('ok'));

  const api = express.Router();
  api.use(express.json({ limit: '2mb' }));
  api.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  api.post('/login', (req, res) => {
    const ip = req.ip;
    if (limiter.blocked(ip)) return res.status(429).json({ ok: false, error: '시도가 너무 많습니다. 잠시 후 다시 시도해주세요.' });
    if (!auth.checkPassword(req.body && req.body.password)) {
      limiter.fail(ip);
      return res.status(401).json({ ok: false, error: '비밀번호가 올바르지 않습니다.' });
    }
    limiter.success(ip);
    res.json({ ok: true, token: auth.issueToken() });
  });

  api.use((req, res, next) => {
    const h = req.get('Authorization') || '';
    if (h.startsWith('Bearer ') && auth.verifyToken(h.slice(7))) return next();
    res.status(401).json({ ok: false, error: '로그인이 필요합니다.', authRequired: true });
  });

  const wrap = fn => (req, res) => fn(req, res).catch(err => handleError(err, res));

  api.get('/latest', wrap(async (req, res) => {
    const r = await store.getLatest();
    res.json({ ok: true, data: r.data, updatedAt: r.updatedAt });
  }));

  api.put('/latest', wrap(async (req, res) => {
    const { data, baseUpdatedAt = null, force = false } = req.body || {};
    const problem = validateLedger(data);
    if (problem) return res.status(400).json({ ok: false, error: problem });
    const r = await store.saveLatest(normalizeLedger(data), { expectedUpdatedAt: baseUpdatedAt, force: force === true });
    res.json({ ok: true, updatedAt: r.updatedAt });
  }));

  api.get('/backups', wrap(async (req, res) => {
    res.json({ ok: true, backups: await store.listBackups() });
  }));

  api.post('/backups', wrap(async (req, res) => {
    const { name, data } = req.body || {};
    const problem = validateLedger(data);
    if (problem) return res.status(400).json({ ok: false, error: problem });
    const cleanName = String(name || '(이름 없음)').slice(0, 100);
    const r = await store.addBackup(cleanName, normalizeLedger(data));
    res.json({ ok: true, id: r.id, savedAt: r.savedAt });
  }));

  api.get('/backups/:id', wrap(async (req, res) => {
    const b = await store.getBackup(req.params.id);
    if (!b) return res.status(404).json({ ok: false, error: '해당 백업을 찾을 수 없습니다.' });
    res.json({ ok: true, name: b.name, savedAt: b.savedAt, data: b.data });
  }));

  api.delete('/backups/:id', wrap(async (req, res) => {
    const ok = await store.deleteBackup(req.params.id);
    if (!ok) return res.status(404).json({ ok: false, error: '해당 백업을 찾을 수 없습니다.' });
    res.json({ ok: true });
  }));

  api.use((req, res) => res.status(404).json({ ok: false, error: '없는 API입니다.' }));
  app.use('/api', api);

  app.use((err, req, res, next) => { // express.json 파싱 에러 등
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: '요청 형식이 올바르지 않습니다.' });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, error: '데이터가 너무 큽니다.' });
    next(err);
  });

  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: res => res.set('Cache-Control', 'no-cache')
  }));
  return app;
}

function handleError(err, res) {
  if (err instanceof ConflictError) {
    return res.status(409).json({ ok: false, conflict: true, error: err.message, updatedAt: err.currentUpdatedAt });
  }
  if (err instanceof TooLargeError) return res.status(413).json({ ok: false, error: err.message });
  if (err instanceof DataCorruptError) {
    console.error('[data-corrupt]', err.message, err.cause && err.cause.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
  const code = err && (err.code || (err.response && err.response.status));
  console.error('[store-error]', code, err && err.message);
  if (code === 429) return res.status(503).json({ ok: false, error: '구글시트 요청이 잠시 몰렸어요. 곧 다시 시도합니다.' });
  res.status(500).json({ ok: false, error: '서버에서 시트에 접근하는 중 오류가 발생했습니다.' });
}

function buildStoreFromEnv(env = process.env) {
  const { SheetsStore } = require('./lib/store-sheets');
  if (env.STORE === 'memory') {
    const { createFakeSheets } = require('./lib/fake-sheets');
    console.warn('⚠ STORE=memory: 구글시트가 아닌 메모리 저장소를 쓰는 개발 모드입니다 (재시작하면 데이터가 사라집니다).');
    return new SheetsStore({ sheets: createFakeSheets(), spreadsheetId: 'memory' });
  }
  if (!env.SPREADSHEET_ID) throw new Error('SPREADSHEET_ID가 설정되지 않았습니다.');
  if (!env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON이 설정되지 않았습니다.');
  const { sheets } = require('@googleapis/sheets');
  const { GoogleAuth } = require('google-auth-library');
  let credentials;
  try { credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON); }
  catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON이 올바른 JSON이 아닙니다.'); }
  const authClient = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return new SheetsStore({ sheets: sheets({ version: 'v4', auth: authClient }), spreadsheetId: env.SPREADSHEET_ID });
}

if (require.main === module) {
  const store = buildStoreFromEnv();
  const auth = createAuth({ password: process.env.APP_PASSWORD, secret: process.env.SESSION_SECRET });
  const port = process.env.PORT || 3000;
  createApp({ store, auth }).listen(port, () => console.log(`카드게임 장부 서버 시작: http://localhost:${port}`));
}

module.exports = { createApp, buildStoreFromEnv };
