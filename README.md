# Intentlane

`Intentlane`은 Codex SDK 기반 로컬 웹 작업 도구다. 로컬 git 저장소를 읽어 `Explain`로 코드를 이해하고, `Request -> Ticket` 흐름으로 요구사항을 분석, 계획, 구현, 검증, 리뷰 단계까지 이어준다.

이 README는 사람과 LLM/agent가 모두 바로 사용할 수 있게, 설치보다 먼저 `실행 순서`, `인증 방식`, `제품 mental model`, `주요 경로`를 빠르게 스캔할 수 있도록 구성했다.

## 30초 시작

### 1. 준비물

- OS: Linux, macOS, Windows + WSL2
- Node.js: 권장 `20.19+` 또는 `22.12+`
- `pnpm@10.28.1`
- `git`
- `rg` (`ripgrep`)
- 로컬 Codex/OpenAI 인증 환경

`native Windows`는 이 저장소 기준으로 정식 보장하지 않는다.

이 프로젝트는 별도 인증 UI를 제공하지 않는다. Codex/OpenAI 접근은 현재 머신의 로컬 설정을 그대로 사용한다.

### 2. 설치

```bash
git clone <your-fork-or-this-repo>
cd intentlane-codex
pnpm install
cp .env.example .env
```

### 3. 첫 실행용 `.env`

가장 안전한 첫 실행 경로는 루트 관리자 계정 bootstrap이다.

```dotenv
HOST=0.0.0.0
PORT=3001

INTENTLANE_CODEX_BOOTSTRAP_ROOT_ENABLED=1
INTENTLANE_CODEX_BOOTSTRAP_ROOT_NAME=admin
INTENTLANE_CODEX_BOOTSTRAP_ROOT_PASSWORD=change-this-before-use
```

추가로 개발 데이터를 저장소 루트와 분리하려면 아래를 권장한다.

```dotenv
INTENTLANE_CODEX_DATA_DIR=.local/dev-data
```

### 4. 개발 실행

```bash
pnpm dev
```

개발 모드 기본 주소:

- Web UI: `http://localhost:5173/`
- API: `http://localhost:3001/`
- Health: `http://localhost:3001/api/health`

`pnpm dev`는 아래 3개를 함께 띄운다.

- `pnpm dev:server`
- `pnpm dev:worker`
- `pnpm dev:web`

중요:

- `worker`가 없으면 ticket 자동 실행이 완전하게 돌지 않는다.
- `web`은 Vite dev server이고 `/api`를 `http://localhost:3001`으로 프록시한다.

### 5. 로컬 배포형 실행

```bash
pnpm build
pnpm start
```

이 경로에서는 API와 빌드된 웹 앱이 같은 origin에서 함께 서빙된다.

- App + API: `http://localhost:3001/`

`pnpm start`는 내부적으로 API 프로세스와 worker 프로세스를 같이 띄운다.

빌드 전에 `pnpm start`만 실행하면 웹 자산이 없어 `Web assets not found. Run pnpm build first.` 응답이 나온다.

## 첫 sanity check

서버 기동 후 가장 먼저 확인할 최소 순서다.

### Health

```bash
curl http://localhost:3001/api/health
```

예상 응답:

```json
{"status":"ok"}
```

### 로그인

브라우저 기본 로그인 화면은 `계정명 + 비밀번호`만 지원한다. 첫 실행에서는 bootstrap root 계정으로 로그인하는 것이 정석이다.

```bash
curl -X POST http://localhost:3001/api/access/login \
  -H 'Content-Type: application/json' \
  -d '{"name":"admin","password":"change-this-before-use"}'
```

예상 응답 형태:

```json
{
  "token": "<session-token>",
  "session": {
    "id": "ses_...",
    "accountName": "admin"
  }
}
```

처음 bootstrap된 root 계정은 `mustChangePassword` 상태로 만들어진다.

- 브라우저에서는 로그인 직후 비밀번호 변경 화면으로 들어갈 수 있다.
- API에서는 `/api/config`, `/api/access/logout`, `/api/access/me/password` 같은 제한된 경로만 먼저 호출할 수 있다.

### 설정 읽기

로그인에서 받은 토큰으로 최소 설정을 읽을 수 있다.

```bash
TOKEN="<session-token>"

curl http://localhost:3001/api/config \
  -H "Authorization: Bearer $TOKEN"
```

이 응답에는 현재 세션 권한, 허용 프로젝트, Explain 모델 선택값, Ticket category 정보가 들어 있다.

## 제품 mental model

이 앱을 이해할 때 가장 중요한 구분은 아래 두 줄이다.

