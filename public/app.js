const SERIES_COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'];
const SERIES_HEX_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a'];

// players[i] doubles as the players 테이블의 name 컬럼; its array index (+1) stands in
// for players.id, since every other record (rows[].buyin/final, cashRows.player)
// references a player by that same index. See 카드게임_장부_DB스키마.md for the
// full table design this in-memory shape is meant to line up with.
let players = ['플레이어1', '플레이어2', '플레이어3'];

// Each entry here is one 게임 기록 row = one game_sessions record (id/date/note) plus
// its 3 session_results rows (final[i] = final_chips for player i+1). buyin[i] is
// currently the pre-summed buy-in TOTAL for player i — the schema's session_buyins
// table would instead keep every individual rebuy as its own row; see the schema
// doc's "지금 HTML 파일의 메모리 구조 ↔ 이 스키마 매핑" section for why that's not
// wired up yet. `id` is a stand-in for the future game_sessions.id primary key.
let nextSessionId = 1;
let rows = [
  { id: nextSessionId++, date: '2026-08-10', note: '예시 데이터 (참고용, 수정/삭제 가능)', buyin: [10000, 10000, 10000], final: [8000, 7000, 15000] }
];

// Each entry here maps 1:1 onto a cash_transactions row: date→txn_date, player→player_id
// (same index convention as players[]), type 'in'/'out'→'deposit'/'withdrawal', amount
// (always a positive magnitude), note. `id` stands in for cash_transactions.id.
let nextCashId = 1;
let cashRows = []; // { id, date, player: 0|1|2, type: 'in'|'out', amount (magnitude >= 0), note }

let summaryMode = 'combined'; // 'chip' | 'combined' — only affects the 최종 합계장표 per-player cards

function todayStr() { return new Date().toISOString().slice(0,10); }
function isValidDateStr(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00').getTime()); }
// 브라우저 로케일에 따라 <input type="date">의 표시 형식에 "2026 . 08 . 12 ." 처럼 공백이
// 들어가는 경우가 있어서, 실제로 보이는 글자는 이 함수로 직접 만든 "2026.08.12" 형태의
// 오버레이 텍스트로 대체하고, 네이티브 입력칸 자체는 달력 아이콘/기능만 쓰도록 투명하게 둔다.
function formatDateDots(iso) { return iso ? iso.replace(/-/g, '.') : ''; }
// 날짜 없이 텍스트로 직접 입력하는 대신, 표의 날짜칸과 똑같이 캘린더로만 고르는 작은
// 팝업(dateModal)으로 새 게임 기록/현금화 기록을 추가할 날짜를 받는다.
let dateModalCallback = null;
function openDatePicker(title, callback) {
  document.getElementById('dateModalTitle').textContent = title;
  const input = document.getElementById('dateModalInput');
  input.value = todayStr();
  dateModalCallback = callback;
  document.getElementById('dateModalBackdrop').style.display = 'block';
  document.getElementById('dateModal').style.display = 'block';
  requestAnimationFrame(() => { try { input.showPicker(); } catch (err) {} });
}
function closeDatePicker() {
  document.getElementById('dateModalBackdrop').style.display = 'none';
  document.getElementById('dateModal').style.display = 'none';
  dateModalCallback = null;
}

let entryForm = { date: todayStr(), note: '', buyin: [[''], [''], ['']], final: ['', '', ''] };
let flashRowIndex = null;
let flashCashIndex = null;
let editingPlayer = null; // 지금 이름을 수정 중인 플레이어 인덱스 (연필 버튼을 눌러야 편집 모드로 들어간다)

function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  const s = Math.abs(n).toLocaleString('ko-KR');
  return (n < 0 ? '-' : '') + s;
}
// 빌린칩/최종칩처럼 "입력칸에 들어가는 금액"을 위한 포맷 — fmt()과 달리 비어있으면 '-' 대신
// 빈 문자열을 돌려줘서 입력칸이 placeholder를 보여줄 수 있게 한다.
function fmtAmt(n) {
  if (n === '' || n === null || n === undefined || isNaN(Number(n))) return '';
  return Number(n).toLocaleString('ko-KR');
}
function weekday(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('ko-KR', { weekday: 'short' });
}
function pl(row, i) {
  const b = row.buyin[i], f = row.final[i];
  if (b === null || b === undefined || f === null || f === undefined || b === '' || f === '') return null;
  return Number(f) - Number(b);
}
function rowValidation(row) {
  const vals = [0, 1, 2].map(i => pl(row, i));
  if (vals.some(v => v === null)) return null;
  return vals.reduce((a, b) => a + b, 0);
}

// Sum a list of buy-in entry strings, ignoring blanks. Returns null if every
// entry is blank (nothing entered yet), so callers can tell "not entered" apart
// from "entered a total of 0".
function buyinTotal(arr) {
  const nums = arr.map(v => (v === '' || v === undefined || v === null ? null : Number(v))).filter(v => v !== null && !isNaN(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0);
}

// Stable sort helpers: date strings are 'YYYY-MM-DD', so lexical order already
// matches chronological order. Ties (same date, or both blank) break by array
// index so freshly-added rows land predictably.
function sortByDateDesc(list) {
  return list.map((item, idx) => ({ item, idx })).sort((a, b) => {
    const da = a.item.date || '', db = b.item.date || '';
    if (da !== db) return da < db ? 1 : -1;
    return b.idx - a.idx;
  });
}
function sortByDateAsc(list) {
  return list.map((item, idx) => ({ item, idx })).sort((a, b) => {
    const da = a.item.date || '', db = b.item.date || '';
    if (da !== db) return da < db ? -1 : 1;
    return a.idx - b.idx;
  });
}

// Re-render while preserving keyboard focus & cursor position on the input the
// user is actively typing in (a full re-render otherwise replaces every input
// element, which would kick focus to <body> after the very first keystroke).
function rerenderKeepFocus(renderFn) {
  const active = document.activeElement;
  let key = null, isText = false, selStart = null, selEnd = null;
  if (active && active.dataset && active.dataset.key) {
    key = active.dataset.key;
    isText = active.tagName === 'INPUT' && active.type === 'text';
    if (isText) { selStart = active.selectionStart; selEnd = active.selectionEnd; }
  }
  renderFn();
  if (key) {
    const el = document.querySelector(`[data-key="${key}"]`);
    if (el) {
      el.focus();
      if (isText && selStart !== null) {
        try { el.setSelectionRange(selStart, selEnd); } catch (e) {}
      }
    }
  }
}

function renderPlayers() {
  const wrap = document.getElementById('playersRow');
  wrap.innerHTML = '';
  players.forEach((name, i) => {
    const chip = document.createElement('div');
    chip.className = 'player-chip';
    chip.innerHTML = `<span class="dot" style="background:${SERIES_COLORS[i]}"></span>`;

    if (editingPlayer === i) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = name;
      input.dataset.key = 'player-' + i;
      // Deliberately do NOT rebuild the players-row itself while typing (that would
      // tear down and recreate this very input, breaking mid-word edits and firing
      // spurious blur events). Only the OTHER places that display the name refresh.
      input.addEventListener('input', e => {
        players[i] = e.target.value;
        refreshPlayerLabels();
      });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.target.blur(); }
      });
      input.addEventListener('blur', e => {
        if (!e.target.value) {
          players[i] = `플레이어${i+1}`;
        }
        editingPlayer = null;
        renderPlayers(); // 수정 모드 종료 -> 다시 일반 텍스트로 표시
        refreshPlayerLabels();
      });
      chip.appendChild(input);
      wrap.appendChild(chip);
      requestAnimationFrame(() => { input.focus(); input.select(); });
    } else {
      const label = document.createElement('span');
      label.className = 'player-name';
      label.textContent = name;
      chip.appendChild(label);

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'player-edit-btn';
      editBtn.title = '이름 수정';
      editBtn.textContent = '✏️';
      editBtn.addEventListener('click', () => {
        editingPlayer = i;
        renderPlayers();
      });
      chip.appendChild(editBtn);
      wrap.appendChild(chip);
    }
  });
}

// Merge game records and cash transactions into one date-sorted (newest-first)
// timeline, so cash withdrawals/settlements show up inline in 게임 기록 too.
function combinedTimeline() {
  const gameEntries = rows.map((row, idx) => ({ kind: 'game', date: row.date, row, idx }));
  const cashEntries = cashRows.map((c, idx) => ({ kind: 'cash', date: c.date, c, idx }));
  return [...gameEntries, ...cashEntries].sort((a, b) => {
    const da = a.date || '', db = b.date || '';
    if (da !== db) return da < db ? 1 : -1; // newest first
    if (a.kind !== b.kind) return a.kind === 'game' ? -1 : 1; // game row above a same-day cash marker
    return b.idx - a.idx;
  });
}

