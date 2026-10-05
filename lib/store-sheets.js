'use strict';
// 구글시트 저장소. 기존 Apps Script 버전과 "같은 시트 구조"를 그대로 읽고 쓴다.
//
//   Latest  : 1행 헤더(id, updated_at, data_json) / 2행 = 최신본 (A=1, B=저장시각, C~=데이터 JSON)
//   Backups : 1행 헤더(id, name, saved_at, data_json) / 2행~ = 백업 한 건당 한 행
//
// 원칙(데이터가 사라지면 안 된다):
//  - 기존 탭/행을 지우거나 바꾸는 코드는 없다. 최신본은 2행 "덮어쓰기"만, 백업은 "추가/지정 삭제"만 한다.
//  - 최신본을 덮어쓸 때는 한 번의 요청으로 행 전체를 쓴다(지우고 쓰는 2단계 X) → 중간에 실패해도 반쯤 쓰인 상태가 없다.
//  - 읽기에 실패하거나 JSON이 깨져 있으면 에러를 내고 아무것도 쓰지 않는다.
//  - 저장 시 클라이언트가 "내가 마지막으로 본 저장 시각"을 같이 보내고, 시트의 값과 다르면
//    (다른 기기가 먼저 수정) 저장을 거부한다. 강제 덮어쓰기는 덮이는 최신본을 먼저 백업으로 남긴다.
const { splitChunks, joinChunks } = require('./chunks');
const { ConflictError, TooLargeError, DataCorruptError } = require('./errors');

const LATEST = 'Latest';
const BACKUPS = 'Backups';
const LATEST_HEADERS = ['id', 'updated_at', 'data_json'];
const BACKUP_HEADERS = ['id', 'name', 'saved_at', 'data_json'];
const MAX_COL = 'Z'; // A~Z = 26칸 (메타 2~3칸 + 데이터 조각)
const LATEST_META = 2;  // A:id, B:updated_at, C~:data
const BACKUP_META = 3;  // A:id, B:name, C:saved_at, D~:data
const SHEET_COLS = 26;

// Sheets가 돌려주는 날짜 칸: Apps Script가 넣은 Date는 일련번호(숫자)로, 새 서버가 넣은 값은 ISO 문자열로 온다.
function toIso(v) {
  if (v === '' || v === null || v === undefined) return null;
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * 86400000)).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

class SheetsStore {
  // sheets: @googleapis/sheets 의 sheets_v4.Sheets 클라이언트 (테스트에서는 가짜를 주입)
  constructor({ sheets, spreadsheetId }) {
    if (!sheets || !spreadsheetId) throw new Error('SheetsStore: sheets 클라이언트와 spreadsheetId가 필요합니다.');
    this.sheets = sheets;
    this.id = spreadsheetId;
    this.tabIds = null;
    this.chain = Promise.resolve(); // 같은 프로세스 안의 쓰기 직렬화
  }

