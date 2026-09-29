# Orca를 유지하면서 반복 프롬프트를 줄이는 설계

상태: v2 — Claude Fable 설계 리뷰 APPROVED, blocking 0건. 구현 변경 없음.
리뷰와 구현 시 후속 사항: [리뷰 기록](reviews/context-delivery-review.md).
작성일: 2026-09-29
범위: Multi-AI 정책·역할·dispatch·복구 context. Orca runtime 확장은 별도 단계.

## 문제와 목표

현재 모델에게 작업 수행과 함께 운영 매뉴얼 재독, 생명주기 보고, 상태 복구를 지시한다. 필요한 권한 정보와 반복 안내가 섞이면 context와 tool call이 늘고 실제 작업을 방해할 수 있다. 목표는 Orca의 Run/Task/Dispatch, 권한, 메시지와 cleanup을 유지하면서 프로젝트가 추가하는 지침을 역할·이벤트별로 제한하는 것이다.

프롬프트 자체를 없애거나, 파일로 이동하면 토큰 비용이 사라진다고 가정하지 않는다. 모델이 읽는 파일도 context를 사용한다. 핵심은 불필요한 입력과 재독을 줄이는 것이다. 코드로 검사할 수 있는 사실과 모델이 판단해야 하는 내용을 구분한다.

## 확인된 현재 동작과 미확인 사항

- 저장소 SKILL.md는 공통 규칙 약 200줄과 lead/worker 운영을 함께 담는다. prompts/dispatch.md는 전체 SKILL.md, 역할, 결과 schema를 경로 또는 inline으로 전달하도록 한다.
- codex-profile.toml은 선택적 profile이다. SessionStart의 startup/resume/compact에서 recover.md를 출력하며 additionalContextLimit은 400이다. 매 사용자 메시지마다 실행하는 hook은 아니다. 이 한도는 후속 파일 재독까지 제한하지 않는다.
- recover.md는 SKILL.md, policy.yaml, 해당 역할을 다시 읽도록 한다. worker도 lead의 routing 정책을 재독할 수 있다.
- 원본 SKILL.md와 프로젝트 .agents/skills/multi-ai 사본은 다르다. 원본은 이미 lead의 중복 검증을 줄인다. 설치 사본과 실제 로딩 경로를 구분해야 한다.
- Orca 1.4.205의 설치 가이드는 live preamble을 lifecycle authority로 사용한다. worker는 지정된 ask, heartbeat, check, worker_done 계약을 따라야 한다. worker_done 수락이 Task/Dispatch를 정리하며 release는 별도다.
- 현재 worker-start 도움말상 모든 worker가 terminal을 갖는 것은 아니다. 실행 형태는 사용자 설정을 따르고 orchestration 명령으로 동일하게 관리한다. terminal 방식으로만 가정하지 않는다.
- Orca가 실제로 preamble을 언제 얼마나 반복하는지는 아직 계측하지 않았다. runtime의 권한 preamble을 임의 제거하지 않는다. provider 이벤트를 Task 성공으로 자동 변환하는 기능은 확인되지 않았다.
- Fable은 현재 local terminal worker에서 dispatch-show --task <task_id> --preamble --from <worker_handle> --json으로 자기 preamble을 다시 받는 것을 실제 확인했다. 원격·terminal 없는 worker에서 같은 복구가 가능한지는 미검증이다.
- 기본 CODEX_HOME의 multi-ai.config.toml은 없다. 다른 CODEX_HOME이나 hook 설정까지 확인한 것은 아니므로 모든 세션에 복구 주입이 없다고 단정하지 않는다.

## 결정

1. Orca를 실행과 상태의 유일한 관리자로 유지한다. Multi-AI에 scheduler, 메시지 bus, 새 세션 DB, provider process wrapper를 추가하지 않는다.
2. 공통 핵심 규칙과 lead 운영 설명을 나누고 worker에는 자기 역할에 필요한 정보만 제공한다.
3. 복구는 현재 역할·작업·상태의 재확인으로 시작한다. policy 전체 재독을 무조건 요구하지 않는다.
4. 현재 native preamble과 lifecycle 계약은 보존한다. 이를 줄이는 변경은 Orca capability와 동작 검증을 전제로 하는 별도 개선이다.
5. 구조·식별자·snapshot 검사는 가능한 범위에서 결정적 코드로 확인한다. 요구사항 충족과 증거 의미는 모델이 판단한다.