// 게임 기록: 세션(날짜) 하나를 플레이어 3줄로 세로로 쌓아서 그린다 — 옆으로 9개 숫자 열이
//늘어서던 이전 구조 대신, 한 줄에는 한 플레이어의 빌린칩/최종칩/손익만 있어서 좁은 화면에서도
// 각 칸이 훨씬 넓다. 날짜/요일/검증/메모/삭제는 세션당 한 번만 rowspan=3으로 그린다.
function renderDaily() {
  // 지금 포커스 중인 입력칸의 key를 DOM을 지우기 전에 미리 알아둔다 — 빌린칩/최종칩은
  // "수정 중"에는 쉼표 없이 숫자 그대로, 수정이 끝난 상태(포커스 없음)에는 쉼표 포맷으로
  // 보여줘야 하는데, 그 판단을 여기서 한다.
  const focusedKey = (document.activeElement && document.activeElement.dataset) ? document.activeElement.dataset.key : null;
  const body = document.getElementById('dailyBody');
  body.innerHTML = '';
  const flashEls = [];
  combinedTimeline().forEach(entry => {
    if (entry.kind === 'cash') {
      const { c, idx } = entry;
      const tr = document.createElement('tr');
      tr.classList.add('cash-marker');
      if (idx === flashCashIndex) { tr.classList.add('flash'); flashEls.push(tr); }
      const signed = signedCashAmount(c);
      const playerName = players[c.player] ?? '플레이어';
      const typeLabel = c.type === 'out' ? '출금' : '입금';

      const tdDate = document.createElement('td');
      tdDate.className = 'col-date';
      tdDate.textContent = c.date || '-';
      tr.appendChild(tdDate);

      const tdWd = document.createElement('td');
      tdWd.className = 'col-weekday';
      tdWd.textContent = weekday(c.date);
      tr.appendChild(tdWd);

      const tdInfo = document.createElement('td');
      tdInfo.className = 'cash-marker-info';
      tdInfo.colSpan = 6; // 플레이어/빌린칩/최종칩/손익/검증/메모
      tdInfo.innerHTML = `💰 현금화 · <b>${playerName}</b> · ${typeLabel} · <span class="${signed===null?'':(signed>0?'pl-pos':signed<0?'pl-neg':'pl-zero')}">${signed===null?'-':fmt(signed)}</span>` +
        (c.note ? ` · ${c.note}` : '');
      tr.appendChild(tdInfo);

      const tdDel = document.createElement('td');
      tdDel.className = 'col-del';
      const delBtn = document.createElement('button');
      delBtn.className = 'row-del';
      delBtn.textContent = '✕';
      delBtn.title = '현금화 기록 삭제';
      delBtn.addEventListener('click', () => {
        if (!confirm(`${c.date || '날짜 없음'} 현금화 기록을 삭제할까요? 되돌릴 수 없어요.`)) return;
        cashRows.splice(idx, 1);
        renderAll();
      });
      tdDel.appendChild(delBtn);
      tr.appendChild(tdDel);

      body.appendChild(tr);
      return;
    }

    const { row, idx } = entry;
    const isExample = row.note && row.note.includes('예시');
    const vr = rowValidation(row);

    for (let i = 0; i < 3; i++) {
      const tr = document.createElement('tr');
      tr.classList.add('prow-' + i);
      if (i === 0) tr.classList.add('session-start');
      if (isExample) tr.classList.add('example');
      if (idx === flashRowIndex) { tr.classList.add('flash'); flashEls.push(tr); }

      if (i === 0) {
        const tdDate = document.createElement('td');
        tdDate.className = 'col-date date-display-cell';
        tdDate.rowSpan = 3;
        const dateInput = document.createElement('input');
        dateInput.type = 'date';
        dateInput.className = 'date-calendar-only';
        dateInput.value = row.date || '';
        dateInput.dataset.key = 'row-' + idx + '-date';
        const dateLabel = document.createElement('span');
        dateLabel.className = 'date-display-label';
        dateLabel.textContent = formatDateDots(row.date);
        dateInput.addEventListener('input', e => {
          row.date = e.target.value;
          dateLabel.textContent = formatDateDots(row.date);
          rerenderKeepFocus(renderAll);
        });
        // 직접 타이핑으로 수정할 필요는 없으니, 키보드 입력은 막고(Tab만 허용) 캘린더 컨트롤로만
        // 바꾸도록 한다. 클릭하면 (지원하는 브라우저에서는) 곧바로 달력이 열린다.
        dateInput.addEventListener('keydown', e => { if (e.key !== 'Tab') e.preventDefault(); });
        dateInput.addEventListener('click', () => { if (typeof dateInput.showPicker === 'function') { try { dateInput.showPicker(); } catch (err) {} } });
        tdDate.appendChild(dateInput);
        tdDate.appendChild(dateLabel);
        tr.appendChild(tdDate);

        const tdWd = document.createElement('td');
        tdWd.className = 'col-weekday';
        tdWd.rowSpan = 3;
        tdWd.textContent = weekday(row.date);
        tr.appendChild(tdWd);
      }

      const tdPlayer = document.createElement('td');
      tdPlayer.className = 'col-player';
      tdPlayer.innerHTML = `<span class="dot" style="background:${SERIES_COLORS[i]}"></span>${players[i]}`;
      tr.appendChild(tdPlayer);

      const tdBuy = document.createElement('td');
      tdBuy.className = 'col-buy';
      const buyInput = document.createElement('input');
      buyInput.type = 'text';
      buyInput.inputMode = 'numeric';
      buyInput.placeholder = '빌린칩';
      const buyKey = 'row-' + idx + '-buy-' + i;
      buyInput.value = (buyKey === focusedKey) ? (row.buyin[i] ?? '') : fmtAmt(row.buyin[i]);
      buyInput.dataset.key = buyKey;
      // 쉼표 포맷(예: 10,000)은 수정이 끝난(포커스를 벗어난) 상태에서만 보여주고,
      // 수정 중에는 숫자만 그대로 입력하도록 한다.
      buyInput.addEventListener('focus', e => { e.target.value = row.buyin[i] ?? ''; });
      buyInput.addEventListener('input', e => {
        const digits = e.target.value.replace(/[^0-9]/g, '');
        if (e.target.value !== digits) e.target.value = digits;
        row.buyin[i] = digits === '' ? '' : Number(digits);
        rerenderKeepFocus(renderAll);
      });
      buyInput.addEventListener('blur', e => { e.target.value = fmtAmt(row.buyin[i]); });
      tdBuy.appendChild(buyInput);
      tr.appendChild(tdBuy);

      const tdFin = document.createElement('td');
      tdFin.className = 'col-final';
      const finInput = document.createElement('input');
      finInput.type = 'text';
      finInput.inputMode = 'numeric';
      finInput.placeholder = '최종칩';
      const finKey = 'row-' + idx + '-final-' + i;
      finInput.value = (finKey === focusedKey) ? (row.final[i] ?? '') : fmtAmt(row.final[i]);
      finInput.dataset.key = finKey;
      finInput.addEventListener('focus', e => { e.target.value = row.final[i] ?? ''; });
      finInput.addEventListener('input', e => {
        const digits = e.target.value.replace(/[^0-9]/g, '');
        if (e.target.value !== digits) e.target.value = digits;
        row.final[i] = digits === '' ? '' : Number(digits);
        rerenderKeepFocus(renderAll);
      });
      finInput.addEventListener('blur', e => { e.target.value = fmtAmt(row.final[i]); });
      tdFin.appendChild(finInput);
      tr.appendChild(tdFin);

      const tdPl = document.createElement('td');
      const v = pl(row, i);
      tdPl.textContent = v === null ? '-' : fmt(v);
      tdPl.className = 'col-pl ' + (v === null ? '' : (v > 0 ? 'pl-pos' : v < 0 ? 'pl-neg' : 'pl-zero'));
      tr.appendChild(tdPl);

      if (i === 0) {
        const tdValid = document.createElement('td');
        tdValid.rowSpan = 3;
        if (vr === null) { tdValid.textContent = '-'; tdValid.className = 'col-verify'; }
        else if (vr === 0) { tdValid.textContent = '✓ 정상'; tdValid.className = 'col-verify valid-ok'; }
        else { tdValid.textContent = `⚠ 오차 ${fmt(vr)}`; tdValid.className = 'col-verify valid-bad'; }
        tr.appendChild(tdValid);

        const tdNote = document.createElement('td');
        tdNote.className = 'col-note';
        tdNote.rowSpan = 3;
        const noteInput = document.createElement('input');
        noteInput.type = 'text';
        noteInput.value = row.note || '';
        noteInput.dataset.key = 'row-' + idx + '-note';
        noteInput.addEventListener('input', e => { row.note = e.target.value; scheduleAutoSync(); });
        tdNote.appendChild(noteInput);
        tr.appendChild(tdNote);

        const tdDel = document.createElement('td');
        tdDel.className = 'col-del';
        tdDel.rowSpan = 3;
        const delBtn = document.createElement('button');
        delBtn.className = 'row-del';
        delBtn.textContent = '✕';
        delBtn.title = '행 삭제';
        delBtn.addEventListener('click', () => {
          if (!confirm(`${row.date || '날짜 없음'} 게임 기록을 삭제할까요? 되돌릴 수 없어요.`)) return;
          rows.splice(idx, 1);
          renderAll();
        });
        tdDel.appendChild(delBtn);
        tr.appendChild(tdDel);
      }

      body.appendChild(tr);
    }
  });
  // NB: flashRowIndex/flashCashIndex are read by renderDailyCards() too (it mirrors this
  // table as a mobile card view), so render it BEFORE clearing them here.
  renderDailyCards();
  flashRowIndex = null;
}

