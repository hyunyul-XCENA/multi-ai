# Context delivery 설계 리뷰 기록

상태: v2 APPROVED — design blocker 0건, non-blocking 7건. 구현과 배포는 수행하지 않았다.

## 검토 범위

Orca를 유지하면서 프로젝트의 반복 지침과 전체 정책 재독을 줄이는 설계. 설계 본문은 [context-delivery-design.md](../context-delivery-design.md). 리뷰는 설치된 [orca-cli 스킬](C:/Users/hyunyul/.agents/skills/orca-cli/SKILL.md)과 [orchestration 스킬](C:/Users/hyunyul/.agents/skills/orchestration/SKILL.md)의 native Run/Task/Dispatch 절차로 진행했다.

## 실행 근거

- Run: run_41953fca315f
- Maker: Codex, coordinator term_a7d61d2a-f921-476a-9963-05670f66833d
- Reviewer 최초 launch requested/effective: claude / claude-fable-5-1 / medium. Orca receipt 양쪽 일치.
- 1차 Task/Dispatch: task_67590499e34b / ctx_249d2013eb81
- 재리뷰 Task/Dispatch: task_00916b62f8ca / ctx_d1de6a425687
- 재리뷰는 동일 reviewer terminal 및 process incarnation f4110345-dd95-48a0-9f56-74663217a295 재사용. 재사용 receipt의 model/effort null은 최초 launch 증거와 같은 process 식별자로 보완했다.
- route CLI 생성 실패로 설치 policy와 host override를 직접 확인했다. reviewer primary에는 override가 없었고 사용자도 Fable을 명시했다.
- 이번 Lead는 이미 실행 중인 Codex다. host의 lead.primary=Claude 설정이 현재 세션을 바꾸지는 않는다.

## 1차 리뷰와 수정

[원본 ReviewResult](context-delivery-fable-v1.json): CHANGES_REQUESTED, blocking 5건과 non-blocking 3건. 리뷰 자체는 완료되어 lifecycle succeeded로 수락됐다.

| 지적 | 반영 |
|---|---|
| F1 | lifecycle outcome 매핑과 유일 report 경로·보존 추가 |
| F2 | native preamble 재취득, provider별 복구 경로와 identity 상실 시 중단 명시 |
| F3 | 정책 파일 집합·정규화·hash·계산 주체와 설치 drift 검증 정의 |
| F4 | 작업별 frozen packet과 정책 snapshot 보존; drain 후 rollout |
| F5 | 계측 원천, bytes 분모, 시나리오별 Pass/Fail 정의 |
| F6 | validator가 직접 Orca/Git 상태 조회 |
| F7 | 역할별 필수 계약과 전달 경로 지정 |
| F8 | terminal 없는 worker는 검증된 native 재사용만 허용 |

기본 profile 파일 부재만으로 모든 hook 부재를 단정하지 않았다. 자동 재시도나 report 덮어쓰기가 반드시 발생한다는 설명도 채택하지 않았지만 원인이 되는 설계 누락은 보완했다.

## 재리뷰 대상

v2는 수정 중인 파일을 읽히지 않고 별도 frozen candidate로 전달했다. candidate SHA-256: a75abf0dd0fd22be5ffdde45929416de7bf9d525551e8dbfaff548b39b99e739. 이 값은 설계 후보 식별용이며 code commit review_target을 대신하지 않는다. plan review_target은 null이다.

## 검증 범위와 한계

설계와 로컬 계약·파일을 대조했다. runtime/성능 테스트나 정책 설치는 하지 않았다. 리뷰 JSON의 필수 필드·타입·판정 조건과 native Dispatch identity를 확인했으나 일반 JSON Schema engine은 실행하지 않았다. 원격·terminal 없는 worker 복구, provider별 compact/resume, 실제 토큰·시간 감소는 구현 단계에서 별도 검증한다.

## 최종 판정과 후속 작업

[2차 ReviewResult 원본](context-delivery-fable-v2.json): APPROVED. Lead는 설계 v2를 SELECT한다. INTEGRATE나 구현 검증 완료를 뜻하지 않는다. 설계 문서에는 리뷰 뒤 상태 표시와 이 기록의 링크만 추가했으며 검토받은 설계 본문은 바꾸지 않았다.

아래는 삭제하거나 해결됐다고 처리하지 않은 구현 착수 조건이다. A1 구현 명세에 반영하고 A2에서 확인한다.

| 항목 | 구현 시 처리 |
|---|---|
| V2-F1 | BLOCKED는 핵심 입력 부재로 verdict를 낼 수 없는 경우에 한정. 일부 check 미실행은 null exit와 residual risk로 구분 |
| V2-F2 | Orca CLI라는 용어 사용. 자신의 dispatch-show 응답의 TASK 블록으로 우선 복구하고, 추가 조회가 필요할 때 응답의 run_id로 task-list 사용. 최소 checkpoint 요청을 core에 명시 |
| V2-F3 | 선택한 root 자체는 먼저 realpath로 정규화. 이후 파일별 root 밖 참조만 거부. CLI 파일 hash/버전을 보조 provenance에 포함 |
| V2-F4 | 전역 설치 drain 범위는 해당 host의 모든 영향받는 Run/Lead 세션. 원격 host는 별도 확인. 다른 작업을 임의 종료하지 않음 |
| V2-F5 | terminal worker의 compact/resume 재현 절차를 명시. terminal 없는 worker는 지원 확인 전 미검증. 명시적 retain은 적법한 cleanup 결정으로 집계. inline/재독 bytes를 따로 표시 |
| V2-F9 | A1 첫 실험에서 --spec 전달 후 원문 보존 확인. 인자 길이·quoting 때문에 실패하면 짧은 core와 frozen packet 경로+digest로 전달하고 필요한 파일을 한 번 읽게 함. 동일 bytes 기준으로 평가 |
| V2-F10 | Lead 자신의 실제 로딩 확인은 best-effort. 새 dispatch 전 발견 가능한 scope의 충돌을 확인하고 실제 read는 사후 A0 로그로 검증 |

Fable이 원격·terminal 없는 worker 복구까지 검증했다고 주장하지 않는다. 예외 경로는 관찰 가능한 capability가 없으면 미검증으로 남긴다.