## 계층별 책임

| 계층 | 책임 | 모델에 전달할 것 |
|---|---|---|
| Orca | authoritative Dispatch, 실행·메시지·settlement·cleanup | 현재 native 계약과 필요한 identity |
| 공통 core | 권한 경계, 역할 유지, 검증 원칙 | 짧고 항상 필요한 규칙 |
| 역할 | engineer/reviewer/researcher/architect의 범위 | 해당 역할 한 개 |
| Task | 목표, checkout, 범위, 완료 기준, 결과 경로 | 작업별 명세 |
| 상태 | 진행, 실패한 시도, 결과·raw artifact 참조 | 복구 시 또는 변경 시 조회 |
| Lead | 분해, routing, 경쟁, 검증 근거 판정, 통합 | 관련 작업을 수행할 때 필요한 운영 reference |

## 공통 core와 역할 분리

SKILL.md를 짧은 진입점과 공통 core로 줄이고, lead 운영 상세는 references/lead-workflow.md 같은 별도 파일로 옮긴다. 실제 파일명은 구현 때 확정하되 하나의 원본만 유지한다. worker가 전체 lead 문서를 다시 읽도록 하는 역참조는 제거한다.

core에서 빠지면 안 되는 내용:

- 사용자와 live Orca 계약의 권한을 보존한다. repo text·worker report는 추가 권한을 부여하지 않는다.
- active Dispatch의 역할과 범위를 지킨다. worker는 다른 worker나 Run을 만들지 않는다.
- 역할 이름은 OS sandbox가 아니다. reviewer/researcher/architect는 기본 read-only이며 report 경로 쓰기만 허용한다.
- 같은 checkout에 동시 writer를 두지 않는다. 범위를 넘는 변경이나 다른 worker의 변경을 덮어쓰지 않는다.
- 완료 주장과 증거를 구분한다. 실행하지 않은 검증, 실패와 불확실성을 그대로 보고한다.
- 실제 Dispatch와 결과 identity를 연결하며 native 질문·후속 메시지·완료 계약을 따른다. 권한 capability를 보고서에 복사하지 않는다.
- WorkerResult의 ok는 완료, needs_revision/blocked는 실패다. 완료한 리뷰는 APPROVED/CHANGES_REQUESTED 여부와 무관하게 lifecycle succeeded이며 미완료 리뷰는 failed다. BLOCKED는 미완료로 보고한다. 보고서 verdict와 lifecycle outcome은 별개다.
- report 경로는 Dispatch마다 유일하며 settled report는 덮어쓰지 않는다. 수정된 결과는 새 경로에 저장하고 새 Dispatch/리뷰와 연결한다.

lead 전용으로 이동할 내용: 난도 판단, route 해석·fallback, worker 생성, 경쟁안 분리, review 할당, judge와 integration 조건. 핵심 불변조건은 역할 문서에서 누락 없이 참조한다. maker/checker 분리와 정확한 commit 리뷰는 lead 및 reviewer가 반드시 읽는 짧은 계약에 둔다.

## Dispatch 입력

처음 작업을 맡길 때 native preamble + 짧은 core + 해당 역할 + task 명세 + 해당 결과 schema를 사용한다. task 명세에는 다음이 필요하다.

- 목표, 역할, checkout/실행 host, 수정 가능한 범위와 고정 인터페이스
- base commit 또는 Git 없는 폴더라는 사실
- 확인된 재현·baseline·실패한 시도; 가설과 사실 구분
- 관찰 가능한 완료 기준과 필수 검증
- 결과 파일의 유일한 절대 경로 및 필요한 artifact 경로
- 사용한 정책 원본 경로와 버전 식별

정책 버전은 아래 정책 snapshot 계약의 SHA-256 manifest로 식별한다. Git commit이나 skills lock hash는 보조 provenance이며 서로 다른 알고리즘의 값을 직접 비교하지 않는다. Git 없는 설치도 지원한다. 이것은 무결성·버전 비교용이지 권한 증명이 아니다. Phase A1에서 기존 CLI에 작은 파일 pack/검사 기능을 추가하는 범위를 허용한다. 새 runtime wire schema는 요구하지 않고 기존 task spec과 report 디렉터리를 사용한다.