// 좁은 화면(모바일)용 카드 뷰 — renderDaily()의 표와 완전히 같은 데이터를 보여주지만
// 가로로 늘어선 칼럼 대신 세션마다 카드 1개, 그 안에 플레이어 3줄을 세로로 쌓는다.
// 데스크톱 표와 이 카드 뷰는 CSS 미디어쿼리로 둘 중 하나만 보이게 전환되는데, 두 뷰가
// 동시에 DOM에 존재하기 때문에 data-key를 그대로 공유하면 rerenderKeepFocus()가
// (보이지 않는 쪽 표의) 엉뚱한 입력칸으로 포커스를 되돌려버린다 — 그래서 이 뷰의 모든
// data-key 앞에 "m-"를 붙여 표와 완전히 구분한다.
function renderDailyCards() {
  const focusedKey = (document.activeElement && document.activeElement.dataset) ? document.activeElement.dataset.key : null;
  const wrap = document.getElementById('dailyCards');
  wrap.innerHTML = '';

  combinedTimeline().forEach(entry => {
    if (entry.kind === 'cash') {
      const { c, idx } = entry;
      const card = document.createElement('div');
      card.className = 'daily-card cash-marker-card';
      if (idx === flashCashIndex) card.classList.add('flash');
      const signed = signedCashAmount(c);
      const playerName = players[c.player] ?? '플레이어';
      const typeLabel = c.type === 'out' ? '출금' : '입금';

      const head = document.createElement('div');
      head.className = 'daily-card-head';
      const dateSpan = document.createElement('span');
      dateSpan.textContent = `${c.date || '날짜 없음'} · ${weekday(c.date)}`;
      head.appendChild(dateSpan);
      const delBtn = document.createElement('button');
      delBtn.className = 'row-del'; delBtn.textContent = '✕'; delBtn.title = '현금화 기록 삭제';
      delBtn.addEventListener('click', () => {
        if (!confirm(`${c.date || '날짜 없음'} 현금화 기록을 삭제할까요? 되돌릴 수 없어요.`)) return;
        cashRows.splice(idx, 1);
        renderAll();
      });
      head.appendChild(delBtn);
      card.appendChild(head);

      const body = document.createElement('div');
      body.className = 'daily-card-cash-body';
      body.innerHTML = `💰 현금화 · <b>${playerName}</b> · ${typeLabel} · <span class="${signed===null?'':(signed>0?'pl-pos':signed<0?'pl-neg':'pl-zero')}">${signed===null?'-':fmt(signed)}</span>` +
        (c.note ? ` · ${c.note}` : '');
      card.appendChild(body);

      wrap.appendChild(card);
      return;
    }

    const { row, idx } = entry;
    const isExample = row.note && row.note.includes('예시');
    const vr = rowValidation(row);

    const card = document.createElement('div');
    card.className = 'daily-card';
    if (isExample) card.classList.add('example');
    if (idx === flashRowIndex) card.classList.add('flash');

    const head = document.createElement('div');
    head.className = 'daily-card-head';
    const dateWrap = document.createElement('div');
    dateWrap.className = 'daily-card-date';
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'date-calendar-only';
    dateInput.value = row.date || '';
    dateInput.dataset.key = 'm-row-' + idx + '-date';
    const dateLabel = document.createElement('span');
    dateLabel.className = 'date-display-label';
    dateLabel.textContent = formatDateDots(row.date);
    dateInput.addEventListener('input', e => {
      row.date = e.target.value;
      dateLabel.textContent = formatDateDots(row.date);
      rerenderKeepFocus(renderAll);
    });
    dateInput.addEventListener('keydown', e => { if (e.key !== 'Tab') e.preventDefault(); });
    dateInput.addEventListener('click', () => { if (typeof dateInput.showPicker === 'function') { try { dateInput.showPicker(); } catch (err) {} } });
    dateWrap.appendChild(dateInput);
    dateWrap.appendChild(dateLabel);
    const wdSpan = document.createElement('span');
    wdSpan.className = 'daily-card-weekday';
    wdSpan.textContent = weekday(row.date);
    dateWrap.appendChild(wdSpan);
    head.appendChild(dateWrap);

    const delBtn = document.createElement('button');
    delBtn.className = 'row-del'; delBtn.textContent = '✕'; delBtn.title = '행 삭제';
    delBtn.addEventListener('click', () => {
      if (!confirm(`${row.date || '날짜 없음'} 게임 기록을 삭제할까요? 되돌릴 수 없어요.`)) return;
      rows.splice(idx, 1);
      renderAll();
    });
    head.appendChild(delBtn);
    card.appendChild(head);

    for (let i = 0; i < 3; i++) {
      const prow = document.createElement('div');
      prow.className = 'daily-card-player prow-' + i;

      const nameDiv = document.createElement('div');
      nameDiv.className = 'daily-card-player-name';
      nameDiv.innerHTML = `<span class="dot" style="background:${SERIES_COLORS[i]}"></span>${players[i]}`;
      prow.appendChild(nameDiv);

      const buyField = document.createElement('div');
      buyField.className = 'daily-card-field';
      const buyLabel = document.createElement('span'); buyLabel.textContent = '빌린칩';
      const buyInput = document.createElement('input');
      buyInput.type = 'text'; buyInput.inputMode = 'numeric'; buyInput.placeholder = '빌린칩';
      const buyKey = 'm-row-' + idx + '-buy-' + i;
      buyInput.value = (buyKey === focusedKey) ? (row.buyin[i] ?? '') : fmtAmt(row.buyin[i]);
      buyInput.dataset.key = buyKey;
      buyInput.addEventListener('focus', e => { e.target.value = row.buyin[i] ?? ''; });
      buyInput.addEventListener('input', e => {
        const digits = e.target.value.replace(/[^0-9]/g, '');
        if (e.target.value !== digits) e.target.value = digits;
        row.buyin[i] = digits === '' ? '' : Number(digits);
        rerenderKeepFocus(renderAll);
      });
      buyInput.addEventListener('blur', e => { e.target.value = fmtAmt(row.buyin[i]); });
      buyField.appendChild(buyLabel); buyField.appendChild(buyInput);
      prow.appendChild(buyField);

      const finField = document.createElement('div');
      finField.className = 'daily-card-field';
      const finLabel = document.createElement('span'); finLabel.textContent = '최종칩';
      const finInput = document.createElement('input');
      finInput.type = 'text'; finInput.inputMode = 'numeric'; finInput.placeholder = '최종칩';
      const finKey = 'm-row-' + idx + '-final-' + i;
      finInput.value = (finKey === focusedKey) ? (row.final[i] ?? '') : fmtAmt(row.final[i]);
      finInput.dataset.key = finKey;
      finInput.addEventListener('focus', e => { e.target.value = row.final[i] ?? ''; });
      finInput.addEventListener('input', e => {
        const digits = e.target.value.replace(/[^0-9]/g, '');
        if (e.target.value !== digits) e.target.value = digits;
        row.final[i] = digits === '' ? '' : Number(digits);
        rerenderKeepFocus(renderAll);
      });
      finInput.addEventListener('blur', e => { e.target.value = fmtAmt(row.final[i]); });
      finField.appendChild(finLabel); finField.appendChild(finInput);
      prow.appendChild(finField);

      const plDiv = document.createElement('div');
      const v = pl(row, i);
      plDiv.textContent = v === null ? '-' : fmt(v);
      plDiv.className = 'daily-card-pl ' + (v === null ? '' : (v > 0 ? 'pl-pos' : v < 0 ? 'pl-neg' : 'pl-zero'));
      prow.appendChild(plDiv);

      card.appendChild(prow);
    }

    const foot = document.createElement('div');
    foot.className = 'daily-card-foot';
    const verifySpan = document.createElement('span');
    if (vr === null) { verifySpan.textContent = '-'; verifySpan.className = 'col-verify'; }
    else if (vr === 0) { verifySpan.textContent = '✓ 정상'; verifySpan.className = 'col-verify valid-ok'; }
    else { verifySpan.textContent = `⚠ 오차 ${fmt(vr)}`; verifySpan.className = 'col-verify valid-bad'; }
    foot.appendChild(verifySpan);
    const noteInput = document.createElement('input');
    noteInput.type = 'text'; noteInput.className = 'note'; noteInput.placeholder = '메모';
    noteInput.value = row.note || '';
    noteInput.dataset.key = 'm-row-' + idx + '-note';
    noteInput.addEventListener('input', e => { row.note = e.target.value; scheduleAutoSync(); });
    foot.appendChild(noteInput);
    card.appendChild(foot);

    wrap.appendChild(card);
  });
}

function cumulativeSeries() {
  const dates = [];
  const series = [[], [], []];
  const running = [0, 0, 0];
  // Chronological order drives the running total, regardless of the order rows
  // were typed in or how the table is currently displayed.
  sortByDateAsc(rows).forEach(({ item: row }) => {
    const vals = [0,1,2].map(i => pl(row, i));
    if (vals.some(v => v === null) || !row.date) return; // skip incomplete rows in the cumulative view
    dates.push(row.date);
    for (let i = 0; i < 3; i++) { running[i] += vals[i]; series[i].push(running[i]); }
  });
  return { dates, series };
}

// 현금 정산 포함 모드용: 게임 세션 날짜를 하나씩 지나갈 때마다, 그 시점까지 발생한 현금 기록을
// (카드에 쓰는 것과 동일한 반대 부호로 — 출금은 더하고 입금은 뺀다) 칩 누적치에 얹어서
// 차트·누적표도 상단 카드와 같은 총액으로 끝나도록 만든다.
function combinedAdjustedSeries(dates, chipSeries) {
  const cashSorted = sortByDateAsc(
    cashRows.filter(c => c.date && c.player != null && signedCashAmount(c) !== null)
  ).map(({ item }) => item);
  const cashRunning = [0, 0, 0];
  let ptr = 0;
  const out = [[], [], []];
  dates.forEach((d, di) => {
    while (ptr < cashSorted.length && cashSorted[ptr].date <= d) {
      const c = cashSorted[ptr];
      cashRunning[c.player] += -signedCashAmount(c);
      ptr++;
    }
    for (let i = 0; i < 3; i++) out[i].push(chipSeries[i][di] + cashRunning[i]);
  });
  // 마지막 게임 세션보다 나중 날짜의 현금 기록이 남아있다면, 그 시점까지 다 반영해서
  // 마지막 지점(=상단 카드의 총액)과 항상 맞아떨어지게 한다.
  if (ptr < cashSorted.length && dates.length) {
    for (; ptr < cashSorted.length; ptr++) {
      const c = cashSorted[ptr];
      cashRunning[c.player] += -signedCashAmount(c);
    }
    for (let i = 0; i < 3; i++) out[i][out[i].length - 1] = chipSeries[i][chipSeries[i].length - 1] + cashRunning[i];
  }
  return out;
}