> `Request`는 무엇을 원하는지 정리한다.
>
> `Ticket`은 그것을 어떻게 만들지 실행한다.

현재 UI는 아래 모드들로 구성된다.

### Explain

- 읽기 전용 코드 이해 모드
- 현재 프로젝트 코드를 읽으며 동작, 영향 범위, 변경 포인트를 질문한다
- 구현 요청처럼 보이는 입력은 Request draft로 넘길 수 있다

### Direct Dev

- Explain보다 자유로운 직접 작업 모드
- 에이전트 역할을 바꿔가며 구현/조사 중심 대화를 이어갈 수 있다
- Request/Ticket 흐름과 별개로 즉시 실무 작업을 밀어붙일 때 쓴다

### Requests

- 사용자 관점 요구사항 저장소
- 문제, 원하는 결과, 사용자 시나리오를 정리한다
- 충분히 선명해지면 Ticket으로 승격한다

### Tickets

- 실행 가능한 기술 워크플로
- 기본 단계는 `analyze -> plan -> implement -> verify -> review -> ready`
- category에 따라 단계 구성이 조금 달라질 수 있다
- 구현 단계에서는 로컬 저장소와 `git worktree`, 검증 명령을 실제로 사용한다

### Incidents

- Ticket 실행 중 생긴 문제나 자동 복구 이슈를 추적한다
- tickets 권한이 있는 사용자만 본다

### Access

- 관리자 전용 권한/계정 관리 화면
- 계정, 세션, API token, 프로젝트 접근 범위를 관리한다

## 실제 실행 모델

이 프로젝트는 정적 문서 생성기가 아니라 `로컬 저장소를 직접 읽고 다루는 서버`다.

- 서버는 로컬 git 저장소를 직접 읽는다
- 검증 명령은 서버가 로컬에서 실행한다
- ticket 구현 단계에서는 `git worktree`를 사용한다
- 저장소 검색에는 `rg`가 필요하다
- 상태는 파일 시스템에 저장된다

즉, 이 프로젝트를 이해할 때는 "웹 UI가 붙은 로컬 개발 운영 도구"로 보는 편이 정확하다.

## 인증 모델

기본 원칙은 아래와 같다.

- 인증이 전혀 없으면 서버는 기본적으로 시작되지 않는다
- 예외적으로 `INTENTLANE_CODEX_ALLOW_OPEN_ACCESS=1`을 두면 로컬 개발용 open access로 띄울 수 있다
- 공유 환경에서는 open access를 쓰지 않는 것이 맞다

권장 첫 실행 순서:

1. `.env`에 bootstrap root 계정 정보를 넣는다
2. `pnpm dev` 또는 `pnpm start`로 서버를 띄운다
3. 브라우저에서 root 계정으로 로그인한다
4. 비밀번호 변경이 요구되면 먼저 바꾼다
5. `Access` 화면에서 일반 사용자 계정이나 토큰을 만든다

### `APP_SHARED_TOKEN`에 대한 주의

`APP_SHARED_TOKEN`은 지원되지만, 기본 브라우저 로그인 화면은 bearer token 입력 UI를 제공하지 않는다.

- 즉, `APP_SHARED_TOKEN`만 설정해 두고 일반 브라우저 로그인 흐름을 기대하면 막힐 수 있다
- 이 값은 API 클라이언트, 자동화, 고급 운영 경로에 더 가깝다
- 브라우저에서 정상적인 첫 진입을 하려면 bootstrap root 계정 방식이 가장 단순하다

인증 적용 후 공개 경로:

- `/api/health`
- `/api/access/login`

비밀번호 변경 강제 상태에서 추가 허용 경로:

- `/api/config`
- `/api/access/logout`
- `/api/access/me/password`

## 환경변수

`.env.example`이 기본 템플릿이다. 서버 시작 경로인 `pnpm dev`, `pnpm dev:server`, `pnpm dev:worker`, `pnpm start`는 루트 `.env`를 자동 로드한다.

### 필수에 가까운 값

- `HOST`
  API 및 배포형 앱 바인딩 호스트. 기본값은 `0.0.0.0`
- `PORT`
  API 및 배포형 앱 포트. 기본값은 `3001`
- `INTENTLANE_CODEX_BOOTSTRAP_ROOT_ENABLED`
  첫 기동 시 root admin 자동 생성을 켠다
- `INTENTLANE_CODEX_BOOTSTRAP_ROOT_NAME`
  bootstrap할 관리자 계정 이름
- `INTENTLANE_CODEX_BOOTSTRAP_ROOT_PASSWORD`
  bootstrap 관리자 비밀번호

### 권장 값

