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
| Student portal & notifications | Tested | M7 | STUDENT role with login/default password, dashboard, exams, results, seat, notifications, announcements; notification triggers | - |
| Revaluation | Tested | M7 | Revaluation windows, student applications, staff review with mark adjustment and audit | - |
| Seating templates & optimal placement | Tested | M7 | Reusable room templates (up to 100x100), multi-room instances, greedy+backtracking optimal placement algorithm | - |
| Question assembly | Tested | M7 | Contributed question pool, review/scoring, auto-assembly by topic/difficulty/marks, materialize to paper draft | - |
| Exam timetable solver | Tested | M7 | Conflict graph from shared students, greedy graph colouring, exam slots | - |
| Announcements | Tested | M7 | Department/role-targeted notices, student-facing list | - |
| Integration | Tested | All | 50 Jest/Supertest tests across 6 suites: nav routes, RBAC, students, account, full lifecycle, role workflows | — |
| Deployment / docs | Tested | All | `pnpm build` migrations + seed; missing-env setup page verified | — |

Notes: schema migrations are 001-008 (initial, student registry, role workflows, student portal/notifications, revaluation, seating templates, announcements, question assembly/timetable). The automated suite (pnpm test) rebuilds emp_test from migrations + seed and covers 51 tests across 6 suites.