function renderSummary() {
  const { dates, series } = cumulativeSeries();
  const chipTotals = [0,1,2].map(i => series[i].length ? series[i][series[i].length-1] : 0);
  const chipSumAll = chipTotals.reduce((a,b)=>a+b,0); // always chip-only: this is the real data-integrity check
  const cash = cashTotals();
  const combined = summaryMode === 'combined';
  // 현금 정산 포함 모드: 이미 현금으로 오간 만큼은 칩 기준 손익에서 "빼서 현금으로 바꿔주는" 것이므로
  // 부호를 더하지 않고 뺀다 — 입금(순수취, cash[i]>0)만큼 빼고, 출금(순지급, cash[i]<0)만큼 더한다.
  const displayTotals = combined ? chipTotals.map((t,i) => t - cash[i]) : chipTotals;

  const cards = document.getElementById('summaryCards');
  cards.innerHTML = '';
  displayTotals.forEach((t, i) => {
    const tile = document.createElement('div');
    tile.className = 'stat-tile ' + (t > 0 ? 'status-good' : t < 0 ? 'status-critical' : '');
    tile.innerHTML = `
      <div class="label"><span class="dot" style="background:${SERIES_COLORS[i]}"></span>${players[i]} 총 손익</div>
      <div class="value">${fmt(t)}</div>
      <div class="sub">${t > 0 ? '누적 승' : t < 0 ? '누적 패' : '무변동'}${combined ? ' · 현금 정산 포함' : ''}</div>`;
    cards.appendChild(tile);
  });

  // "전체 검증" is a chip-only data-integrity check, not a per-player 손익 stat, so it
  // gets its own pill banner rather than living inside the .stat-tile grid — and it
  // only makes sense in 칩 기준 모드 (현금 정산 포함 모드는 칩+현금 혼합값이라 0-합 검증이 무의미).
  const validBox = document.getElementById('chipValidation');
  validBox.classList.toggle('show', !combined);
  validBox.classList.toggle('status-good', chipSumAll === 0);
  validBox.classList.toggle('status-critical', chipSumAll !== 0);
  validBox.innerHTML = `
    <span class="cv-icon">${chipSumAll === 0 ? '✓' : '⚠'}</span>
    <span>전체 검증 (칩 기준 합계) — ${fmt(chipSumAll)}</span>
    <span class="cv-sub">${chipSumAll === 0 ? '정상 (0)' : '오차 발생 · 입력 확인 필요'}</span>`;

  // 차트·누적표도 지금 선택된 탭(칩 기준 / 현금 정산 포함)을 따라간다 — 상단 카드 총액과
  // 항상 같은 숫자로 끝나야 하므로, combined면 현금까지 반영한 누적치를 만들어서 넘긴다.
  const displaySeries = combined ? combinedAdjustedSeries(dates, series) : series;

  renderLegend();
  renderChart(dates, displaySeries); // chart stays chronological (oldest -> newest, left to right)
  // 표에 보이는 값은 선택된 모드를 따르지만, "검증" 칸은 항상 칩 기준 0-합 체크를 유지한다
  // (현금까지 섞인 값으로는 0-합이 될 이유가 없어서, 검증 의미 자체가 달라지면 안 된다).
  renderCumTable(
    dates.slice().reverse(),
    displaySeries.map(s => s.slice().reverse()),
    series.map(s => s.slice().reverse())
  );
}

