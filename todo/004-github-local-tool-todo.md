# 004. GitHub Local Tool TODO

## 목적

이 문서는 이 저장소를 `원격 배포 서비스`가 아니라 `GitHub에서 내려받아 로컬에서 실행하는 도구`로 정리하기 위한 실행 TODO를 모아둔 문서다.

이번 정리의 목표는 아래와 같다.

- 사용자별 WSL 절대경로 없이 clone 위치가 달라도 실행된다.
- `pnpm start`만으로 API가 아니라 웹 UI까지 바로 열린다.
- GitHub 공개 기준으로 필요한 실행 조건과 환경변수가 문서화된다.
- 테스트가 특정 개발자 머신 경로에 의존하지 않는다.
- 지원 범위와 비지원 범위가 README에 명확히 적힌다.

## 현재 문제 요약

지금 구조는 로컬 툴 방향 자체는 맞지만, 공개 저장소로 쓰기에는 몇 가지가 막혀 있다.

- `flows.config.json`에 `/home/gyu/...` 절대경로가 들어가 있다.
- `pnpm start`는 서버만 띄우고 `dist/web`를 서빙하지 않는다.
- README가 개발자 로컬 기준으로 쓰여 있고 일부 절대경로 링크가 들어 있다.
- 실제 실행 필수 도구인 `git`, `rg`, Codex/OpenAI 인증 준비가 README에 충분히 드러나지 않는다.
- `project-browser` 테스트가 현재 워크스페이스 절대경로에 묶여 있다.

## 결정 사항

이번 작업에서 먼저 확정할 방향은 아래와 같다.

1. 배포 목표는 `GitHub 공개 + 각자 로컬 실행`이다.
2. 공식 지원 환경은 `Linux`, `macOS`, `Windows는 WSL2`로 잡는다.
3. native Windows 보장은 이번 범위에서 하지 않는다.
4. 기본 내장 프로젝트는 빈 상태 온보딩이 아니라 현재 저장소 루트 `.`를 사용한다.
5. `pnpm dev`는 유지하고, `pnpm build && pnpm start`를 로컬 배포형 실행 경로로 추가 정리한다.
6. JSON API 스키마, ticket/request 저장 포맷, flow 자체는 이번 범위에서 바꾸지 않는다.

## TODO

### 1. 기본 프로젝트 경로를 이식 가능하게 변경

해야 할 일:

- `flows.config.json`의 기본 프로젝트 `path`를 절대경로 대신 `.`으로 변경
- 기존 verification 명령과 flow 설정은 그대로 유지
- README에 기본 프로젝트가 "현재 이 저장소"라는 점과 다른 저장소는 runtime project로 추가하는 흐름 설명

관련 파일:

- `flows.config.json`
- `README.md`

### 2. `pnpm start`에서 정적 웹까지 함께 서빙

해야 할 일:

- 서버 조립 로직을 재사용 가능한 앱 팩토리로 분리
- `/api/*` 라우트는 그대로 유지
- 비 API 요청은 `dist/web` 정적 파일을 서빙
- 정적 파일이 없는 비 API `GET/HEAD`는 `index.html` fallback으로 처리
- 인증 미들웨어는 계속 `/api/*`에만 적용

권장 방향:

- 개발 모드 주소는 그대로 `5173`/`3001`
- 프로덕션성 로컬 실행은 `3001` 단일 진입점
- 이번 패스에서는 `PORT` 환경변수 지원은 넣지 않음

관련 파일:

- `src/server/index.ts`
- 서버 앱 조립 모듈
- `package.json`

### 3. GitHub 공개용 `.env.example` 추가

해야 할 일:

- `.env.example` 생성
- `APP_SHARED_TOKEN`를 optional 항목으로 설명
- `INTENTLANE_CODEX_RUNTIME_SETTINGS_PATH`를 optional 항목으로 설명
- Codex/OpenAI 인증은 앱이 직접 별도 로드하지 않는다는 점을 README에서 설명

권장 방향:

- `.env.example`에는 앱이 직접 읽는 값만 넣기
- 비밀값 예시는 placeholder만 두고 실제 값은 넣지 않기

관련 파일:

- `.env.example`
- `README.md`

### 4. README를 로컬 툴 기준으로 재정리

해야 할 일:

- 설치 전제조건에 `Node`, `pnpm`, `git`, `rg` 추가
- Codex/OpenAI 인증 준비가 필요하다는 점 추가
- `pnpm dev`와 `pnpm build && pnpm start` 두 실행 경로를 분리해서 설명
- WSL/headless 환경에서는 네이티브 폴더 picker가 실패할 수 있으므로 수동 경로 입력이 정상이라는 점 명시
- 지원 범위: `Linux/macOS/WSL2`
- 비지원 또는 미보장 범위: `native Windows`
- README 내부의 `/home/gyu/...` 절대경로 링크를 repo-relative 경로나 인라인 코드로 교체

관련 파일:

- `README.md`

### 5. 머신 의존 테스트 제거와 정적 서빙 테스트 추가

해야 할 일:

- `project-browser.test.ts`에서 특정 사용자 경로 하드코딩 제거
- 임시 디렉터리 기반으로 basename/browse 동작 검증
- 서버 통합 테스트 추가
- `/` 요청 시 HTML 반환 검증
- 비 API fallback 검증
- `/api/health` JSON 응답 유지 검증
- `APP_SHARED_TOKEN` 설정 시 `/`는 열리고 `/api/*`만 보호되는지 검증

권장 방향:

- 정적 서빙 테스트용 fixture는 gitignored 경로에서 임시 생성 후 정리
- 테스트가 `dist/web` 실제 빌드 결과에 의존하지 않게 구성

관련 파일:

- `src/server/tests/project-browser.test.ts`
- 새 서버 통합 테스트 파일

## 구현 순서 제안

가장 무난한 작업 순서는 아래와 같다.

1. 기본 프로젝트 경로를 `.`으로 변경
2. 서버 앱 팩토리 분리와 정적 서빙 연결
3. `.env.example` 추가
4. README 재정리
5. 경로 이식성 테스트 수정
6. 정적 서빙/인증 경계 통합 테스트 추가
7. `pnpm typecheck`, `pnpm test`, `pnpm build`로 최종 검증

## 완료 조건

아래가 만족되면 이번 정리는 1차 완료로 본다.

- 다른 사용자가 임의 경로에 clone해도 `flows.config.json` 때문에 바로 깨지지 않는다.
- `pnpm build && pnpm start` 후 브라우저에서 앱 UI가 열린다.
- README만 보고 필요한 도구, 인증 준비, 실행 방법을 이해할 수 있다.
- 테스트가 `/home/gyu/...` 같은 개인 경로에 의존하지 않는다.
- 공개 저장소 문서에 로컬 절대경로 링크가 남아 있지 않다.

## 이번 범위에서 하지 않을 것

아래 항목은 이번 문서 범위에서는 제외한다.

- Dockerfile 또는 docker-compose 제공
- 설치 스크립트 제공
- native Windows 정식 지원
- 빈 프로젝트 온보딩 화면 추가
- DB 도입 또는 저장 포맷 변경
- 원격 SaaS 배포 시나리오 정리
