# Implementation Status

| Module | Status | Owner | Tests | Blockers |
|---|---|---|---|---|
| Foundation / database | Tested | M1 | 1 health test, migration+seed run in test setup | — |
| Authentication / RBAC | Tested | M1 | Login, CSRF, session fixation, deactivation, logout, audit | — |
| Admin: users, departments, courses, assignments | Tested | M1 | Covered by route/RBAC suite; manual CRUD walkthrough | — |
| Admin: student registry | Tested | M1 | List/filter, create, edit, deactivate/reactivate, duplicate-code 422, audit events, upload-picker exclusion | — |
| Self-service account | Tested | M1 | Profile view, display-name update, password change, session invalidation, audit | — |
| Question bank | Tested | M2 | Question creation, PDF exclusion of answer keys | — |
| Paper generation | Tested | M3 | Multi-set builder, repeatable draft saves, total validation, submit, head gate, reject/revision, teacher finalization; release blocked until finalized | — |
| Approval / printing | Tested | M3 | Subject-head approve/veto, reviewer approve/reject, release, printing-only download | — |
| Paper collaboration & access control | Tested | M6 | Comments on papers/questions; unauthorised download attempts recorded with user/IP; 15-minute freeze; owner review/clear; optional bcrypt download password; shared gate for controller/printing/reviewer downloads | — |
| Direct marksheets | Tested | M6 | Manual entry, edit later, clearing a mark, CSV paste/file import with row errors, head read-only views | — |
| Seating & invigilation | Tested | M6 | One-click generation from active students/faculty, row-level edits and deletion, head read-only views | — |
| Head supervision | Tested | M6 | Subject head: department paper queue, approve into review, veto pre-release, comments, marks/logistics oversight. Department head: same scope read-only plus comments | — |
| Answer scripts | Tested | M4 | PDF upload, page count, hold/release, verify, allocate/reallocate | — |
| Digital valuation | Tested | M4 | Draft, submit, verifier reopen, resubmit, download | — |
| Marks / results | Tested | M5 | Verify, finalize, controller reopen, exam filter with stable summary counts, results page + CSV | — |
| Audit viewer / dashboards | Tested | M5 | Role-specific dashboards incl. subject/department heads; audit filters; actions audited | — |
| Integration | Tested | All | 50 Jest/Supertest tests across 6 suites: nav routes, RBAC, students, account, full lifecycle, role workflows | — |
| Deployment / docs | Tested | All | `pnpm build` migrations + seed; missing-env setup page verified | — |

Notes: schema migrations are `001_initial_schema.sql`, `002_student_registry.sql` and `003_role_workflows.sql` (paper workflow/head reviews/comments/download locks/`exam_marks`/seating/invigilation). The automated suite (`pnpm test`) rebuilds `emp_test` from migrations + seed, then covers every role's sidebar route, cross-role 403s, the student registry and self-service account flows, a complete lifecycle (exam → question → paper → head approval → review → teacher finalize → release → script upload/verify/allocate → evaluation → correction → verification → finalize/reopen → results CSV), and the role workflows: draft saves, head veto and recovery, comments, download lock attribution/clear, password prompt, marksheet edits/import, and seating/invigilation generation and edits. It also asserts that filtering the marks pages by status does not zero the summary cards. The same lifecycle was manually exercised end-to-end against the dev database.