function renderLegend() {
  const legend = document.getElementById('legend');
  legend.innerHTML = '';
  players.forEach((name, i) => {
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<span class="dot" style="background:${SERIES_COLORS[i]}"></span>${name}`;
    legend.appendChild(item);
  });
}

function renderChart(dates, series) {
  const svg = document.getElementById('chart');
  svg.innerHTML = '';
  // viewBox를 실제 렌더링 너비(px)로 그대로 맞춘다 — CSS가 SVG를 줄이는 게 아니라 SVG 자체의
  // 좌표계가 실제 픽셀과 1:1이 되므로, 화면이 좁아져도 배율이 안 달라져서 글자가 찌그러지지
  // 않고, 표처럼 최소 너비를 둘 필요도 없어 가로 스크롤 없이 자연스럽게 좁아진다.
  const measuredW = svg.parentElement ? svg.parentElement.getBoundingClientRect().width : 0;
  const W = Math.max(280, Math.round(measuredW || 600)), H = 300, padL = 56, padR = 70, padT = 20, padB = 28;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const plotW = W - padL - padR, plotH = H - padT - padB;

  if (dates.length === 0) {
    const t = document.createElementNS('http://www.w3.org/2000/svg','text');
    t.setAttribute('x', W/2); t.setAttribute('y', H/2);
    t.setAttribute('text-anchor','middle'); t.setAttribute('class','axis-label');
    t.textContent = '일일 기록 탭에서 게임 결과를 반영하면 여기에 누적 손익 추이가 표시됩니다.';
    svg.appendChild(t);
    return;
  }

  const allVals = series.flat().concat([0]);
  let minV = Math.min(...allVals), maxV = Math.max(...allVals);
  if (minV === maxV) { minV -= 1000; maxV += 1000; }
  const rangePad = (maxV - minV) * 0.15;
  minV -= rangePad; maxV += rangePad;

  const x = i => dates.length === 1 ? padL + plotW/2 : padL + (i/(dates.length-1)) * plotW;
  const y = v => padT + plotH - ((v - minV)/(maxV - minV)) * plotH;

  const ns = 'http://www.w3.org/2000/svg';
  function el(tag, attrs) {
    const e = document.createElementNS(ns, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  const steps = 4;
  for (let s = 0; s <= steps; s++) {
    const v = minV + (maxV-minV)*s/steps;
    const gy = y(v);
    svg.appendChild(el('line', { x1: padL, x2: W-padR, y1: gy, y2: gy, class: 'gridline' }));
    const lbl = el('text', { x: padL-8, y: gy+4, class: 'axis-label', 'text-anchor':'end' });
    lbl.textContent = fmt(Math.round(v));
    svg.appendChild(lbl);
  }
  if (minV < 0 && maxV > 0) {
    svg.appendChild(el('line', { x1: padL, x2: W-padR, y1: y(0), y2: y(0), class: 'baseline' }));
  }
  const idxToLabel = dates.length <= 6 ? dates.map((_,i)=>i) : [0, Math.floor((dates.length-1)/2), dates.length-1];
  idxToLabel.forEach(i => {
    const lbl = el('text', { x: x(i), y: H-6, class: 'axis-label', 'text-anchor':'middle' });
    lbl.textContent = dates[i];
    svg.appendChild(lbl);
  });

  const pointGroups = [];
  const ends = [];
  for (let s = 0; s < 3; s++) {
    const pts = series[s].map((v,i) => [x(i), y(v)]);
    const path = el('path', {
      d: pts.map((p,i)=> (i===0?'M':'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' '),
      class: 'series-line', stroke: SERIES_HEX_LIGHT[s]
    });
    svg.appendChild(path);
    pts.forEach((p,i) => {
      const dot = el('circle', { cx:p[0], cy:p[1], class:'series-dot', fill: SERIES_HEX_LIGHT[s], 'data-s':s, 'data-i':i });
      svg.appendChild(dot);
    });
    const last = pts[pts.length-1];
    svg.appendChild(el('circle', { cx:last[0], cy:last[1], class:'end-dot', fill: SERIES_HEX_LIGHT[s] }));
    ends.push({ s, x: last[0], trueY: last[1], text: players[s] + ' ' + fmt(series[s][series[s].length-1]) });
    pointGroups.push(pts);
  }

  const MIN_GAP = 15;
  ends.sort((a, b) => a.trueY - b.trueY);
  ends[0].labelY = ends[0].trueY;
  for (let i = 1; i < ends.length; i++) {
    ends[i].labelY = Math.max(ends[i].trueY, ends[i-1].labelY + MIN_GAP);
  }
  ends.forEach(e => {
    if (Math.abs(e.labelY - e.trueY) > 2) {
      svg.appendChild(el('line', { x1: e.x+5, x2: e.x+8, y1: e.trueY, y2: e.labelY, stroke: 'var(--text-muted)', 'stroke-width': 1 }));
    }
    const endLbl = el('text', { x: e.x+8, y: e.labelY+4, class: 'end-label' });
    endLbl.textContent = e.text;
    svg.appendChild(endLbl);
  });

  const crosshair = el('line', { x1:0, x2:0, y1: padT, y2: padT+plotH, class:'crosshair' });
  svg.appendChild(crosshair);
  const hoverDots = [0,1,2].map(s => {
    const d = el('circle', { r:5.5, class:'hover-dot', fill:'none', stroke: SERIES_HEX_LIGHT[s], 'stroke-width':2 });
    svg.appendChild(d);
    return d;
  });

  const overlay = el('rect', { x: padL, y: padT, width: plotW, height: plotH, fill:'transparent' });
  svg.appendChild(overlay);
  const tooltip = document.getElementById('tooltip');
  overlay.addEventListener('mousemove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const scaleX = W / rect.width;
    const mx = (evt.clientX - rect.left) * scaleX;
    let idx = Math.round(((mx - padL) / plotW) * (dates.length-1));
    idx = Math.max(0, Math.min(dates.length-1, idx));
    const cx = x(idx);
    crosshair.setAttribute('x1', cx); crosshair.setAttribute('x2', cx);
    crosshair.style.opacity = 1;
    hoverDots.forEach((d,s) => {
      d.setAttribute('cx', cx); d.setAttribute('cy', y(series[s][idx]));
      d.style.opacity = 1;
    });
    tooltip.innerHTML = `<div class="t-date">${dates[idx]}</div>` +
      [0,1,2].map(s => `<div class="t-row"><span class="t-dot" style="background:${SERIES_HEX_LIGHT[s]}"></span>${players[s]}: <b>${fmt(series[s][idx])}</b></div>`).join('');
    const wrapRect = overlay.ownerSVGElement.parentElement.getBoundingClientRect();
    const px = (cx/W) * wrapRect.width;
    tooltip.style.left = Math.min(px+16, wrapRect.width-160) + 'px';
    tooltip.style.top = '10px';
    tooltip.style.opacity = 1;
  });
  overlay.addEventListener('mouseleave', () => {
    crosshair.style.opacity = 0;
    hoverDots.forEach(d => d.style.opacity = 0);
    tooltip.style.opacity = 0;
  });
}

function renderCumTable(dates, series, validSeries) {
  const head = document.getElementById('cumHead');
  head.innerHTML = '<th>날짜</th>' + players.map((p,i)=>`<th><span class="dot" style="background:${SERIES_COLORS[i]};display:inline-block;margin-right:4px;"></span>${p} 누적</th>`).join('') + '<th>검증<br>(칩 기준)</th>';
  const body = document.getElementById('cumBody');
  if (dates.length === 0) {
    body.innerHTML = '<tr><td colspan="5" style="color:var(--text-muted);padding:14px;">데이터 없음</td></tr>';
    return;
  }
  // vs: 표에 보이는 값(칩 기준 또는 현금 정산 포함)과 별개로, "검증"은 항상 칩만의 0-합 체크를 쓴다.
  const vs = validSeries || series;
  body.innerHTML = dates.map((d,i) => {
    const vals = [0,1,2].map(s => series[s][i]);
    const sum = [0,1,2].map(s => vs[s][i]).reduce((a,b)=>a+b,0);
    return `<tr><td>${d}</td>${vals.map(v=>`<td class="${v>0?'pl-pos':v<0?'pl-neg':'pl-zero'}">${fmt(v)}</td>`).join('')}<td class="${sum===0?'valid-ok':'valid-bad'}">${sum===0?'✓ 정상':'⚠ '+fmt(sum)}</td></tr>`;
  }).join('');
}

// ---- 현금 계좌: a fully separate ledger for actual cash paid/received. It never
// feeds into 최종 합계장표's chip math on its own — that only happens if the user
// opts into "현금 정산 포함" mode there. 구분: 입금(+, received) / 출금(-, paid). ----
function signedCashAmount(c) {
  if (c.amount === '' || c.amount === undefined || c.amount === null || isNaN(Number(c.amount))) return null;
  const mag = Math.abs(Number(c.amount));
  return c.type === 'out' ? -mag : mag;
}
function cashTotals() {
  const totals = [0, 0, 0];
  cashRows.forEach(c => {
    const signed = signedCashAmount(c);
    if (c.player != null && signed !== null) totals[c.player] += signed;
  });
  return totals;
}

function renderCash() {
  const cashSettled = cashTotals();

  const cards = document.getElementById('cashCards');
  cards.innerHTML = '';
  [0,1,2].forEach(i => {
    const t = cashSettled[i];
    const tile = document.createElement('div');
    tile.className = 'stat-tile ' + (t > 0 ? 'status-good' : t < 0 ? 'status-critical' : '');
    tile.innerHTML = `
      <div class="label"><span class="dot" style="background:${SERIES_COLORS[i]}"></span>${players[i]} 현금 누적</div>
      <div class="value">${fmt(t)}</div>
      <div class="sub">${t > 0 ? '입금(순수취) 누적' : t < 0 ? '출금(순지급) 누적' : '변동 없음'}</div>`;
    cards.appendChild(tile);
  });

  const body = document.getElementById('cashBody');
  body.innerHTML = '';
  let flashEl = null;
  sortByDateDesc(cashRows).forEach(({ item: c, idx }) => {
    const tr = document.createElement('tr');
    if (idx === flashCashIndex) { tr.classList.add('flash'); flashEl = tr; }

    const tdDate = document.createElement('td');
    tdDate.className = 'date-display-cell';
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'date-calendar-only';
    dateInput.value = c.date || '';
    dateInput.dataset.key = 'cash-' + idx + '-date';
    const dateLabel = document.createElement('span');
    dateLabel.className = 'date-display-label';
    dateLabel.textContent = formatDateDots(c.date);
    dateInput.addEventListener('input', e => {
      c.date = e.target.value;
      dateLabel.textContent = formatDateDots(c.date);
      rerenderKeepFocus(renderAll);
    });
    // 게임 기록의 날짜와 동일하게 직접 타이핑은 막고(Tab만 허용) 캘린더로만 바꾸도록 한다.
    dateInput.addEventListener('keydown', e => { if (e.key !== 'Tab') e.preventDefault(); });
    dateInput.addEventListener('click', () => { if (typeof dateInput.showPicker === 'function') { try { dateInput.showPicker(); } catch (err) {} } });
    tdDate.appendChild(dateInput);
    tdDate.appendChild(dateLabel);
    tr.appendChild(tdDate);

    const tdType = document.createElement('td');
    const typeSel = document.createElement('select');
    typeSel.dataset.key = 'cash-' + idx + '-type';
    [['in','입금 (+)'], ['out','출금 (-)']].forEach(([val, label]) => {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = label;
      if ((c.type || 'in') === val) opt.selected = true;
      typeSel.appendChild(opt);
    });
    typeSel.addEventListener('change', e => { c.type = e.target.value; renderAll(); });
    tdType.appendChild(typeSel);
    tr.appendChild(tdType);

    const tdPlayer = document.createElement('td');
    const sel = document.createElement('select');
    sel.dataset.key = 'cash-' + idx + '-player';
    players.forEach((name, pi) => {
      const opt = document.createElement('option');
      opt.value = pi; opt.textContent = name;
      if ((c.player ?? 0) === pi) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', e => { c.player = Number(e.target.value); renderAll(); });
    tdPlayer.appendChild(sel);
    tr.appendChild(tdPlayer);

    const tdAmt = document.createElement('td');
    const amtInput = document.createElement('input');
    amtInput.type = 'number';
    amtInput.min = '0';
    amtInput.placeholder = '금액 (양수)';
    amtInput.value = c.amount ?? '';
    amtInput.dataset.key = 'cash-' + idx + '-amount';
    amtInput.addEventListener('input', e => { c.amount = e.target.value === '' ? '' : Number(e.target.value); rerenderKeepFocus(renderAll); });
    tdAmt.appendChild(amtInput);
    tr.appendChild(tdAmt);

    const tdSigned = document.createElement('td');
    const signed = signedCashAmount(c);
    tdSigned.textContent = signed === null ? '-' : fmt(signed);
    tdSigned.className = signed === null ? '' : (signed > 0 ? 'pl-pos' : signed < 0 ? 'pl-neg' : 'pl-zero');
    tr.appendChild(tdSigned);

    const tdNote = document.createElement('td');
    tdNote.className = 'note-cell';
    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.value = c.note || '';
    noteInput.dataset.key = 'cash-' + idx + '-note';
    noteInput.addEventListener('input', e => { c.note = e.target.value; scheduleAutoSync(); });
    tdNote.appendChild(noteInput);
    tr.appendChild(tdNote);

    const tdDel = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'row-del';
    delBtn.textContent = '✕';
    delBtn.title = '삭제';
    delBtn.addEventListener('click', () => {
      if (!confirm(`${c.date || '날짜 없음'} 현금화 기록을 삭제할까요? 되돌릴 수 없어요.`)) return;
      cashRows.splice(idx, 1);
      renderAll();
    });
    tdDel.appendChild(delBtn);
    tr.appendChild(tdDel);

    body.appendChild(tr);
  });
  if (!cashRows.length) {
    body.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted);padding:14px;">아직 현금화 기록이 없습니다.</td></tr>';
  }
  // renderDailyCards()의 현금화 카드처럼, 이 표를 대신하는 좁은 화면용 카드 뷰도 같은
  // flashCashIndex를 보고 방금 추가된 항목을 반짝여줘야 하니 nulling 전에 먼저 그린다.
  renderCashCards();
  if (flashCashIndex !== null) {
    flashCashIndex = null;
  }
}

// 현금 계좌: 좁은 화면(모바일)용 카드 뷰 — 표의 날짜/구분/플레이어/금액/반영액/메모/삭제를
// 그대로 담되, 옆으로 늘어선 6개 칸 대신 카드 하나에 세로로 정리해서 가로 스크롤이 안 생기게 한다.
// data-key는 표와 겹치지 않도록 "m-" 접두사를 쓴다 (이유는 renderDailyCards() 주석 참고).
function renderCashCards() {
  const wrap = document.getElementById('cashCardsList');
  wrap.innerHTML = '';
  sortByDateDesc(cashRows).forEach(({ item: c, idx }) => {
    const card = document.createElement('div');
    card.className = 'daily-card cash-entry-card';
    if (idx === flashCashIndex) card.classList.add('flash');

    const head = document.createElement('div');
    head.className = 'daily-card-head';
    const dateWrap = document.createElement('div');
    dateWrap.className = 'daily-card-date';
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'date-calendar-only';
    dateInput.value = c.date || '';
    dateInput.dataset.key = 'm-cash-' + idx + '-date';
    const dateLabel = document.createElement('span');
    dateLabel.className = 'date-display-label';
    dateLabel.textContent = formatDateDots(c.date);
    dateInput.addEventListener('input', e => {
      c.date = e.target.value;
      dateLabel.textContent = formatDateDots(c.date);
      rerenderKeepFocus(renderAll);
    });
    dateInput.addEventListener('keydown', e => { if (e.key !== 'Tab') e.preventDefault(); });
    dateInput.addEventListener('click', () => { if (typeof dateInput.showPicker === 'function') { try { dateInput.showPicker(); } catch (err) {} } });
    dateWrap.appendChild(dateInput);
    dateWrap.appendChild(dateLabel);
    head.appendChild(dateWrap);

    const delBtn = document.createElement('button');
    delBtn.className = 'row-del'; delBtn.textContent = '✕'; delBtn.title = '삭제';
    delBtn.addEventListener('click', () => {
      if (!confirm(`${c.date || '날짜 없음'} 현금화 기록을 삭제할까요? 되돌릴 수 없어요.`)) return;
      cashRows.splice(idx, 1);
      renderAll();
    });
    head.appendChild(delBtn);
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'cash-entry-body';

    const row1 = document.createElement('div');
    row1.className = 'cash-entry-row';
    const typeSel = document.createElement('select');
    typeSel.dataset.key = 'm-cash-' + idx + '-type';
    [['in','입금 (+)'], ['out','출금 (-)']].forEach(([val, label]) => {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = label;
      if ((c.type || 'in') === val) opt.selected = true;
      typeSel.appendChild(opt);
    });
    typeSel.addEventListener('change', e => { c.type = e.target.value; renderAll(); });
    row1.appendChild(typeSel);
    const playerSel = document.createElement('select');
    playerSel.dataset.key = 'm-cash-' + idx + '-player';
    players.forEach((name, pi) => {
      const opt = document.createElement('option');
      opt.value = pi; opt.textContent = name;
      if ((c.player ?? 0) === pi) opt.selected = true;
      playerSel.appendChild(opt);
    });
    playerSel.addEventListener('change', e => { c.player = Number(e.target.value); renderAll(); });
    row1.appendChild(playerSel);
    body.appendChild(row1);

    const row2 = document.createElement('div');
    row2.className = 'cash-entry-row';
    const amtField = document.createElement('div');
    amtField.className = 'cash-entry-field';
    const amtLabel = document.createElement('span'); amtLabel.textContent = '금액';
    const amtInput = document.createElement('input');
    amtInput.type = 'number'; amtInput.min = '0'; amtInput.placeholder = '금액 (양수)';
    amtInput.value = c.amount ?? '';
    amtInput.dataset.key = 'm-cash-' + idx + '-amount';
    amtInput.addEventListener('input', e => { c.amount = e.target.value === '' ? '' : Number(e.target.value); rerenderKeepFocus(renderAll); });
    amtField.appendChild(amtLabel); amtField.appendChild(amtInput);
    row2.appendChild(amtField);

    const signedDiv = document.createElement('div');
    signedDiv.className = 'cash-entry-signed';
    const signed = signedCashAmount(c);
    signedDiv.innerHTML = '<span class="sub-label">반영액</span>' +
      `<span class="${signed===null?'':(signed>0?'pl-pos':signed<0?'pl-neg':'pl-zero')}">${signed===null?'-':fmt(signed)}</span>`;
    row2.appendChild(signedDiv);
    body.appendChild(row2);

    const noteInput = document.createElement('input');
    noteInput.type = 'text'; noteInput.className = 'note'; noteInput.placeholder = '메모';
    noteInput.value = c.note || '';
    noteInput.dataset.key = 'm-cash-' + idx + '-note';
    noteInput.addEventListener('input', e => { c.note = e.target.value; scheduleAutoSync(); });
    body.appendChild(noteInput);

    card.appendChild(body);
    wrap.appendChild(card);
  });
  if (!cashRows.length) {
    wrap.innerHTML = '<p style="color:var(--text-muted);padding:14px;text-align:center;">아직 현금화 기록이 없습니다.</p>';
  }
}

// ---- 일일 기록 입력 폼 (finalize -> pushes a row into the ledger) ----
// entryForm.buyin[i] is an ARRAY of buy-in entries for player i (rebuys during
// the session) that get summed into one total when finalized.
function renderEntryForm() {
  const wrap = document.getElementById('entryPlayers');
  wrap.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const card = document.createElement('div');
    card.className = 'entry-player-card';

    // 이름과 "+ 빌린칩 추가"를 같은 줄, 오른쪽 끝에 배치한다.
    const nameRow = document.createElement('div');
    nameRow.className = 'entry-name-row';
    const nameDiv = document.createElement('div');
    nameDiv.className = 'name';
    nameDiv.innerHTML = `<span class="dot" style="background:${SERIES_COLORS[i]}"></span>${players[i]}`;
    nameRow.appendChild(nameDiv);
    const addBtn = document.createElement('button');
    addBtn.className = 'entry-add-buyin'; addBtn.type = 'button';
    addBtn.textContent = '+ 빌린칩 추가';
    addBtn.addEventListener('click', () => { entryForm.buyin[i].push(''); renderEntryForm(); });
    nameRow.appendChild(addBtn);
    card.appendChild(nameRow);

    // 안내문구와 빌린칩 입력칸들을 한 줄에 나란히 놓고, 합계는 그 아래 별도 줄로 뺀다.
    const buyHeader = document.createElement('div');
    buyHeader.className = 'entry-buyin-header';
    const buyLabel = document.createElement('span');
    buyLabel.className = 'entry-buyin-label';
    buyLabel.textContent = '빌린칩';
    buyHeader.appendChild(buyLabel);

    const list = document.createElement('div');
    list.className = 'entry-buyin-list';
    entryForm.buyin[i].forEach((val, j) => {
      const chip = document.createElement('div');
      chip.className = 'entry-buyin-chip';
      const inp = document.createElement('input');
      inp.type = 'text'; inp.inputMode = 'numeric'; inp.placeholder = '빌린칩';
      inp.value = fmtAmt(val);
      inp.dataset.key = `entry-buy-${i}-${j}`;
      inp.addEventListener('focus', e => { e.target.value = entryForm.buyin[i][j] ?? ''; });
      inp.addEventListener('input', e => {
        const digits = e.target.value.replace(/[^0-9]/g, '');
        if (e.target.value !== digits) e.target.value = digits;
        entryForm.buyin[i][j] = digits;
        updateEntryPreview();
      });
      inp.addEventListener('blur', e => { e.target.value = fmtAmt(entryForm.buyin[i][j]); });
      const rm = document.createElement('button');
      rm.className = 'rm'; rm.type = 'button'; rm.textContent = '✕'; rm.title = '이 칸 삭제';
      rm.disabled = entryForm.buyin[i].length <= 1;
      rm.addEventListener('click', () => {
        entryForm.buyin[i].splice(j, 1);
        if (entryForm.buyin[i].length === 0) entryForm.buyin[i].push('');
        renderEntryForm();
      });
      chip.appendChild(inp); chip.appendChild(rm);
      list.appendChild(chip);
    });
    buyHeader.appendChild(list);
    card.appendChild(buyHeader);

    const buyTotal = document.createElement('div');
    buyTotal.className = 'entry-buyin-total';
    buyTotal.innerHTML = `합계: <b id="entryBuyTotal${i}">-</b>`;
    card.appendChild(buyTotal);

    const finalRow = document.createElement('div');
    finalRow.className = 'entry-final-row';
    finalRow.innerHTML = `<span class="flabel">최종칩</span>`;
    const fin = document.createElement('input');
    fin.type = 'text'; fin.inputMode = 'numeric'; fin.placeholder = '최종칩';
    fin.value = fmtAmt(entryForm.final[i]);
    fin.dataset.key = 'entry-final-' + i;
    fin.addEventListener('focus', e => { e.target.value = entryForm.final[i] ?? ''; });
    fin.addEventListener('input', e => {
      const digits = e.target.value.replace(/[^0-9]/g, '');
      if (e.target.value !== digits) e.target.value = digits;
      entryForm.final[i] = digits;
      updateEntryPreview();
    });
    fin.addEventListener('blur', e => { e.target.value = fmtAmt(entryForm.final[i]); });
    const badge = document.createElement('div');
    badge.className = 'entry-pl-badge';
    badge.id = 'entryPl' + i;
    finalRow.appendChild(fin);
    finalRow.appendChild(badge);
    card.appendChild(finalRow);

    wrap.appendChild(card);
  }
  document.getElementById('entryDate').value = entryForm.date;
  document.getElementById('entryWeekday').textContent = weekday(entryForm.date);
  document.getElementById('entryNote').value = entryForm.note;
  document.getElementById('entryError').style.display = 'none';
  updateEntryPreview();
}

function updateEntryPreview() {
  const totals = [0,1,2].map(i => buyinTotal(entryForm.buyin[i]));
  totals.forEach((t, i) => {
    const totalEl = document.getElementById('entryBuyTotal' + i);
    if (totalEl) totalEl.textContent = t === null ? '-' : fmt(t);
  });
  const vals = [0,1,2].map(i => {
    const b = totals[i], f = entryForm.final[i];
    if (b === null || f === '' || f === undefined) return null;
    return Number(f) - b;
  });
  vals.forEach((v,i) => {
    const badge = document.getElementById('entryPl'+i);
    if (!badge) return;
    badge.textContent = v === null ? '-' : fmt(v);
    badge.className = 'entry-pl-badge ' + (v === null ? '' : v > 0 ? 'pl-pos' : v < 0 ? 'pl-neg' : 'pl-zero');
  });
  const box = document.getElementById('entryValidation');
  if (vals.some(v => v === null)) {
    box.textContent = '모든 플레이어의 빌린칩·최종칩을 입력하면 검증 결과가 표시됩니다.';
    box.className = 'entry-validation';
  } else {
    const sum = vals.reduce((a,b)=>a+b,0);
    if (sum === 0) { box.textContent = '✓ 검증 정상 (합계 0)'; box.className = 'entry-validation ok'; }
    else { box.textContent = `⚠ 합계가 0이 아닙니다 (오차 ${fmt(sum)}) — 입력값을 다시 확인해주세요.`; box.className = 'entry-validation bad'; }
  }
}

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  // 그래프는 실제 렌더링 너비를 그대로 viewBox로 쓰기 때문에, 숨겨져 있던 탭이 다시 보이거나
  // (그동안 창 너비가 바뀌었을 수 있으니) 너비를 다시 재서 그려야 배율이 안 틀어진다.
  if (tab === 'ledger') renderSummary();
}
document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

// 창 크기가 바뀌면(브라우저 리사이즈, 모바일 화면 회전 등) 그래프의 실제 너비도 바뀌므로
// 다시 그려서 배율을 맞춘다. 리사이즈 중에는 과도하게 자주 다시 그리지 않도록 약간 debounce.
let chartResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(() => {
    if (document.getElementById('tab-ledger').classList.contains('active')) renderSummary();
  }, 150);
});

document.getElementById('entryDate').addEventListener('input', e => {
  entryForm.date = e.target.value;
  document.getElementById('entryWeekday').textContent = weekday(entryForm.date);
});
document.getElementById('entryNote').addEventListener('input', e => { entryForm.note = e.target.value; });

document.getElementById('resetEntryBtn').addEventListener('click', () => {
  entryForm = { date: entryForm.date, note: '', buyin: [[''], [''], ['']], final: ['', '', ''] };
  renderEntryForm();
});

document.getElementById('finalizeBtn').addEventListener('click', () => {
  const errBox = document.getElementById('entryError');
  if (!entryForm.date) {
    errBox.textContent = '날짜를 입력해주세요.';
    errBox.style.display = 'block';
    return;
  }
  const buyin = [0,1,2].map(i => buyinTotal(entryForm.buyin[i]));
  const final = entryForm.final.map(v => v === '' || v === undefined ? null : Number(v));
  if (buyin.some(v => v === null) || final.some(v => v === null)) {
    errBox.textContent = '모든 플레이어의 빌린칩·최종칩을 입력해주세요.';
    errBox.style.display = 'block';
    return;
  }
  errBox.style.display = 'none';

  rows.push({ id: nextSessionId++, date: entryForm.date, note: entryForm.note, buyin, final });
  flashRowIndex = rows.length - 1;

  entryForm = { date: entryForm.date, note: '', buyin: [[''], [''], ['']], final: ['', '', ''] };
  renderEntryForm();
  renderAll();
  switchTab('ledger');
});

function renderAll() {
  renderPlayers();
  renderDaily();
  renderSummary();
  renderCash();
  scheduleAutoSync();
}

// Called while the user is actively typing a player name. Updates every OTHER
// place the name appears (게임 기록 행, entry form, legend, cards, chart,
// cumulative table, cash account) without touching the players-row input itself.
function refreshPlayerLabels() {
  renderDaily();
  renderEntryForm();
  renderSummary();
  renderCash();
  scheduleAutoSync();
}

document.getElementById('addRowBtn').addEventListener('click', () => {
  openDatePicker('게임 기록 날짜 선택', date => {
    rows.push({ id: nextSessionId++, date, note: '', buyin: ['', '', ''], final: ['', '', ''] });
    flashRowIndex = rows.length - 1;
    renderAll();
  });
});

document.getElementById('addCashBtn').addEventListener('click', () => {
  openDatePicker('현금화(입금/정산) 날짜 선택', date => {
    cashRows.push({ id: nextCashId++, date, player: 0, type: 'in', amount: '', note: '' });
    flashCashIndex = cashRows.length - 1;
    renderAll();
  });
});

document.getElementById('dateModalConfirm').addEventListener('click', () => {
  const val = document.getElementById('dateModalInput').value;
  if (!isValidDateStr(val)) { alert('날짜를 선택해주세요.'); return; }
  const cb = dateModalCallback;
  closeDatePicker();
  if (cb) cb(val);
});
document.getElementById('dateModalCancel').addEventListener('click', closeDatePicker);
document.getElementById('dateModalClose').addEventListener('click', closeDatePicker);
document.getElementById('dateModalBackdrop').addEventListener('click', closeDatePicker);
{
  const dmInput = document.getElementById('dateModalInput');
  dmInput.classList.add('date-calendar-only');
  dmInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('dateModalConfirm').click(); return; }
    if (e.key !== 'Tab') e.preventDefault();
  });
  dmInput.addEventListener('click', () => { if (typeof dmInput.showPicker === 'function') { try { dmInput.showPicker(); } catch (err) {} } });
}

document.querySelectorAll('#summaryModeToggle button').forEach(btn => {
  btn.addEventListener('click', () => {
    summaryMode = btn.dataset.mode;
    document.querySelectorAll('#summaryModeToggle button').forEach(b => b.classList.toggle('active', b === btn));
    renderSummary();
  });
});

document.getElementById('themeToggle').addEventListener('click', () => {
  const root = document.documentElement;
  const cur = root.getAttribute('data-theme');
  if (cur === 'dark') { root.setAttribute('data-theme','light'); document.getElementById('themeToggle').textContent='다크모드'; }
  else { root.setAttribute('data-theme','dark'); document.getElementById('themeToggle').textContent='라이트모드'; }
  document.getElementById('moreMenu').style.display = 'none';
});

// ---- 저장 알림 (우상단 "최종 저장" 표시 + 토스트) ----
// 실시간 자동저장이 조용히 실패/성공하는 게 안 보인다는 피드백 때문에, 저장이 실제로
// 일어날 때마다(자동 동기화든 이름 있는 백업이든) 이 두 가지로 눈에 보이게 알려준다.
let toastTimer = null;
function showToast(text, kind) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove('show'); }, 2600);
}


// ======================================================================
// 서버 연동 (로그인 · 불러오기 · 자동저장 · 백업)
// 원칙: 불러오기에 성공하기 전에는 절대 저장하지 않는다 (빈 화면이 기존 데이터를 덮는 사고 방지).
// ======================================================================
const TOKEN_KEY = 'cardLedgerToken';
let authToken = '';
try { authToken = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { /* 저장소 사용 불가 시 매번 로그인 */ }

let syncReady = false;        // 최초 불러오기에 성공한 뒤에만 true
let baseUpdatedAt = null;     // 내가 마지막으로 서버와 맞춘 "최신본 저장 시각"
let lastSyncedJson = '';      // 서버에 반영된 마지막 내용 (바뀐 게 없으면 저장 생략)
let syncTimer = null;
let syncInFlight = false;
let syncDirty = false;
let syncRetry = 0;
let syncConflict = false;
let booted = false;

class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body || {}; }
}

async function api(method, path, body, opts) {
  const headers = {};
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  let res;
  try {
    res = await fetch('/api' + path, { method, headers, body: payload, keepalive: !!(opts && opts.keepalive) && payload && payload.length < 60000 });
  } catch (e) {
    throw new ApiError('서버에 연결할 수 없어요. 인터넷 연결을 확인해주세요.', 0);
  }
  let json = {};
  try { json = await res.json(); } catch (e) { /* 본문 없음 */ }
  if (res.status === 401 && path !== '/login') {
    clearToken();
    showPanel('login', '로그인이 만료되었어요. 다시 로그인해주세요.');
    throw new ApiError('로그인이 필요합니다.', 401, json);
  }
  if (!res.ok) throw new ApiError(json.error || ('서버 오류 (' + res.status + ')'), res.status, json);
  return json;
}

function clearToken() {
  authToken = '';
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
}

// ---- 로그인 / 로딩 / 오류 화면 ----
function showPanel(which, message) {
  const overlay = document.getElementById('bootOverlay');
  overlay.style.display = 'flex';
  // 앱이 이미 떠 있는 상태(세션 만료)에서는 화면을 지우지 않고 위에 덮는다 → 입력 중이던 내용 보존
  overlay.classList.toggle('over-app', booted);
  document.getElementById('loginPanel').style.display = which === 'login' ? '' : 'none';
  document.getElementById('loadingPanel').style.display = which === 'loading' ? '' : 'none';
  document.getElementById('errorPanel').style.display = which === 'error' ? '' : 'none';
  if (which === 'login') {
    document.getElementById('loginError').textContent = message || '';
    const pw = document.getElementById('loginPassword');
    pw.value = '';
    setTimeout(() => pw.focus(), 0);
  }
  if (which === 'error') document.getElementById('bootErrorText').textContent = message || '';
}
function hideOverlay() {
  document.getElementById('bootOverlay').style.display = 'none';
  document.body.classList.remove('booting');
}

document.getElementById('loginPanel').addEventListener('submit', async e => {
  e.preventDefault();
  const pw = document.getElementById('loginPassword').value;
  if (!pw) return;
  const btn = document.getElementById('loginBtn');
  btn.disabled = true;
  document.getElementById('loginError').textContent = '';
  try {
    const json = await api('POST', '/login', { password: pw });
    authToken = json.token;
    try { localStorage.setItem(TOKEN_KEY, authToken); } catch (err) {}
    document.getElementById('loginPassword').value = '';
    if (booted) { hideOverlay(); if (syncReady) scheduleAutoSync(); }
    else boot();
  } catch (err) {
    document.getElementById('loginError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('bootRetryBtn').addEventListener('click', () => boot());

// ---- 데이터 적용 ----
function currentData() { return { players, rows, cashRows }; }
function currentJson() { return JSON.stringify(currentData()); }

function applyLoadedData(data) {
  if (!data) return;
  if (Array.isArray(data.players) && data.players.length === 3) players = data.players;
  if (Array.isArray(data.rows)) rows = data.rows;
  if (Array.isArray(data.cashRows)) cashRows = data.cashRows;
  nextSessionId = 1 + rows.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0);
  nextCashId = 1 + cashRows.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0);
  renderEntryForm();
  renderAll();
}

// ---- 저장 상태 표시 ----
function setSyncState(state, text) {
  const el = document.getElementById('lastSavedIndicator');
  if (!el) return;
  el.className = 'last-saved' + (state === 'saving' ? ' saving' : state === 'error' ? ' error' : '');
  el.textContent = text;
}
function markSaved(when, label) {
  const t = when ? new Date(when) : new Date();
  setSyncState('ok', '최종 저장 ' + t.toLocaleTimeString());
  showToast('✓ ' + (label || '저장됨') + ' · ' + t.toLocaleTimeString(), 'ok');
}
function setDbStatus(text, kind) {
  const el = document.getElementById('dbStatus');
  el.textContent = text;
  el.className = 'db-status' + (kind ? ' ' + kind : '');
}

// ---- 자동 저장 ----
// 데이터가 바뀔 때마다(renderAll 등) 호출된다. 1.5초 디바운스, 내용이 그대로면 저장하지 않는다.
function scheduleAutoSync(delay) {
  if (!syncReady || syncConflict) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(doAutoSync, delay === undefined ? 1500 : delay);
}
function isDirty() { return syncReady && (syncInFlight || currentJson() !== lastSyncedJson); }

async function doAutoSync() {
  if (!syncReady || syncConflict) return;
  if (syncInFlight) { syncDirty = true; return; }
  const json = currentJson();
  if (json === lastSyncedJson) { return; }
  syncInFlight = true;
  setSyncState('saving', '저장 중…');
  try {
    const r = await api('PUT', '/latest', { data: JSON.parse(json), baseUpdatedAt }, { keepalive: true });
    baseUpdatedAt = r.updatedAt;
    lastSyncedJson = json;
    syncRetry = 0;
    markSaved(r.updatedAt, '자동 저장됨');
  } catch (err) {
    if (err.status === 409) {
      enterConflict();
    } else if (err.status === 401) {
      setSyncState('error', '로그인 필요 · 저장 대기 중');
    } else if (err.status === 400) {
      setSyncState('error', '저장 거부됨');
      showToast('저장하지 못했어요: ' + err.message, 'bad');
    } else {
      syncRetry++;
      const wait = Math.min(30000, 2000 * Math.pow(2, syncRetry - 1));
      setSyncState('error', '저장 실패 · ' + Math.round(wait / 1000) + '초 뒤 재시도');
      clearTimeout(syncTimer);
      syncTimer = setTimeout(doAutoSync, wait);
    }
  } finally {
    syncInFlight = false;
    if (syncDirty && !syncConflict) { syncDirty = false; scheduleAutoSync(); }
  }
}

// ---- 충돌 (다른 기기가 먼저 수정) ----
function enterConflict() {
  syncConflict = true;
  clearTimeout(syncTimer);
  setSyncState('error', '저장 중단 · 충돌');
  document.getElementById('syncBannerText').textContent =
    '다른 기기(또는 다른 창)에서 먼저 수정한 내용이 있어서 저장을 멈췄어요. 어느 쪽을 쓸지 골라주세요. 아무것도 덮어쓰지 않았습니다.';
  document.getElementById('syncBanner').style.display = '';
}
function leaveConflict() {
  syncConflict = false;
  document.getElementById('syncBanner').style.display = 'none';
}

document.getElementById('syncReloadBtn').addEventListener('click', async () => {
  if (!confirm('서버의 최신 내용을 불러옵니다. 이 화면에서 저장되지 않은 변경은 사라져요. 계속할까요?')) return;
  try {
    const r = await api('GET', '/latest');
    if (r.updatedAt) applyLoadedData(r.data);
    baseUpdatedAt = r.updatedAt || null;
    lastSyncedJson = currentJson();
    leaveConflict();
    setSyncState('ok', r.updatedAt ? '최종 저장 ' + new Date(r.updatedAt).toLocaleTimeString() : '최종 저장: -');
    showToast('✓ 서버 최신본을 불러왔어요', 'ok');
  } catch (err) {
    showToast('불러오지 못했어요: ' + err.message, 'bad');
  }
});

document.getElementById('syncOverwriteBtn').addEventListener('click', async () => {
  if (!confirm('이 화면의 내용으로 서버를 덮어씁니다. 덮어쓰기 직전의 서버 최신본은 백업 목록에 자동으로 남겨져요. 계속할까요?')) return;
  try {
    const json = currentJson();
    const r = await api('PUT', '/latest', { data: JSON.parse(json), force: true });
    baseUpdatedAt = r.updatedAt;
    lastSyncedJson = json;
    leaveConflict();
    markSaved(r.updatedAt, '내 화면으로 덮어씀 (이전 최신본은 백업에 보관)');
  } catch (err) {
    showToast('덮어쓰지 못했어요: ' + err.message, 'bad');
  }
});

// 탭을 닫거나 백그라운드로 보낼 때 아직 못 보낸 변경이 있으면 바로 저장 시도 / 경고
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && syncReady && !syncConflict && isDirty()) { clearTimeout(syncTimer); doAutoSync(); }
});
window.addEventListener('beforeunload', e => {
  if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
});

// ---- 더보기 메뉴 / 저장·불러오기 팝업 ----
document.getElementById('moreMenuBtn').addEventListener('click', e => {
  e.stopPropagation();
  const menu = document.getElementById('moreMenu');
  menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
});
document.addEventListener('click', e => {
  const menu = document.getElementById('moreMenu');
  if (menu.style.display === 'block' && e.target.id !== 'moreMenuBtn' && !menu.contains(e.target)) menu.style.display = 'none';
});
function openDbModal() {
  document.getElementById('moreMenu').style.display = 'none';
  document.getElementById('dbModalBackdrop').style.display = 'block';
  document.getElementById('dbModal').style.display = 'block';
  document.getElementById('dbBackupPicker').style.display = 'none';
  setDbStatus('', '');
}
function closeDbModal() {
  document.getElementById('dbModalBackdrop').style.display = 'none';
  document.getElementById('dbModal').style.display = 'none';
}
document.getElementById('openDbModalBtn').addEventListener('click', openDbModal);
document.getElementById('dbModalClose').addEventListener('click', closeDbModal);
document.getElementById('dbModalBackdrop').addEventListener('click', closeDbModal);

document.getElementById('logoutBtn').addEventListener('click', async () => {
  document.getElementById('moreMenu').style.display = 'none';
  if (syncReady && !syncConflict && isDirty()) { clearTimeout(syncTimer); await doAutoSync(); }
  if (isDirty() && !confirm('아직 저장되지 않은 변경이 있어요. 그래도 로그아웃할까요?')) return;
  syncReady = false;
  clearToken();
  location.reload();
});

document.getElementById('dbSaveBtn').addEventListener('click', async () => {
  const name = prompt('백업 이름을 입력하세요 (예: 8월 정산본)');
  if (!name) return;
  setDbStatus('백업 저장 중...', 'loading');
  try {
    const r = await api('POST', '/backups', { name, data: currentData() });
    setDbStatus(`✓ 백업 저장 완료: "${name}" (${r.savedAt ? new Date(r.savedAt).toLocaleString() : ''})`, 'ok');
    markSaved(r.savedAt, `백업 "${name}" 저장됨`);
  } catch (err) {
    setDbStatus('백업 저장 실패: ' + err.message, 'bad');
  }
});

document.getElementById('dbLoadBtn').addEventListener('click', async () => {
  setDbStatus('백업 목록을 불러오는 중...', 'loading');
  try {
    const r = await api('GET', '/backups');
    const backups = r.backups || [];
    const sel = document.getElementById('dbBackupSelect');
    sel.innerHTML = '';
    if (!backups.length) {
      setDbStatus('저장해둔 백업이 아직 없습니다.', 'bad');
      document.getElementById('dbBackupPicker').style.display = 'none';
      return;
    }
    backups.slice().reverse().forEach(b => { // 최신 백업이 위로
      const opt = document.createElement('option');
      opt.value = b.id;
      opt.textContent = `${b.name} · ${b.savedAt ? new Date(b.savedAt).toLocaleString() : ''}`;
      sel.appendChild(opt);
    });
    document.getElementById('dbBackupPicker').style.display = '';
    setDbStatus(`백업 ${backups.length}건을 찾았습니다. 목록에서 골라 "선택한 백업 불러오기"를 눌러주세요.`, '');
  } catch (err) {
    setDbStatus('백업 목록 불러오기 실패: ' + err.message, 'bad');
  }
});

document.getElementById('dbLoadSelectedBtn').addEventListener('click', async () => {
  const id = document.getElementById('dbBackupSelect').value;
  if (!id) return;
  if (syncConflict) { setDbStatus('저장 충돌을 먼저 해결해주세요 (화면 위쪽 안내).', 'bad'); return; }
  if (!confirm('선택한 백업을 불러오면 현재 화면과 최신본이 그 내용으로 바뀝니다. 바뀌기 전의 현재 내용은 백업 목록에 자동으로 남겨둡니다. 계속할까요?')) return;
  setDbStatus('백업을 불러오는 중...', 'loading');
  try {
    // 1) 먼저 아직 못 보낸 변경을 서버에 반영, 2) 현재 내용을 자동 백업 — 둘 중 하나라도 실패하면 불러오지 않는다
    clearTimeout(syncTimer);
    await doAutoSync();
    if (syncConflict || currentJson() !== lastSyncedJson) throw new Error('현재 내용을 저장하지 못해 중단했어요. 잠시 후 다시 시도해주세요.');
    await api('POST', '/backups', { name: `자동백업 · 백업 불러오기 전 (${new Date().toLocaleString()})`, data: currentData() });
    const b = await api('GET', '/backups/' + encodeURIComponent(id));
    applyLoadedData(b.data);
    document.getElementById('dbBackupPicker').style.display = 'none';
    setDbStatus(`✓ "${b.name}" 백업을 불러왔습니다 (${b.savedAt ? new Date(b.savedAt).toLocaleString() : ''}). 최신본에도 곧 반영돼요.`, 'ok');
  } catch (err) {
    setDbStatus('백업 불러오기 실패: ' + err.message, 'bad');
  }
});

document.getElementById('dbDeleteBackupBtn').addEventListener('click', async () => {
  const sel = document.getElementById('dbBackupSelect');
  const id = sel.value;
  if (!id) return;
  const label = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent : '';
  if (!confirm(`"${label}" 백업을 삭제할까요? 되돌릴 수 없습니다.`)) return;
  setDbStatus('백업 삭제 중...', 'loading');
  try {
    await api('DELETE', '/backups/' + encodeURIComponent(id));
    const opt = sel.options[sel.selectedIndex];
    if (opt) opt.remove();
    if (!sel.options.length) {
      document.getElementById('dbBackupPicker').style.display = 'none';
      setDbStatus('✓ 백업을 삭제했습니다. 남은 백업이 없습니다.', 'ok');
    } else setDbStatus('✓ 백업을 삭제했습니다.', 'ok');
  } catch (err) {
    setDbStatus('백업 삭제 실패: ' + err.message, 'bad');
  }
});
document.getElementById('dbCancelLoadBtn').addEventListener('click', () => {
  document.getElementById('dbBackupPicker').style.display = 'none';
});

// ---- 시작 ----
async function boot() {
  if (!authToken) { showPanel('login'); return; }
  showPanel('loading');
  let r;
  try {
    r = await api('GET', '/latest');
  } catch (err) {
    if (err.status === 401) return; // api()가 이미 로그인 화면을 띄웠다
    showPanel('error', err.message);
    return;
  }
  booted = true;
  hideOverlay(); // 차트가 실제 너비를 재야 하므로 화면을 먼저 보이게 한 뒤 그린다
  switchTab('ledger');
  if (r.updatedAt) applyLoadedData(r.data); // 시트가 비어 있으면 기본 화면 유지 (사용자가 수정하기 전엔 저장하지 않음)
  else { renderEntryForm(); renderAll(); }
  baseUpdatedAt = r.updatedAt || null;
  lastSyncedJson = currentJson();
  setSyncState('ok', r.updatedAt ? '최종 저장 ' + new Date(r.updatedAt).toLocaleTimeString() : '최종 저장: -');
  syncReady = true; // 여기부터 자동 저장 시작
}
boot();
