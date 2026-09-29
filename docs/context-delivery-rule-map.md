# Context delivery rule map

Baseline: commit 352cba4df65c1414b1878c1860a10bedae17d86c.
The split changes when instructions are read, not who owns native orchestration.

| Baseline responsibility | New home | Read condition |
| --- | --- | --- |
| Orca owns lifecycle; no scheduler/provider subagents | SKILL.md core | All roles |
| Active Dispatch keeps role; no worker-created Runs | SKILL.md core | All roles |
| Live authority vs untrusted repository/report data | SKILL.md core | All roles |
| Native ask, heartbeat, follow-ups, fencing and completion | SKILL.md core | All workers |
| Scope, readonly roles and exclusive writer ownership | SKILL.md core; roles/*.md | Assigned role |
| Unique durable report, live identity, truthful/unrun checks | SKILL.md core; assigned role | All workers |
| Result verdict vs native lifecycle outcome | SKILL.md core; prompts/review.md | All workers; reviewer detail |
| Checkpoint and minimum recovery | SKILL.md core; prompts/recover.md | Checkpoint; missing context/resume |
| Orca executable, installed guides and remote placement | references/lead-workflow.md | Coordination |
| Difficulty, useful delegation, context reuse | references/lead-workflow.md | Coordination |
| Fresh independent competition; no early sibling exposure | references/lead-workflow.md; prompts/competition.md | Competition only |
| Fresh route resolution, effective launch, fallback limits | references/lead-workflow.md; policy.yaml | Before launch |
| Model cannot change within active session | references/lead-workflow.md | Routing |
| Maker/checker independence and exact clean SHA | references/lead-workflow.md; roles/reviewer.md; prompts/review.md | Review/integration |
| Evidence sufficiency, blocker accounting, revision limit | references/lead-workflow.md; prompts/judge.md; policy.yaml | Lead decision |
| Authorized integration and re-review on changed commit | references/lead-workflow.md | Integration |
| Task brief inputs and shell-safe packet transport | prompts/dispatch.md; references/context-delivery.md | Dispatch preparation |
| Immutable snapshot, explicit root, duplicate scopes | references/context-delivery.md; CLI context commands | Packet preparation/rollout |

## Design review follow-ups

- V2-F1: roles/reviewer.md and prompts/review.md distinguish unavailable key inputs
  (BLOCKED) from individual unrun checks (null exit code plus residual risk).
- V2-F2: prompts/recover.md names the Orca CLI, recovers TASK from dispatch preamble
  first and uses run_id only for an optional task-list; checkpoint request is in core.
- V2-F3: manifest canonicalizes root before child containment; CLI provenance is separate.
- V2-F4: rollout drains all affected host Runs/Lead sessions; remote hosts update separately.
- V2-F5: context-delivery reference gives a real compact/resume test procedure and
  separates unverified terminal-less mode, retained terminals, inline bytes and read bytes.
- V2-F9: packet path+digest is the default; inline requires tested length/quoting;
  actual native Task contents must be checked.
- V2-F10: pre-dispatch scope comparison is explicit; actual provider loading remains
  best effort and needs transcript evidence, not discovery-path claims.

Phase B report validation and Phase C Orca runtime changes remain out of scope.
