# 002. Git Worktree Review

## 목적

이 문서는 현재 티켓 실행 흐름에서 `git worktree`가 어떻게 생성되고 관리되는지 정리하고, 운영 전에 리뷰가 필요한 지점을 따로 뽑아두기 위한 메모다.

관련 구현은 주로 아래 파일에 있다.

- `src/server/services/ticket-orchestrator.ts`
- `src/server/services/ticket-runner.ts`
- `src/server/services/tickets.ts`

## 현재 동작 요약

현재 구조는 `ticket마다 worktree를 하나 분리`해서 구현 작업을 수행하는 방식이다.

- 티켓이 `implement` 단계에 들어갈 때 worktree가 필요해진다.
- worktree는 메인 저장소에서 직접 수정하지 않고, 별도 브랜치 + 별도 디렉터리에서 작업하도록 만든다.
- `merge` 시점까지 메인 브랜치에는 변경이 반영되지 않는다.
- 최종 반영은 review 완료 후 `git merge --ff-only`로 수행한다.

즉, 방향 자체는 안전한 편이다.  
메인 워킹트리를 더럽히지 않고, ticket 단위로 격리하며, merge 직전 reviewed head를 다시 확인하는 점은 좋다.

## 생성 방식

worktree 생성은 `ensureWorktree()`에서 담당한다.

- worktree root: `resolve(ticket.projectPath, '..', '.intentlane-codex-worktrees')`
- base branch: `git branch --show-current`
- base commit: `git rev-parse HEAD`
- branch name: `tickets/<ticket-id-lower>-attempt-<n>`
- worktree path: `.intentlane-codex-worktrees/<ticket-id-lower>-attempt-<n>`

실제 생성 명령은 아래와 같다.

```bash
git worktree add -b "<branchName>" "<worktreePath>" "<baseBranch>"
```

생성 직후 ticket에는 아래 정보가 저장된다.

- `branchName`
- `baseBranch`
- `baseCommit`
- `worktreePath`
- `status = pending`
- `createdAt`, `updatedAt`

이 정보는 `tickets/<id>.json`에 저장되고, markdown 보고서에도 같이 남는다.

## 재사용 방식

중요한 점은 현재 구현이 `implement attempt마다 새 worktree를 만드는 구조는 아니라는 것`이다.

`ensureWorktree()`는 아래 조건이면 기존 worktree를 그대로 재사용한다.

- `ticket.worktree`가 이미 존재하고
- `ticket.worktree.worktreePath`가 실제 디스크에 존재할 때

즉:

- 같은 ticket 실행 중 `implement 1회 -> verify fail -> implement 2회`가 되더라도
- 새 branch/worktree를 만들지 않고
- 처음 만든 같은 worktree에서 계속 수정이 누적된다.

현재 attempt 번호는 `worktree 이름 힌트` 역할에 가깝고, 실제로는 첫 생성 이후 계속 같은 worktree를 쓸 수 있다.

## 상태 관리

worktree 상태는 ticket 내부 필드로 관리된다.

- `pending`: 생성됨, 아직 최종 요약 전
- `ready`: review 통과 후 head/diff summary가 캡처됨
- `merged`: 메인 브랜치에 반영됨
- `discarded`: 버리기로 결정됨

`ready` 진입 시점에는 아래 정보가 추가로 저장된다.

- `headCommit`
- `diffSummary`

이 값은 `captureWorktreeSummary()`에서 수집한다.

## merge / discard 방식

### Merge

`mergeTicketWorktree()`는 바로 merge하지 않고 먼저 reviewed head가 바뀌지 않았는지 검사한다.

- 현재 worktree HEAD: `git rev-parse HEAD`
- 저장된 `ticket.worktree.headCommit`와 비교
- 다르면 merge 중단

그 다음 아래 명령으로 fast-forward merge만 허용한다.

```bash
git merge --ff-only "<worktree-branch>"
```

성공하면:

- `mergeCommit` 기록
- worktree 상태를 `merged`로 변경
- ticket 상태를 `completed`로 변경
- 이후 worktree와 branch를 정리한다

### Discard

