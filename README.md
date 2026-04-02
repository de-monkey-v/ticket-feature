# Intentlane

`Intentlane`은 Codex SDK 전용 로컬 웹 작업 도구다. 선택한 저장소를 읽어 `Explain` 흐름으로 코드를 이해하고, `Request -> Ticket` 흐름으로 요구사항을 실제 구현 워크플로까지 이어준다.

GitHub 저장소 slug, 패키지 이름, 기본 project id는 `intentlane-codex`를 사용한다.

주요 흐름은 두 가지다.

1. `Explain`
   현재 선택한 저장소를 읽으면서 코드 동작을 질문하고 이해를 돕는다.
2. `Request -> Ticket`
   사용자 관점 요청을 정리한 뒤, 티켓으로 넘겨 분석, 계획, 구현, 검증, 리뷰 흐름으로 이어진다.

## Supported environments

공식 지원 범위는 아래로 잡는다.

- Linux
- macOS
- Windows + WSL2

`native Windows`는 이번 저장소 기준으로 정식 보장하지 않는다.  
모든 명령은 저장소 루트에서 실행하는 것을 전제로 한다.

## Prerequisites

아래 도구가 로컬에 준비되어 있어야 한다.

- Node.js
- pnpm
- git
- ripgrep (`rg`)

추가로, 이 프로젝트는 Codex/OpenAI 인증이 이미 로컬 환경에 준비되어 있다는 전제로 동작한다.

- 이 저장소가 별도 인증 UI를 제공하지는 않는다.
- 필요한 인증 방식은 사용 중인 Codex/OpenAI 로컬 설정을 그대로 따른다.

## Install

```bash
git clone <your-fork-or-this-repo>
cd intentlane-codex
pnpm install
```

## Environment variables

서버 시작점 `pnpm dev`, `pnpm dev:server`, `pnpm start`는 루트의 `.env`를 자동 로드한다.  
기본 템플릿은 `.env.example`에 있고, 이 저장소에는 바로 실행 가능한 `.env`도 함께 둘 수 있다.

운영에 자주 쓰는 값은 아래다.

- `HOST`
  기본값은 `0.0.0.0`이며 외부 접속을 받는다.
- `PORT`
  API 및 빌드된 웹 앱 포트다.
- `INTENTLANE_CODEX_BOOTSTRAP_ROOT_ENABLED`
  첫 기동 시 루트 관리자 계정 자동 생성을 켠다.
- `INTENTLANE_CODEX_BOOTSTRAP_ROOT_NAME`
  부트스트랩할 관리자 계정 이름이다.
- `INTENTLANE_CODEX_BOOTSTRAP_ROOT_PASSWORD`
  부트스트랩 관리자 비밀번호다.
- `APP_SHARED_TOKEN`
  공용 관리자 Bearer 토큰이다. 여러 사용자가 붙는 환경에서는 비권장이다.
- `APP_ALLOWED_ORIGINS`
  별도 origin에서 웹 UI를 붙일 때만 CORS 허용 origin을 넣는다.
- `INTENTLANE_CODEX_DATA_DIR`
  `tickets`, `client-requests`, `incidents`, `access-control.json`, `runtime.settings.json`의 기본 저장 루트를 한 번에 바꾼다. 개발/운영 데이터 분리에 권장한다.
- `INTENTLANE_CODEX_RUNTIME_SETTINGS_PATH`
  런타임 프로젝트 목록과 모델 선택값을 저장할 파일 경로를 바꾼다.
- `INTENTLANE_CODEX_ALLOW_OPEN_ACCESS`
  로컬 단독 개발용 예외다. 공유 환경에서는 비워 둔다.

## Run in development

개발 모드에서는 서버와 웹 UI를 따로 띄운다.

```bash
pnpm dev
```

기본 주소:

- Web UI: `http://localhost:5173/`
- API server: `http://localhost:3001/`
- Health check: `http://localhost:3001/api/health`

필요하면 아래처럼 따로 실행할 수도 있다.

```bash
pnpm dev:server
pnpm dev:web
```

`.env`를 만든 뒤에는 별도 export 없이 그대로 실행해도 된다.

개발 데이터를 저장소 루트 상태와 분리하고 싶으면 `.env`에 아래처럼 두면 된다.

```bash
INTENTLANE_CODEX_DATA_DIR=.local/dev-data
```

## Run as a local deployed app

`pnpm build && pnpm start`는 로컬 배포 형태에 가까운 실행 경로다.

```bash
pnpm build
pnpm start
```

이 경우 브라우저에서는 아래 주소만 열면 된다.

- App + API: `http://localhost:3001/`

`pnpm start`는 빌드된 `dist/web`를 함께 서빙한다.  
빌드 전에 `pnpm start`만 실행하면 웹 자산이 없다는 안내가 나온다.

여러 사용자가 내부망에서 접속할 때는 이 실행 경로를 권장한다.  
같은 origin에서 웹과 API를 함께 서빙하므로 CORS 설정이 단순하다.

## Auth behavior

서버는 인증이 설정되지 않으면 기본적으로 시작되지 않는다.

권장 방식은 아래 순서다.

1. `INTENTLANE_CODEX_BOOTSTRAP_ROOT_ENABLED=1`과 루트 비밀번호를 넣고 서버를 띄운다.
2. 웹 로그인으로 루트 관리자 계정에 접속한다.
3. UI에서 사용자별 계정을 만든다.