native handle/capability는 Orca가 전달한다. 프로젝트가 ID만으로 권한을 재구성하거나 예시 명령을 조합하지 않는다. 일반 메시지는 변경사항과 해당 task를 참조하고 같은 전체 정책·명세를 반복해서 덧붙이지 않는다. 새 목표·scope 변경은 명확하게 전달하고 기존 acceptance를 조용히 바꾸지 않는다.

## 복구 정책

| 상황 | 최소 복구 | 추가 조회 |
|---|---|---|
| 새 lead 세션 | core + lead 역할, 사용자 목표 | 위임할 때 routing/loop reference |
| 새 worker Dispatch | native 계약 + core + 역할 + 명세 | 작업에 필요한 source/schema |
| 같은 작업의 일반 후속 메시지 | 변경사항 | 필요한 source/evidence |
| resume 또는 compact | core의 역할·권한 경계 + 현재 task 참조 + 역할별 checkpoint | context에 없는 상세 reference |
| 정책 파일 변경 | 경로/버전 확인 | 바뀐 관련 규칙, 안전한 적용 시점 |

resume/compact 후에는 예전 loaded=true 같은 지속 플래그를 믿지 않는다. active worker 여부를 잃어버리면 lead로 승격하지 않는다. task_id와 자기 native handle이 남아 있다면 설치 CLI의 dispatch-show --task <task_id> --preamble --from <worker_handle> --json으로 계약을 재취득하고 반환된 현재 assignee/status/Dispatch를 확인한다. 역할·명세는 보존된 task spec 또는 아래 frozen packet에서 복구한다. 현재 명세 조회는 task-list --run <run_id> --json의 해당 Task spec을 사용하며 --brief를 사용하지 않는다. 접근이 거부되거나 식별자도 잃었다면 ID를 추측하지 않고 lifecycle mutation을 중단한다. 이때 capability가 필요한 escalation은 보내지 않으며 현재 사용자에게 보이는 agent 출력에 복구 불가 사실을 남긴다. coordinator는 worker-read와 native 상태로 확인한다. 이 자동 감지 지연은 Phase A의 명시적 한계다. 상태·식별자만으로 권한이 생기지 않으며 native가 실제 요청 주체를 검증한다. 다른 worker의 handle을 대신 사용하지 않는다.

lead는 native Run/Task/Dispatch와 미처리 delivery·worker 상태를 확인해 중복 dispatch를 막는다. worker는 자기 현재 Dispatch, scope, 미처리 follow-up과 결과 상태만 확인한다. worker에게 lead routing policy 전체를 다시 읽히지 않는다. 기존 native check/ask/heartbeat/worker_done 규칙은 계속 적용한다.

checkpoint는 기존 Orca task context·message·report와 source artifact를 사용한다. 새 shadow 상태 DB는 만들지 않는다. 외부 checkpoint는 증거와 탐색용이며 실행 권한과 완료 상태는 Orca에서 확인한다. raw log는 경로로 보존하고 필요한 부분만 읽는다.

초기 목표는 프로젝트가 추가하는 복구 안내를 약 250~400 tokens 이내로 유지하는 것이다. 이는 목표치이며 필수 안전 규칙을 자르는 hard cap이 아니다. 기존 additionalContextLimit은 provider의 preview/spill 동작일 뿐 전체 context 한도가 아니다. 안정적인 prefix cache는 비용에 도움이 될 수 있어도 모델이 읽는 내용과 중복 지침 문제를 없애지는 않는다.

## 기계적 검증과 의미 판단

Phase A는 문서·입력 구성만 바꾸며 현재 lead/worker의 검증 책임을 유지한다.

