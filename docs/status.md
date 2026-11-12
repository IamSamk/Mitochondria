# Implementation Status

| Module | Status | Owner | Tests | Blockers |
|---|---|---|---|---|
| Foundation / database | Tested | M1 | 1 health test, migration+seed run in test setup | — |
| Authentication / RBAC | Tested | M1 | Login, CSRF, session fixation, deactivation, logout, audit | — |
| Admin: users, departments, courses, assignments | Tested | M1 | Covered by route/RBAC suite; manual CRUD walkthrough | — |
| Question bank | Tested | M2 | Question creation, PDF exclusion of answer keys | — |
| Paper generation | Tested | M3 | Multi-set builder, total validation, submit, reject/revision | — |
| Approval / printing | Tested | M3 | Approve, reject with comments, release, printing-only download | — |
| Answer scripts | Tested | M4 | PDF upload, page count, hold/release, verify, allocate/reallocate | — |
| Digital valuation | Tested | M4 | Draft, submit, verifier reopen, resubmit, download | — |
| Marks / results | Tested | M5 | Verify, finalize, controller reopen, results page + CSV | — |
| Audit viewer / dashboards | Tested | M5 | Role-specific dashboards; audit filters; actions audited | — |
| Integration | Tested | All | 33 Jest/Supertest tests: nav routes, RBAC, full lifecycle | — |
| Deployment / docs | Tested | All | `pnpm build` migrations + seed; missing-env setup page verified | — |

Notes: schema (`001_initial_schema.sql`) contains all planned tables. The automated suite (`pnpm test`) rebuilds `emp_test` from migrations + seed, then covers every role's sidebar route, cross-role 403s, and a complete lifecycle: exam → question → paper → review → release → script upload/verify/allocate → evaluation → correction → verification → finalize/reopen → results CSV. The same lifecycle was manually exercised end-to-end against the dev database.