`APP_SHARED_TOKEN`을 설정하면 공용 관리자 Bearer 토큰으로도 접근할 수 있다.  
다만 여러 사용자가 함께 쓰는 환경에서는 사용자별 계정 방식이 더 안전하다.

인증이 적용되면:

- `/api/health`는 계속 인증 없이 접근 가능
- `/api/access/login`은 로그인용으로 계속 열려 있음
- 그 외 `/api/*`는 로그인 세션 또는 Bearer 토큰 필요

예시 헤더:

```text
Authorization: Bearer your-token
```

## Local state and generated files

로컬 실행 중 아래 경로에 상태 파일이 생성될 수 있다.

- `tickets/`
- `client-requests/`
- `incidents/`
- `background-runs/`
- `explain/`
- `direct-sessions/`
- `access-control.json`
- `runtime.settings.json`

`INTENTLANE_CODEX_DATA_DIR`를 설정하면 위 상태 파일들은 그 하위로 이동한다. 예를 들어 `.local/dev-data`를 주면 아래처럼 분리된다.

- `.local/dev-data/tickets/`
- `.local/dev-data/client-requests/`
- `.local/dev-data/incidents/`
- `.local/dev-data/background-runs/`
- `.local/dev-data/explain/`
- `.local/dev-data/direct-sessions/`
- `.local/dev-data/access-control.json`
- `.local/dev-data/runtime.settings.json`

이 경로들은 로컬 상태 저장용이다.  
직접 편집하기보다 앱 동작으로 생성되게 두는 편이 안전하다.

완전히 새로 시작하고 싶으면 위 상태 디렉터리와 상태 파일들을 비운 뒤 서버를 다시 띄우면 된다.

`pnpm test`는 실제 작업 데이터와 섞이지 않도록 매 실행마다 임시 데이터 디렉터리를 만들고 종료 시 정리한다.

## Project selection

기본 내장 프로젝트는 현재 저장소 루트 `.`이다.

- 처음 실행하면 이 저장소 자체를 기본 프로젝트로 사용한다.
- 다른 로컬 저장소를 추가하고 싶으면 앱에서 runtime project로 등록하면 된다.

WSL이나 headless 환경에서는 네이티브 폴더 picker가 실패할 수 있다.  
이 경우 수동으로 경로를 입력하는 것이 정상 동작이다.

## Recommended usage flow

가장 안정적인 사용 순서는 아래와 같다.

1. `Explain`에서 현재 코드와 바꾸고 싶은 점을 정리한다.
2. `Request`를 사용자 관점 언어로 저장한다.
3. Request가 충분히 명확해지면 `Ticket`을 만든다.
4. Ticket이 분석, 계획, 구현, 검증, 리뷰 흐름을 진행한다.
5. merge 여부는 최종 보고와 검증 결과를 보고 사람이 결정한다.

핵심은 아래 한 줄이다.

> Request는 무엇을 원하는지, Ticket은 어떻게 만들지를 다룬다.

## Explain, Request, Ticket

### Explain

- 목적: 코드 이해와 요구사항 정리
- 질문 예시: "이 기능이 어떻게 동작해?", "이 변경을 하려면 영향 범위가 어디야?"

### Request

- 목적: 사용자 관점 요구사항 저장
- 기술 설계보다 문제, 원하는 결과, 사용자 시나리오 중심으로 작성

### Ticket

- 목적: 실행 가능한 기술 계획과 자동 실행
- 여기서부터 파일, 모듈, 검증 명령, 리스크 같은 기술 세부사항을 다룬다

## Request writing guidance

좋은 Request는 아래 요소를 포함한다.

- `Problem`
  왜 이 변경이 필요한가
- `Desired Outcome`
  사용자 입장에서 어떤 결과를 원하는가
- `User Scenarios`
  대표 사용자 흐름이 무엇인가
- 필요 시 `Constraints`, `Non-goals`, `Open questions`

피하는 것이 좋은 형태:

- 어떤 파일을 수정해야 하는지 적는 것
- 어떤 예외 클래스나 함수명을 써야 하는지 적는 것
- 어떤 테스트 명령을 돌릴지 적는 것

## Verification and tool expectations

현재 서버는 로컬 저장소를 직접 다루는 구조다.

- 검증 명령은 서버가 로컬에서 실행한다.
- 티켓 구현 단계에서는 `git worktree`를 사용한다.
- 저장소 검색에는 `rg`가 사용된다.

즉, 이 프로젝트는 정적 웹앱이 아니라 `로컬 git 저장소를 다루는 도구`로 생각하는 편이 맞다.

## Model maintenance

`Explain` 모드 모델 목록은 서버에서 정적으로 관리한다.

갱신 시에는 아래 순서를 따른다.

1. 로컬 Codex 런타임 캐시 `~/.codex/models_cache.json`의 `fetched_at`과 `models[*].slug`를 확인한다.
2. 최신 코딩 중심 모델 5개와 각 모델의 `default_reasoning_level`, `supported_reasoning_levels`를 기준으로 [`src/server/lib/model-capabilities.ts`](src/server/lib/model-capabilities.ts)를 갱신한다.
3. 기본 Explain 선택값이 바뀌면 [`flows.config.json`](flows.config.json)의 `flows.explain.model`과 `flows.explain.reasoningEffort`도 같이 맞춘다.
4. 브라우저 노출값 회귀를 위해 `pnpm typecheck`와 `pnpm test` 기준으로 테스트 기대값을 함께 갱신한다.

보조 확인 링크:

- Models docs: <https://developers.openai.com/api/docs/models>
- Latest model guide: <https://platform.openai.com/docs/guides/latest-model>