Phase B에서는 기존 CLI에 부작용 없는 validator를 추가하는 방안을 검토한다. 별도 daemon이나 lifecycle wrapper는 만들지 않는다. 기존 schema를 읽는 validator로 report 필수 필드·enum·snapshot 형식을 검사한다. 의미 있는 live 검증은 validator가 직접 기존 Orca read-only 명령과 git rev-parse HEAD/status/diff를 실행해 얻은 관찰로만 수행한다. report/checkout/Task selector는 조회 대상일 뿐 증명이 아니며 worker가 쓴 receipt를 authoritative observation으로 받아들이지 않는다. 접근 실패 시 해당 검사를 unverifiable로 남긴다. Git 없는 폴더의 snapshot 검사는 not applicable로 구분한다. 명령명과 flags는 아직 제안하지 않는다.

validator 결과는 valid/invalid/unverifiable을 구분하고 누락된 입력·실행하지 않은 검사를 기록한다. 구조 검사 통과는 코드 정확성이나 lifecycle 성공이 아니다. 판단에 쓰는 fresh native receipt와 source 관찰을 얻을 수 없으면 관련 검사를 unverifiable로 남긴다. 통합 직전 snapshot 재확인은 계속 필요하다.

Phase C의 Orca 개선 후보는 native session binding, 필요한 최소 복구 context 제공, 구조화된 provider 이벤트 수집이다. turn completed나 process exit는 작업 성공이 아니다. 취소·질문 대기·report 누락·CHANGES_REQUESTED·전송 재시도와 authoritative Dispatch 매칭을 구분해야 한다. 기존 worker_done을 대체하려면 Orca가 동등한 settlement/권한/ack/cleanup semantics를 제공하고 capability로 확인할 수 있어야 한다. 그 전에는 기존 명령을 유지한다.

## 변경 파일 계획