`discardTicketWorktree()`는 merge 없이 상태를 `discarded`로 바꾸고 정리만 수행한다.

## 정리 방식

정리는 `cleanupWorktree()`가 담당한다.

실제 명령은 아래 두 개다.

```bash
git worktree remove --force "<worktreePath>"
git branch -D "<branchName>"
```

즉:

- 디렉터리를 제거하고
- 대응되는 작업 브랜치도 삭제한다

`destroyTicketWorktree()`는 정리가 끝난 뒤 ticket의 `worktree` 메타데이터도 제거한다.

## retry / recovery와의 관계

### Retry

`retryTicketRun()`은 마지막으로 통과한 stage review를 기준으로 재시작 지점을 고른다.

- `plan` review pass 상태면 `implement`부터 재시작
- `analyze` review pass 상태면 `plan`부터 재시작
- 아니면 `analyze`부터 재시작

이때 기존 worktree가 있고 상태가 `merged`/`discarded`가 아니면 먼저 정리한다.

즉, `Retry`는 대체로 기존 작업 트리를 지우고 안전 지점부터 다시 시작하는 쪽에 가깝다.

### 서버 재시작 복구

서버 시작 시 `markRecoverableTicketsFromStartup()`가 실행된다.

- 기존 상태가 `queued` 또는 `running`이던 ticket은
- 자동으로 `failed` + `recoveryRequired = true`가 된다
- 작업은 자동 재개하지 않는다
- 사용자가 `Retry`를 눌러야 다시 진행된다

이 방식은 보수적이라 안전하지만, 중간 실행을 이어서 붙이지는 않는다.

## 외부 노출 범위

내부 ticket 상태에는 `worktreePath`가 저장된다.  
다만 브라우저로 보내는 public ticket 응답에서는 `PublicTicketWorktree`로 변환하면서 `worktreePath`를 제외한다.

즉:

- 서버 내부/디스크에는 실제 경로가 남는다
- 브라우저 API에는 로컬 파일 시스템 경로를 노출하지 않는다

이 점은 현재 구현에서 괜찮은 부분이다.

## 현재 설계의 장점

- 티켓별로 작업 공간이 분리되어 동시 작업 충돌을 줄인다.
- 메인 워킹트리를 직접 수정하지 않으므로 운영 안전성이 높다.
- merge 전에 reviewed head와 현재 head를 비교해 review 이후 임의 변경을 막는다.
- merge를 `--ff-only`로 제한해 예기치 않은 merge commit을 방지한다.
- 브라우저 응답에서 `worktreePath`를 숨겨 경로 노출을 줄인다.

## 리뷰가 필요한 부분

아래 항목은 현재 코드가 틀렸다는 뜻이 아니라, 운영 전에 의도를 확정해야 하는 지점이다.

### 1. attempt별 격리가 아니라 ticket별 단일 worktree 재사용 구조다

현재는 같은 ticket 실행 안의 재시도들이 같은 worktree를 재사용한다.

영향:

- `implement 2회`, `implement 3회` 수정이 같은 브랜치에 누적된다
- attempt별 diff를 독립적으로 비교하기 어렵다
- 실패한 수정이 다음 attempt의 바탕이 된다

리뷰 질문:

- 이 동작이 의도인가
- 아니면 implement attempt마다 새 worktree/branch를 만들어야 하는가

### 2. worktree 이름의 `attempt`는 실제 이력과 항상 일치하지 않는다

처음 생성된 worktree가 계속 재사용되면 branch 이름이 `attempt-1`이어도 내부 변경은 여러 attempt를 포함할 수 있다.

리뷰 질문:

- branch/path 이름이 실제 attempt 이력을 반영해야 하는가
- 아니면 단순 ticket session 식별자면 충분한가

### 3. 정리 실패 시 부분 정리 상태가 남을 수 있다

정리 과정은 `worktree remove` 후 `branch -D` 순서다.  
둘 중 하나라도 실패하면 에러를 던진다.

영향:

- 디렉터리는 지워졌는데 branch가 남을 수 있다
- branch는 지워졌는데 메타데이터 정리가 덜 끝날 수도 있다
- 이후 같은 이름으로 다시 만들 때 충돌할 수 있다