  _lock(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  async _ensureTabs() {
    if (this.tabIds) return;
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId: this.id, fields: 'sheets.properties(sheetId,title)'
    });
    const ids = {};
    for (const s of meta.data.sheets || []) ids[s.properties.title] = s.properties.sheetId;
    for (const [title, headers] of [[LATEST, LATEST_HEADERS], [BACKUPS, BACKUP_HEADERS]]) {
      if (ids[title] !== undefined) continue; // 이미 있는 탭은 절대 건드리지 않는다
      const res = await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.id, requestBody: { requests: [{ addSheet: { properties: { title } } }] }
      });
      ids[title] = res.data.replies[0].addSheet.properties.sheetId;
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.id, range: `${title}!A1`, valueInputOption: 'RAW', requestBody: { values: [headers] }
      });
    }
    this.tabIds = ids;
  }

  async _get(range) {
    const res = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.id, range, valueRenderOption: 'UNFORMATTED_VALUE'
    });
    return res.data.values || [];
  }

  // ---- 최신본 ----
  async _readLatestRaw() {
    await this._ensureTabs();
    const rows = await this._get(`${LATEST}!A2:${MAX_COL}2`);
    const row = rows[0];
    if (!row || row.length < 3 || row[2] === '' || row[2] === undefined) return { data: null, updatedAt: null };
    const text = joinChunks(row, LATEST_META);
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new DataCorruptError('Latest', e); }
    return { data, updatedAt: toIso(row[1]) };
  }

  async getLatest() {
    const r = await this._readLatestRaw();
    if (!r.updatedAt && !r.data) return { data: { players: [], rows: [], cashRows: [] }, updatedAt: null };
    return r;
  }

  saveLatest(data, { expectedUpdatedAt = null, force = false } = {}) {
    return this._lock(async () => {
      const cur = await this._readLatestRaw();
      if (!force && (cur.updatedAt || null) !== (expectedUpdatedAt || null)) {
        throw new ConflictError(cur.updatedAt);
      }
      if (force && cur.data) {
        // 강제로 덮어쓰기 직전, 지금 시트에 있는 최신본을 백업으로 남긴다.
        await this._addBackupUnlocked(`자동백업 · 덮어쓰기 전 (${cur.updatedAt || '시각 미상'})`, cur.data);
      }
      const chunks = splitChunks(JSON.stringify(data));
      if (chunks.length > SHEET_COLS - LATEST_META) throw new TooLargeError();
      const now = new Date().toISOString();
      const row = [1, now, ...chunks];
      while (row.length < SHEET_COLS) row.push(''); // 이전에 더 길었던 조각 칸을 같은 요청 안에서 비운다
      await this.sheets.spreadsheets.values.update({
        spreadsheetId: this.id, range: `${LATEST}!A2:${MAX_COL}2`, valueInputOption: 'RAW', requestBody: { values: [row] }
      });
      return { updatedAt: now };
    });
  }

  // ---- 백업 ----
  async listBackups() {
    await this._ensureTabs();
    const rows = await this._get(`${BACKUPS}!A2:C`);
    return rows
      .filter(r => r[0] !== '' && r[0] !== undefined)
      .map(r => ({ id: r[0], name: r[1] === undefined ? '' : String(r[1]), savedAt: toIso(r[2]) }));
  }

  async _findBackupRow(id) {
    const col = await this._get(`${BACKUPS}!A:A`);
    for (let i = 1; i < col.length; i++) {
      if (col[i] && String(col[i][0]) === String(id)) return i + 1; // 시트 행 번호(1부터)
    }
    return null;
  }

  async getBackup(id) {
    await this._ensureTabs();
    const rowNo = await this._findBackupRow(id);
    if (!rowNo) return null;
    const rows = await this._get(`${BACKUPS}!A${rowNo}:${MAX_COL}${rowNo}`);
    const row = rows[0] || [];
    let data;
    try { data = JSON.parse(joinChunks(row, BACKUP_META)); } catch (e) { throw new DataCorruptError('Backups', e); }
    return { name: row[1] === undefined ? '' : String(row[1]), savedAt: toIso(row[2]), data };
  }

  async _addBackupUnlocked(name, data) {
    await this._ensureTabs();
    const col = await this._get(`${BACKUPS}!A:A`);
    let maxId = 0;
    for (let i = 1; i < col.length; i++) maxId = Math.max(maxId, Number(col[i] && col[i][0]) || 0);
    const chunks = splitChunks(JSON.stringify(data));
    if (chunks.length > SHEET_COLS - BACKUP_META) throw new TooLargeError();
    const id = maxId + 1;
    const now = new Date().toISOString();
    const rowNo = Math.max(col.length, 1) + 1;
    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.id, range: `${BACKUPS}!A${rowNo}:${MAX_COL}${rowNo}`, valueInputOption: 'RAW',
      requestBody: { values: [[id, String(name), now, ...chunks]] }
    });
    return { id, savedAt: now };
  }

  addBackup(name, data) { return this._lock(() => this._addBackupUnlocked(name, data)); }

  deleteBackup(id) {
    return this._lock(async () => {
      await this._ensureTabs();
      const rowNo = await this._findBackupRow(id);
      if (!rowNo) return false;
      await this.sheets.spreadsheets.batchUpdate({
        spreadsheetId: this.id,
        requestBody: { requests: [{ deleteDimension: { range: { sheetId: this.tabIds[BACKUPS], dimension: 'ROWS', startIndex: rowNo - 1, endIndex: rowNo } } }] }
      });
      return true;
    });
  }
}

module.exports = { SheetsStore, toIso };
