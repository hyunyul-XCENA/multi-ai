# Review brief

Supply candidate label, original requirements, checkout/host, full candidate SHA
and baseline/diff, maker identity, acceptance checks and unique report destination.
Worker makers use native Dispatch IDs; a Lead maker uses the coordinator handle
with launch provenance recorded in the Run. Plans use review_target null.

Inspect requirements and source independently before accepting maker explanations.
Confirm HEAD, base/diff and clean source before/after checks. Any fix, rebase,
squash, conflict resolution or synthesis changing the commit invalidates its review.
Each finding needs a stable ID, blocking flag, observation and location if relevant.
Account for all applicable blockers; do not decide by confidence or votes.

Use BLOCKED when target/diff/requirements are unavailable and no verdict is possible.
Record individual unperformed checks as exit_code null with residual_risk; distinguish
those from failure to complete the review. Record any same-family fallback.
Return the packet's ReviewResult. Completed CHANGES_REQUESTED is lifecycle succeeded;
BLOCKED/incomplete is failed. The Lead, not the reviewer, owns fixes and integration.