리뷰 질문:

- 부분 실패를 별도 상태로 저장할지
- 운영자용 cleanup 명령이나 진단 화면이 필요한지

### 4. 서버 재시작 후 orphan worktree/branch 청소는 하지 않는다

현재는 ticket 상태만 `failed + recoveryRequired`로 바꾼다.  
디스크의 `.intentlane-codex-worktrees` 아래를 스캔해서 orphan을 수거하지는 않는다.

리뷰 질문:

- startup 시 orphan worktree/branch sweep가 필요한가
- 아니면 수동 운영 절차로 남겨둘 것인가

### 5. 실행 lock은 메모리 내 단일 프로세스 기준이다

`activeRuns`는 메모리 `Map`이다.

의미:

- 단일 서버 프로세스에서는 ticket 중복 실행을 잘 막는다
- 여러 서버 인스턴스를 동시에 띄우는 구조에서는 충분하지 않다

리뷰 질문:

- 이 앱을 단일 프로세스로만 운영할 것인가
- 멀티 인스턴스 가능성이 있으면 외부 lock이 필요한가

### 6. worktree 생성 위치가 repo 내부가 아니라 형제 디렉터리다

현재 경로는 `projectPath/../.intentlane-codex-worktrees`다.

장점:

- 메인 repo 내부를 덜 어지럽힌다

검토 포인트:

- 디스크 권한
- 백업 정책
- 여러 프로젝트가 같은 상위 디렉터리를 공유할 때의 관리성

리뷰 질문:

- 이 위치가 운영 환경에서 항상 안전한가
- 프로젝트별 별도 worktree root 설정이 필요한가

### 7. detached HEAD 환경 검토가 필요하다

base branch는 `git branch --show-current` 결과를 쓰고, 없으면 `HEAD`를 쓴다.

리뷰 질문:

- detached HEAD 상태에서 티켓 실행을 허용할지
- 아니면 명시적으로 차단하고 브랜치 체크아웃을 강제할지

### 8. retry 전에 남은 변경을 보존할지 정책이 필요하다

현재 `Retry`는 보통 기존 worktree를 정리하고 다시 시작한다.  
이 방식은 안전하지만, 실패한 attempt의 실제 파일 상태를 오래 보존하지는 않는다.

리뷰 질문:

- 실패한 구현 결과를 따로 archive할 필요가 있는가
- 아니면 timeline + diff summary만 있으면 충분한가

### 9. 수동 개입이 있었을 때의 검증이 약하다

운영자가 worktree 안에서 직접 커밋하거나 브랜치를 바꾸는 경우를 강하게 검증하지는 않는다.

현재는 merge 직전 `headCommit` 비교는 하지만, 아래 항목까지는 보장하지 않는다.

- branch가 여전히 기대한 base에서 출발했는지
- worktree 설정 자체가 외부에서 바뀌지 않았는지

리뷰 질문:

- 수동 개입을 금지 전제로 둘 것인가
- 아니면 merge 전 추가 무결성 검사를 넣을 것인가

## 권장 판단

현재 목적이 `ticket별 안전한 격리`라면 지금 구조는 실용적이다.  
다만 아래 3개는 운영 전에 결정하는 편이 좋다.

1. implement 재시도마다 새 worktree를 만들지, 같은 worktree를 계속 쓸지
2. orphan/partial-cleanup 상황을 자동 정리할지, 운영 절차로 처리할지
3. 단일 프로세스 운영만 허용할지, 멀티 인스턴스까지 고려할지

## 결론

현재 구현은 `ticket 단위 worktree 분리`, `merge 전 head 확인`, `ff-only merge`, `retry 시 정리 후 재실행`이라는 점에서 기본 안전성은 괜찮다.

가장 큰 리뷰 포인트는 이것이다.

- 지금 구조는 `attempt별 worktree 분리`가 아니라 `ticket별 worktree 재사용`이다

이게 의도라면 문서화만 하면 되고, 의도가 아니라면 여기부터 설계를 조정하는 것이 맞다.