| 파일 | 설계 변경 |
|---|---|
| SKILL.md | 짧은 core·역할별 진입점, lead 상세 분리 |
| roles/*.md | 자기 역할의 필수 규칙만 읽게 연결; maker/checker 독립성 보존 |
| prompts/dispatch.md | 전체 매뉴얼 inline 허용을 없애고 core/role/task 중심 |
| prompts/recover.md | 무조건 전체 재독을 역할별 최소 복구로 교체 |
| codex-profile.toml | 초기 단계에서는 이벤트 matcher 유지; 실제 필요한 이벤트는 측정 후 조정 |
| prompts/review.md, judge.md | 줄어든 입력에서도 snapshot·blocking finding·증거 계약 유지 |
| install.ps1, install.sh, README.md | bundle 업데이트와 로딩 경로 확인 절차; 동일 정책 버전 배포 |
| multi-ai-cli.mjs | A1: 정책 파일 pack·manifest 비교만 추가; B: 기존 schema 기반 read-only 결과 검증 |

자동으로 global 설정을 수정하거나 원본·프로젝트 사본·global 사본 모두를 덮어쓰지 않는다. 사용 중인 scope와 provider별 discovery 경로를 식별한다. 이 worktree의 오래된 project-scope 사본은 A1 rollout에서 diff·백업·참조 확인 후 기존 skills 제거 흐름으로 정리하고 선택한 scope만 남긴다. 현재 설계 작업에서는 삭제하지 않는다.

진행 중 Dispatch의 core·역할·해당 prompt·schema·task spec은 아래 frozen packet으로 보존한다. 설치 파일이 제자리 업데이트돼도 이전 packet을 읽을 수 있다. 단, 새로 시작하거나 resume하면서 provider가 다른 버전의 자동 발견 지침을 함께 로딩하면 packet이 이를 덮어쓰는 권한을 갖는 것은 아니다. Phase A의 rollout은 활성 Run을 drain한 뒤 설치·세션 재시작한다. 외부에서 진행 중 설치가 바뀌면 충돌을 탐지해 mutation을 멈추고 coordinator가 안전한 종료·새 배정을 판단한다.

현재 install.ps1/install.sh는 GitHub dev를 설치하므로 로컬 설계/구현 파일을 자동 배포하지 않는다. 개발 검증은 격리된 테스트 scope에 로컬 후보 bundle을 설치하고, production 배포는 승인된 commit을 push한 뒤 기존 installer 실행, 실제 설치 manifest 비교, 세션 재시작 순서다. push나 설치 실행은 이번 설계 범위에 포함하지 않는다.

## 검증 계획과 채택 조건

먼저 baseline을 측정한다. 실제 dispatch/recovery payload, 정책 파일 read 횟수, 프로젝트 추가 context와 native preamble을 분리한 크기, coordination tool call 수, 완료까지 시간, 재작업·누락을 기록한다. 읽는 경로만 줄이고 전체 읽기 토큰이 그대로인 경우 개선으로 계산하지 않는다.

비교 시 모델/effort, 시작 source, task/acceptance, 설치 policy 버전과 실제 로딩 경로를 고정한다. 후보와 baseline은 별도 세션에서 실행하며 이전 정답을 공유하지 않는다. 일반 수정, read-only 리뷰, 원인 조사, compact/resume을 포함한 장기 작업을 포함한다. 작은 표본의 속도 차이를 일반화하지 않는다.

필수 회귀 시나리오:

1. worker가 compact/resume 뒤에도 같은 Dispatch와 역할을 유지하고 새 팀을 만들지 않는다.
2. recovery 뒤 중복 worker 실행이 없고, completion 직전 follow-up이 처리된다.
3. reviewer는 구현자의 설명에만 의존하지 않고 원본 요구·diff·checks를 확인한다.
4. report 누락, malformed JSON, 다른 Dispatch ID, HEAD 변경, 미해결 blocker는 승인되지 않는다.
5. terminal idle, process exit, turn complete, timeout 또는 원격 단절만으로 성공·retry·release하지 않는다.
6. 정책 변경·파일 부재·설치 사본 불일치를 감지하고 잘못된 버전을 조용히 사용하지 않는다.
7. 성공한 native settlement 이후 기존 cleanup/ack가 완료된다.
8. SIMPLE 작업은 팀 생성이나 복구 매뉴얼 전체 읽기를 요구하지 않는다.

채택 조건: 필수 회귀 시나리오 모두 통과, 독립 검증 수준 유지, 프로젝트 추가 context+정책 재독량의 의미 있는 감소. 초기 목표 30% 이상 감소는 실험 목표로만 사용하고 baseline 측정 전 성과를 주장하지 않는다. 시간·실패율이 악화되면 원인을 확인하고 채택을 보류한다. 복구 실패가 생기면 기존 입력 방식으로 rollback하며 live Dispatch를 새로 만들지 않는다.

## 단계별 산출물

A0: injection 발생 지점과 실제 로딩 scope 계측, baseline 기록.
A1: core/lead/worker 문서 분리, dispatch/recover 축소, 기존 CLI의 파일 pack·manifest 비교 추가, 실제 발견되는 stale scope 정리 계획. native 계약 유지.
A2: Fable 독립 리뷰와 위 회귀 시나리오 검증, 기존 설치 흐름으로 명시적 배포.
B: read-only validator를 별도 설계·검증 후 추가. 현재 사람/모델의 의미 판단 유지.
C: Orca runtime 개선은 별도 이슈로 전달. 이 저장소 변경의 선행 조건으로 두지 않는다.

## 리뷰 요청

설계 자체를 검토한다. 실제 성능 개선·runtime 구현 완료를 승인하는 리뷰가 아니다. native lifecycle 보존, compact 이후 권한/역할 복구, core 축소의 규칙 누락, 정책 버전·설치 drift, validator 책임 범위와 측정 가능성을 특히 확인한다. blocker에는 재현 가능한 시나리오와 위치를 포함한다. review_target은 null이며 v2 문서를 대상으로 한다.

## v2 상세 계약: 정책 snapshot과 전달 (F3, F4, F7)

파일 pack 기능은 프로세스 실행·session 생성·메시지 전송 없이 파일만 읽고 이미 선택된 report/artifact 디렉터리에 기록한다. 따라서 Orca lifecycle wrapper가 아니다. 구현 명령명은 아직 정하지 않았다.

1. Lead가 하나의 명시적인 policy root를 선택한다. 원본/프로젝트/global의 발견 가능한 multi-ai 경로를 별도로 나열한다. 선택한 root는 자동으로 추론한 실제 로딩 사실이 아니다. provider discovery와 transcript의 실제 파일 read를 함께 확인한다. 서로 다른 bundle이 동시에 발견되면 새 Dispatch 전에 보고하고 scope를 정리·세션 재시작한다.
2. manifest 대상은 SKILL.md, policy.yaml, codex-profile.toml, roles/ 아래 모든 .md, prompts/ 아래 모든 .md, references/ 아래 모든 .md(존재할 때), schemas/ 아래 모든 .json이다. 경로는 root 상대 POSIX 경로로 정렬하고 UTF-8 내용을 LF로 정규화해 각각 SHA-256을 계산한다. 동일 경로 중복·root 밖 symlink 참조·읽기 실패는 오류다. 전체 digest는 정렬된 상대 경로 + NUL + 각 hex digest + LF의 UTF-8 연결에 SHA-256을 적용한다. 모든 scope를 같은 방식으로 계산한다.
3. 설치 lock의 source/hash, clone의 commit/dirty 여부는 보조 메타데이터로 보존한다. host override와 실제 route resolution은 dispatch마다 별도로 기록한다. manifest가 runtime route 적용을 증명하지 않으며 requested/effective launch 확인은 계속한다.
4. 기존 report 디렉터리 아래 run별 policy-<digest>/에 위 파일과 manifest를 최초 한 번 보관하고 재사용 시 hash를 재검증한다. 다른 내용으로 덮어쓰지 않는다. 이것은 읽기용 증거 snapshot이며 Task/Dispatch 상태를 저장하는 DB가 아니다. 원격이면 execution host에서 생성·검증하고 읽을 수 있는 절대 경로를 사용한다. 보존 기간은 Run과 리뷰 증거의 보존 기간 이상이며 cleanup 대상 worktree 밖에 둔다.
5. worker-start에 전달하는 task spec은 core + 역할 본문 + 역할별 prompt + task 명세를 한 번 inline으로 포함한다. schema는 frozen snapshot 경로와 digest를 전달한다. 이 spec도 packet.md로 artifact 디렉터리에 보존하고 hash를 기록한다. native preamble/capability는 packet에 복제하지 않는다. 큰 lead manual은 inline하지 않고 frozen snapshot의 필요한 절만 읽는다.
6. 같은 worker의 후속 메시지는 변화만 전달한다. 새 Dispatch에는 새로운 native 권한과 새로운 task spec을 준다. 이전 packet은 권한 부여에 사용하지 않는다.

역할별 필수 입력 위치:

| 역할 | inline으로 받는 계약 | frozen reference |
|---|---|---|
| Engineer | core + roles/engineer.md + task 명세; 실행 host에서 관련 build/test, scope 밖 수정 금지, commit은 허가된 흐름에서만, 미실행 check 명시 | worker-result schema, 작업별 source |
| Reviewer | core + roles/reviewer.md + prompts/review.md; maker!=checker, HEAD/base/clean state 전후 확인, full SHA, 변경 후 재리뷰, fallback 기록, 미실행 exit_code=null | review-result schema, 원래 요구사항과 실제 diff |
| Researcher/Architect | core + 해당 역할 + task 명세; 기본 read-only, 사실/가설 구분 | worker-result schema, 조사에 필요한 source |
| Lead | core + roles/lead.md | lead-workflow, dispatch/review/judge, routing, 경쟁·복구 reference를 필요할 때 |

정확한 SHA 규칙은 code review에 적용하고 plan review는 null snapshot을 유지한다. 역할 분리 후 기존 SKILL.md 각 규칙의 새 위치를 mapping 표로 검토해 누락을 확인한다. terminal 없는 worker의 재사용은 지원 여부를 확인한 native 경로가 있을 때만 한다. 현재 확인된 --terminal 재사용 경로는 proven terminal worker만 대상으로 하며 그 밖에는 정상 settlement/cleanup 후 fresh worker를 사용한다.

## v2 상세 계약: provider별 복구 경로 (F2)

| 대상 | 처음 전달 | resume/compact에서 Phase A가 실제 제공하는 경로 | 검증 범위 |
|---|---|---|---|
| Codex lead | 스킬 core + 역할 | 선택적으로 설치한 SessionStart hook(startup/resume/compact)이 짧은 복구 안내를 전달. 미설치 시 자동 주입을 주장하지 않으며 수동 resume prompt에서 동일 안내 사용 | hook 사용/미사용 모두 별도 기록 |
| Codex worker | native preamble + inline core/역할/task | worker에 hook이 자동 전파된다고 가정하지 않음. compact 요약에 최소 identity/packet 참조 보존을 요청하고 task/handle이 남으면 native 재취득. 자동 보존 실패 테스트는 실패로 기록 | 실제 worker 설정으로 compact 테스트 필수 |
| Claude worker | native preamble + inline core/역할/task | 새로운 Claude hook을 Phase A에 설치하지 않음. 같은 최소 checkpoint와 native 재취득; coordinator가 필요하면 복구 안내를 보냄. 요약 보존은 보장 아님 | Claude compact 테스트 별도 필수 |

최소 checkpoint: 사용자 목표, 역할, Task/Dispatch/Run 식별자, 자기 native handle, frozen packet 경로/hash, 이미 완료한 작업, 대기 중 질문 ID와 후속 메시지 상태. capability는 넣지 않는다. identity가 전부 사라지면 조용히 일반 Lead가 되어 작업을 계속하지 않도록 core에 명시한다. 자동으로 이것을 보장하는 runtime 기능은 Phase C이며 Phase A 성능 평가에서도 수동 복구 횟수와 발견 지연을 비용으로 센다.

## v2 상세 계약: 측정과 회귀 판정 (F1, F5)

A0 수집 원천:

- Orca task-list --run <run> --json의 전체 spec, worker-show --dispatch <id> --json의 요청/실효 launch 및 상태, worker-read --dispatch <id> --source transcript --json의 실행 기록. cursor를 끝까지 읽고 contentComplete/clipping을 확인한다. 수집 불완전은 0으로 계산하지 않는다.
- native preamble 길이만 필요한 계측은 해당 worker 자신의 dispatch-show --preamble 응답에서 길이만 계산한다. capability를 보고서·공유 로그에 저장하지 않는다.
- provider 원본 transcript 위치는 CLI/session metadata에서 확인한다. 통상 Codex는 CODEX_HOME/sessions 아래, Claude는 ~/.claude/projects 아래 JSONL이지만 고정 경로 가정을 하지 않는다. 접근 가능할 때 Orca clipping을 보완하며 schema/version을 기록한다.
- read 도구와 shell의 cat/Get-Content 등을 포함해 실제 반환된 정책 텍스트의 횟수·UTF-8 bytes를 센다. 동일 내용을 여러 번 읽으면 각각 센다.
- 주 측정값 B는 프로젝트가 추가한 inline core/role/task 지침 bytes와 정책 재독 결과 bytes의 합이다. task의 source data, 사용자 원문, native preamble은 별도 집계한다. baseline과 candidate에 동일 분류 규칙을 사용하고 샘플을 사람이 검토한다. B 감소율=(baseline B-candidate B)/baseline B. baseline B=0 또는 로그 누락이면 계산하지 않는다.
- provider가 보고하는 전체 input/cache/output tokens는 보조 측정으로 저장한다. 메시지별 토큰 분해가 없으면 추정으로 표시한다. 비용 절감을 bytes 감소와 동일시하지 않는다. wall time은 dispatch turn-start부터 accepted settlement까지, coordination call 수와 수동 개입도 함께 기록한다.

아래 명령의 selector는 테스트 harness가 생성·보관한 실제 native ID를 사용한다. fault injection은 별도 테스트 Run/checkout에서 수행한다. 기존 production worker를 죽여 시험하지 않는다. 필드 명칭이 버전별로 다르면 실제 receipt를 fixture로 기록하고 assertion을 맞추며 unknown은 pass가 아니다.

| 시나리오 | 수집/실행 | Pass / Fail 관찰 |
|---|---|---|
| Codex compact/resume | 별도 worker를 compact/resume하고 worker-read + worker-show + 자신의 dispatch-show로 추적 | 같은 active Dispatch/역할/scope를 복구; 새 Run/worker 생성 또는 권한 추측이면 fail |
| Claude compact/resume | Claude에서 같은 절차. hook 없음도 기록 | 같은 기준; identity 제거 케이스는 lifecycle mutation 없이 복구 불가 출력이어야 pass. 수동 개입을 따로 셈 |
| 중복 생성·follow-up | completion 전에 테스트 변경 지시 전송; task-list/worker-list와 transcript 비교 | 불필요한 active attempt 증가 없음, 지시가 완료 전 처리됨. 합법적 retry는 별도 scenario라 Dispatch 수=Task 수를 전역 규칙으로 삼지 않음 |
| 리뷰 독립성 | maker/reviewer native provenance와 transcript, report 확인 | 서로 다른 maker/checker, 원래 요구/diff/check 증거 존재. 설명만 복사하면 fail |
| outcome 매핑 | APPROVED, CHANGES_REQUESTED, BLOCKED, WorkerResult ok/needs_revision/blocked fixtures | 완료 리뷰는 succeeded, 미완료는 failed; report와 delivery payload 대조. verdict를 lifecycle 성공과 혼동하면 fail |
| 잘못된 report/snapshot | 누락/비정상 JSON/타 Dispatch/HEAD 변경/blocker fixtures와 judge 결과 | 승인·통합을 거부 또는 unverifiable로 보류해야 pass; Phase B 전에는 Lead가 검사를 수행한 증거 필요 |
| idle/exit/timeout/연결 단절 | 테스트 worker를 제어하고 worker-show/worker-list/task-list 관찰 | native가 실패로 settle할 수는 있으나 성공으로 간주하지 않음. positive exit 없이 retry/stop/release하지 않음; 단순 status=dispatched 유지 자체를 요구하지 않음 |
| 정책 drift·업데이트 | 서로 다른 테스트 scope manifest, 설치 후 packet hash 재검사 | 새 Dispatch 전 mismatch 감지, 기존 packet은 변경되지 않음. 충돌한 자동 로딩 지침을 무시하고 계속하면 fail |
| settlement/cleanup/ack | worker-show, worker-release receipt, check --ack, worker-list --run <run> --terminal-state reclaimable --json | 정확한 Dispatch 수락, cleanup 결정, delivery ack 확인, 미결 reclaimable 0. release 실패/불확실은 완료로 주장하지 않음 |
| SIMPLE | 단순 문서 수정 transcript와 worker-list 전후 비교 | 새 팀/전체 manual 재독 없음; 직접 검사 결과 존재 |

설계 리뷰는 위 테스트를 실행했다는 뜻이 아니다. A2 구현 검증에서 각 행의 실제 receipt·transcript·report를 보관하고 실행하지 못한 행은 미검증으로 남긴다.

## v1 리뷰 지적 처리

| 지적 | v2 반영 |
|---|---|
| F1 lifecycle 매핑 누락 | core 필수 규칙에 outcome 매핑·유일 report 경로·보존 추가, 회귀 fixture 정의 |
| F2 복구 경로 불명확 | 검증된 native preamble 재취득, provider별 hook 유무, identity 상실 시 안전한 중단과 관찰 한계 명시 |
| F3 version/drift 정의 부재 | A1 파일 pack 허용, 파일 집합·정규화·SHA-256·실행 주체 정의, stale scope와 production 설치 순서 구체화 |
| F4 이전 정책 파일 유실 | worktree 밖 frozen snapshot + inline Task packet 보존; 자동 로딩 충돌 방지를 위해 활성 Run drain 후 rollout |
| F5 판정 불가능한 검증 | 원천·bytes 분모·누락 처리·시나리오별 Pass/Fail 관찰 정의 |
| F6 validator trust | validator가 직접 native/Git 관찰, worker receipt를 사실로 신뢰하지 않음 |
| F7 역할 계약 전달 | 역할별 inline/frozen 입력과 필수 규칙 mapping |
| F8 terminal 없는 worker | 검증된 native 재사용만 허용, 미지원은 settlement 후 fresh worker |

Fable의 보고서에서 기본 profile 파일 부재로 모든 세션의 hook 부재를 단정한 부분은 채택하지 않았다. 임의 CODEX_HOME/다른 hook 경로는 미확인이다. F1의 자동 재시도·report 덮어쓰기와 F4의 Run 폐기가 필연이라는 설명도 현재 정책상 허용되는 동작은 아니지만, outcome 규칙과 버전 보존을 명시해야 한다는 지적은 수용했다.