- `INTENTLANE_CODEX_DATA_DIR`
  `tickets`, `client-requests`, `incidents`, `background-runs`, `explain`, `direct-sessions`, `access-control.json`, `runtime.settings.json`의 저장 루트를 바꾼다
- `APP_ALLOWED_ORIGINS`
  별도 origin의 웹 UI를 붙일 때만 CORS 허용 origin을 설정한다

### 선택 값

- `APP_SHARED_TOKEN`
  공용 관리자 bearer token
- `INTENTLANE_CODEX_RUNTIME_SETTINGS_PATH`
  runtime project/model 설정 파일 경로 override
- `INTENTLANE_CODEX_ALLOW_OPEN_ACCESS`
  로컬 개발 전용 open access escape hatch

## 프로젝트와 상태 저장

기본 내장 프로젝트는 현재 저장소 루트 `.`이다.

- `flows.config.json`의 `defaultProjectId`는 `intentlane-codex`
- 처음 실행하면 이 저장소 자체를 기본 프로젝트로 사용한다
- 다른 로컬 저장소는 runtime project로 추가 등록할 수 있다
- WSL이나 headless 환경에서 네이티브 폴더 picker가 실패하면 수동 경로 입력을 쓰면 된다

런타임 상태는 아래 경로들에 저장될 수 있다.

- `tickets/`
- `client-requests/`
- `incidents/`
- `background-runs/`
- `explain/`
- `direct-sessions/`
- `access-control.json`
- `runtime.settings.json`

중요:

- 이 파일들은 소스 코드가 아니라 런타임 상태다
- 직접 hand-edit하기보다 앱 동작으로 생성되게 두는 편이 안전하다
- 개발/테스트/운영 데이터를 분리하려면 `INTENTLANE_CODEX_DATA_DIR`를 쓰는 것이 맞다

## LLM / agent용 repo map

LLM이 이 저장소를 읽을 때 먼저 보면 좋은 경로는 아래다.

### 핵심 파일

- `AGENTS.md`
  이 저장소에서 지켜야 할 작업 규약
- `flows.config.json`
  프로젝트 목록, verification 명령, Explain/Request/Ticket 흐름 설정
- `prompts/`
  Explain, Request, Ticket 단계 프롬프트

### 프론트엔드

- `src/web`
  Vite + React UI
- `src/web/components`
  주요 화면 컴포넌트
- `src/web/lib/api.ts`
  브라우저 API 클라이언트와 public payload 타입

### 서버

- `src/server/routes`
  얇은 HTTP/SSE 진입점
- `src/server/services`
  실제 비즈니스 로직과 orchestration
- `src/server/lib`
  설정, 인증, 프로젝트, 런타임 경로, 모델 capability 같은 기반 유틸

이 프로젝트에서는 `flows.config.json`과 `prompts/`를 단순 설정이 아니라 제품 동작의 일부로 봐야 한다.

## Request 작성 규칙

좋은 Request는 아래처럼 사용자 관점으로 쓴다.

- `Problem`
  왜 이 변경이 필요한가
- `Desired Outcome`
  사용자 입장에서 어떤 결과를 원하는가
- `User Scenarios`
  대표 사용자 흐름이 무엇인가
- 필요하면 `Constraints`, `Non-goals`, `Open questions`

피하는 편이 좋은 내용:

- 어떤 파일을 수정해야 하는지
- 어떤 함수명이나 클래스명을 써야 하는지
- 어떤 검증 명령을 돌릴지

그런 기술 세부사항은 Ticket 단계에서 다루는 것이 맞다.

## 주요 명령

모든 명령은 저장소 루트에서 실행한다.

### 개발

```bash
pnpm dev
pnpm dev:server
pnpm dev:worker
pnpm dev:web
```

### 검증과 빌드

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

단일 서버 테스트 파일 실행 예시:

```bash
tmpdir=$(mktemp -d) && INTENTLANE_CODEX_DATA_DIR="$tmpdir" INTENTLANE_CODEX_SKIP_ENV_FILE=1 node --import tsx --test src/server/tests/app.test.ts; status=$?; rm -rf "$tmpdir"; exit $status
```

## 유지보수 메모

기본 verification 명령은 `flows.config.json`에 정의되어 있다.

- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

`Explain` 모델 목록은 서버에서 정적으로 관리한다. 모델 갱신 시에는 아래를 같이 본다.

1. `~/.codex/models_cache.json`
2. `src/server/lib/model-capabilities.ts`
3. `flows.config.json`
4. 관련 테스트 기대값

보조 링크:

- Models docs: <https://developers.openai.com/api/docs/models>
- Latest model guide: <https://platform.openai.com/docs/guides/latest-model>
