# 카드게임 장부

3인 칩 장부 · 현금 계좌 · 합계 차트를 보는 웹 앱입니다.
Node(Express) 서버가 구글시트를 DB로 쓰고, 화면은 순수 HTML/JS 입니다. 접속은 공용 비밀번호 1개로 합니다.

```
브라우저 ──(비밀번호 로그인)──▶ Express 서버 ──(서비스 계정)──▶ 구글시트 (Latest / Backups 탭)
```

## 기존 데이터는 안전한가요?

- 시트 구조는 **기존 Apps Script 버전과 똑같이** 씁니다. (`Latest` 탭 2행 = 최신본, `Backups` 탭 = 이름 붙인 백업) 그래서 지금 시트를 그대로 연결하면 됩니다.
- 코드에는 기존 탭이나 행을 지우는 동작이 없습니다. 최신본은 2행 덮어쓰기, 백업은 추가/선택 삭제만 합니다.
- 불러오기에 **성공하기 전에는 아무것도 저장하지 않습니다.** (서버가 안 켜졌거나 시트를 못 읽을 때 빈 화면이 데이터를 덮는 사고 방지)
- 두 기기에서 동시에 열었을 때, 나중에 저장하려는 쪽은 **충돌로 저장이 거부**되고 화면에 안내가 뜹니다. (서버 최신 불러오기 / 내 화면으로 덮어쓰기)
  덮어쓰기를 선택해도 덮이기 직전의 최신본은 `Backups` 에 자동 보관됩니다. 백업을 불러올 때도 현재 내용이 먼저 자동 백업됩니다.
- 데이터가 커서 한 칸(5만 자)을 넘으면 여러 칸으로 나눠 저장합니다.

## 1. 구글 서비스 계정 만들기 (한 번만)

1. [Google Cloud Console](https://console.cloud.google.com/) → 프로젝트 선택(또는 새로 만들기)
2. **API 및 서비스 → 라이브러리 → Google Sheets API → 사용**
3. **IAM 및 관리자 → 서비스 계정 → 서비스 계정 만들기** (역할은 비워둬도 됩니다)
4. 만든 서비스 계정 → **키 → 키 추가 → 새 키 → JSON** 으로 파일을 받습니다. (이 파일은 비밀번호와 같으니 git에 올리지 마세요)
5. 사용 중인 구글시트를 열고 **공유** → 서비스 계정의 이메일(`...@...iam.gserviceaccount.com`)을 **편집자**로 추가합니다.
6. 시트 주소 `https://docs.google.com/spreadsheets/d/`**`여기 값`**`/edit` 이 `SPREADSHEET_ID` 입니다.

## 2. 로컬에서 실행

```bash
npm install
npm run dev          # 구글시트 없이 메모리 저장소로 화면 확인 (비밀번호: dev)
npm test             # 자동 테스트
```

실제 시트로 실행하려면 `.env.example` 을 참고해 환경변수를 설정한 뒤 `npm start` 하세요.

### 실제 시트 읽기 점검 (먼저 해보세요)

```bash
SPREADSHEET_ID=... GOOGLE_SERVICE_ACCOUNT_JSON="$(cat 키파일.json)" npm run verify-sheet
```

시트를 **읽기만** 해서 최신본/백업이 정상적으로 해석되는지(건수, JSON 형식) 알려줍니다. 아무것도 쓰지 않습니다.
배포 전에 `✓ 이상 없음` 이 나오는지 확인하세요.

## 3. GitHub 에 올리기

```bash
git remote add origin https://github.com/<계정>/<저장소>.git
git push -u origin main
```

`.gitignore` 가 `.env`, 키 파일, 그리고 예전 단일 HTML 파일(Apps Script 주소·비밀번호 포함)을 막아줍니다. 저장소는 **Private** 으로 만드는 걸 권장합니다.

## 4. Render 에 배포

1. Render → **New → Blueprint** (또는 Web Service) → 위 GitHub 저장소 선택. `render.yaml` 이 설정을 채워줍니다.
2. 환경변수 입력:

| 이름 | 값 |
| --- | --- |
| `SPREADSHEET_ID` | 시트 주소의 ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 키 JSON 파일 **내용 전체** |
| `APP_PASSWORD` | 로그인 공용 비밀번호 |
| `SESSION_SECRET` | 자동 생성(그대로 두면 됨) |

3. 배포가 끝나면 주소로 접속해 로그인합니다.
- 무료 플랜은 접속이 없으면 잠들어서 첫 접속이 20~50초 걸릴 수 있습니다. (데이터와는 무관 — 시트에 저장되어 있습니다)
- `APP_PASSWORD` 를 바꾸면 기존 로그인은 모두 풀립니다.

## 5. 전환 순서 (권장)

1. `npm run verify-sheet` 로 실제 시트 읽기 점검
2. 시트에서 **파일 → 버전 기록** 이 켜져 있는지 확인(복구용), 필요하면 시트를 한 번 **사본 만들기**
3. Render 배포 → 로그인 → 최신본이 기존과 같은지 눈으로 확인
4. 한동안 기존 Apps Script 버전은 **쓰지 않고** 보관 (두 버전을 번갈아 쓰면 서로 덮어쓸 수 있습니다)

## 구조

```
server.js            Express 앱 (로그인, /api, 정적 파일)
lib/store-sheets.js  구글시트 읽기/쓰기 (충돌 감지, 분할 저장, 자동 백업)
lib/auth.js          비밀번호 로그인 · 서명 토큰 · 무차별 대입 방지
lib/fake-sheets.js   테스트/개발용 메모리 시트
public/              화면 (index.html, app.js, styles.css)
test/                자동 테스트
scripts/verify-sheet.js   실제 시트 읽기 점검
```

## API

모든 요청(로그인 제외)에 `Authorization: Bearer <token>` 이 필요합니다.

| | |
| --- | --- |
| `POST /api/login` | `{password}` → `{token}` |
| `GET /api/latest` | 최신본 `{data, updatedAt}` |
| `PUT /api/latest` | `{data, baseUpdatedAt, force?}` — `baseUpdatedAt` 이 시트와 다르면 409 |
| `GET/POST /api/backups` | 백업 목록 / 추가 `{name, data}` |
| `GET/DELETE /api/backups/:id` | 백업 읽기 / 삭제 |
