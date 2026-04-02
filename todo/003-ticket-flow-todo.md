# 003. Ticket Flow TODO

## 목적

이 문서는 현재 ticket flow를 `배포 자동화 없이` 더 명확하고 안전하게 운영하기 위한 수정 TODO를 정리한 문서다.

여기서 말하는 목표는 아래와 같다.

- ticket를 만들면 자동으로 분석과 계획까지는 진행한다.
- 구현 전에 사람이 개입해야 하는 지점을 분명히 한다.
- 구현 완료 후에는 검증 결과와 리뷰 결과를 사용자에게 충분히 보여준다.
- `completed`가 배포 완료처럼 보이지 않도록 상태 의미를 정리한다.
- 공유 `dev` 환경 배포는 ticket flow에 넣지 않는다.

## 현재 flow 요약

현재 구현 흐름은 사실상 아래와 같다.

1. ticket 생성
2. `analyze`
3. `analyze_review`
4. `plan`
5. `plan_review`
6. `implement`
7. `verify`
8. `review`
9. `ready`
10. 사용자 `merge` 또는 `discard`

장점도 있다.

- `git worktree`로 작업 공간이 분리된다.
- 검증 명령은 서버가 직접 실행한다.
- 검증 실패나 리뷰 실패 시 자동 재시도 루프가 있다.
- merge 전에 base branch, base commit, reviewed head를 다시 확인한다.

하지만 운영 의미가 모호한 부분도 있다.

- `Approve` 단계가 설정에는 있지만 실제 gate로 작동하지 않는다.
- `completed`는 배포 완료가 아니라 로컬 merge 완료에 가깝다.
- 사용자에게 보여주는 결과가 `최종 보고서` 중심이라 handoff 단계가 약하다.
- direct merge 구조라 사람 책임 구간이 UI에 명확히 드러나지 않는다.

## 결정 사항

이번 정리에서 먼저 확정할 방향은 아래와 같다.

1. `dev`, `staging`, `prod` 배포는 ticket flow에 넣지 않는다.
2. ticket flow의 종료점은 `배포`가 아니라 `merge handoff` 또는 `merge 완료`다.
3. 구현 전 승인과 merge 전 사람 판단은 분리해서 본다.
4. 공유 환경 충돌을 피하기 위해 환경 배포 상태는 ticket 성공 조건에서 제외한다.

## 목표 flow

권장 flow는 아래처럼 잡는 것이 좋다.

1. `created`
2. `analyze`
3. `analyze_review`
4. `plan`
5. `plan_review`
6. `awaiting_approval`
7. `implement`
8. `verify`
9. `review`
10. `ready_for_merge`
11. `merged` 또는 `discarded`

핵심 차이는 두 가지다.

- `plan_review` 통과 후 바로 구현하지 않고 명시적으로 승인 대기 상태에 들어간다.
- `completed` 대신 실제 의미가 드러나는 상태명을 사용한다.

## TODO

### 1. `Approve`를 실제 gate로 연결

현재 `Approve` step은 설정과 일부 helper만 있고 실제 flow에서는 사용되지 않는다.

해야 할 일:

- `plan_review`가 `pass`이면 자동으로 `approve` step을 `awaiting_approval` 상태로 전환
- 사용자가 `Approve` 또는 `Reject`를 누를 수 있는 API 추가
- 승인 전에는 `implement` 진입 금지
- 거절 시 `plan`부터 다시 시작할지, `analyze`부터 다시 시작할지 정책 명확화

권장 정책:

- 기본은 `plan`부터 재작성
- 분석 자체가 틀린 경우에만 수동으로 `analyze` 재시작

관련 파일:

- `flows.config.json`
- `src/server/services/ticket-orchestrator.ts`
- `src/server/services/tickets.ts`
- `src/server/routes/tickets.ts`
- `src/web/components/TicketView.tsx`
- `src/web/components/ApprovalBar.tsx`

### 2. 상태 이름을 운영 의미에 맞게 정리

현재 `completed`는 배포 완료처럼 보이기 쉽다.

해야 할 일:

- `awaiting_merge`는 유지하거나 `ready_for_merge`로 바꾸기
- merge 성공 후 상태를 `merged`로 분리
- 필요하면 `runState`와 `status`를 역할별로 다시 정의
- UI 문구에서 `complete`, `done`이 배포 완료처럼 읽히지 않도록 수정

권장 방향:

- 사용자에게 보이는 주 상태는 `created`, `running`, `blocked`, `ready_for_merge`, `merged`, `discarded`, `failed`
- 내부 세부 phase는 `currentPhase`로 유지

### 3. 최종 handoff를 더 명확히 만들기

현재는 `Final Report`가 있지만 실제 사용자 관점에서는 "무엇을 보면 merge 판단이 가능한지"가 약하다.

해야 할 일:

- `ready` 출력에 아래 항목을 고정 섹션으로 포함
- 변경 파일 요약
- 검증 결과 요약
- 블로킹 이슈 여부
- 잔여 리스크
- merge 판단 포인트
- 수동 확인 방법

권장 추가 항목:

- "이 ticket는 배포를 수행하지 않음"
- "공유 dev 환경 반영은 별도 수동 절차"
- "merge 후 확인해야 할 항목"

### 4. direct merge와 manual handoff의 경계를 명확히 하기

지금 구조는 UI에서 바로 merge를 눌러 main에 fast-forward merge한다.

이 구조를 유지할 수도 있지만, 최소한 책임 경계는 더 분명해야 한다.

해야 할 일:

- merge 버튼 문구를 `Merge To Base Branch`처럼 더 구체화
- merge 전 확인 문구에 `배포는 수행되지 않음` 명시
- merge 이후 timeline에 `merged locally` 또는 이에 준하는 이벤트 기록

추가 검토:

- 장기적으로는 direct merge 대신 `manual handoff only` 또는 `PR 생성`으로 바꿀지 판단
- 다만 지금 우선순위는 구조 변경보다 상태 의미 정리다

### 5. retry 정책을 approval flow와 맞추기

승인 단계가 실제로 들어오면 retry 시작점도 달라져야 한다.

해야 할 일:

- `approve`에서 reject된 ticket의 retry 시작 지점 정의
- `implement` 실패 후 retry 시 승인 상태를 유지할지 초기화할지 결정
- `review` 실패 후 retry 시 `approve`로 되돌릴지 `implement`만 다시 돌릴지 결정

권장 정책:

- `implement` 이후 실패는 같은 승인 계획 범위 안에서 `implement`부터 retry
- `approve` 거절은 `plan`으로 복귀

### 6. UI에서 "현재 어디까지 자동인지"를 분명히 보여주기

사용자가 헷갈리는 지점은 대부분 상태명보다 자동/수동 경계다.

해야 할 일:

- step별로 `automatic` 또는 `manual` 배지 표시
- `awaiting_approval` 상태에서 상단 고정 액션 표시
- `awaiting_merge` 상태에서 merge/discard 의미를 더 구체적으로 설명
- `dev 배포 없음`을 티켓 화면에 명시

### 7. 문서와 실제 구현 간 불일치 정리

현재 일부 문서는 `Approve`가 있는 이상적인 플로우를 설명하지만 실제 구현은 다르다.

해야 할 일:

- 이 폴더 문서들이 실제 동작 기준인지 목표 상태 기준인지 명확히 표기
- `001`은 개념/방향 문서
- `002`는 현재 구현 리뷰 문서
- `003`은 수정 TODO 문서로 역할 분리

## 구현 순서 제안

가장 무난한 작업 순서는 아래와 같다.

1. 상태 이름과 UI 문구 정리
2. `approve` 실제 gate 연결
3. approve/reject API와 UI 연결
4. final handoff 보고서 강화
5. retry 정책 보정
6. 필요하면 마지막에 direct merge 구조 재검토

## 완료 조건

아래가 만족되면 이번 flow 정리는 1차 완료로 본다.

- 사용자가 `plan_review` 통과 후 구현이 자동 시작되지 않는다고 명확히 이해할 수 있다.
- 티켓이 `merged`여도 배포 완료로 오해되지 않는다.
- 티켓 화면만 보고 자동 단계와 수동 단계가 구분된다.
- `dev` 배포를 flow에 넣지 않는 정책이 문서와 UI에 반영된다.
- retry와 reject 동작이 단계 의미와 충돌하지 않는다.

## 이번 범위에서 하지 않을 것

아래 항목은 이번 문서 범위에서는 제외한다.

- `dev` 자동 배포
- `staging` 또는 `prod` 배포
- post-deploy health check
- canary, blue-green, rollback automation

이 항목들은 shared environment 운영 정책이 먼저 정해진 뒤에 별도 문서로 다루는 편이 맞다.
