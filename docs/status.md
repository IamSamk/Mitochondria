# Implementation Status

| Module | Status | Owner | Tests | Blockers |
|---|---|---|---|---|
| Foundation / database | Tested | M1 | 1 health test, migration+seed run in test setup | — |
| Authentication / RBAC | Tested | M1 | Login, CSRF, session fixation, deactivation, logout, audit | — |
| Admin: users, departments, courses, assignments | Tested | M1 | Covered by route/RBAC suite; manual CRUD walkthrough | — |
| Admin: student registry | Tested | M1 | List/filter, create, edit, deactivate/reactivate, duplicate-code 422, audit events, upload-picker exclusion | — |
| Self-service account | Tested | M1 | Profile view, display-name update, password change, session invalidation, audit | — |
| Question bank | Tested | M2 | Question creation, PDF exclusion of answer keys | — |
| Paper generation | Tested | M3 | Multi-set builder, total validation, submit, reject/revision | — |
| Approval / printing | Tested | M3 | Approve, reject with comments, release, printing-only download | — |
| Answer scripts | Tested | M4 | PDF upload, page count, hold/release, verify, allocate/reallocate | — |
| Digital valuation | Tested | M4 | Draft, submit, verifier reopen, resubmit, download | — |
| Marks / results | Tested | M5 | Verify, finalize, controller reopen, exam filter with stable summary counts, results page + CSV | — |
| Audit viewer / dashboards | Tested | M5 | Role-specific dashboards; audit filters; actions audited | — |
| Integration | Tested | All | 43 Jest/Supertest tests across 5 suites: nav routes, RBAC, students, account, full lifecycle | — |
| Deployment / docs | Tested | All | `pnpm build` migrations + seed; missing-env setup page verified | — |

Notes: schema migrations are `001_initial_schema.sql` plus `002_student_registry.sql` (student `is_active`/`updated_at` and indexes). The automated suite (`pnpm test`) rebuilds `emp_test` from migrations + seed, then covers every role's sidebar route, cross-role 403s, the student registry and self-service account flows, and a complete lifecycle: exam → question → paper → review → release → script upload/verify/allocate → evaluation → correction → verification → finalize/reopen → results CSV. It also asserts that filtering the marks pages by status does not zero the summary cards. The same lifecycle was manually exercised end-to-end against the dev database.
