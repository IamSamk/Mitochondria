# Implementation Status

| Module | Status | Owner | Tests | Blockers |
|---|---|---|---|---|
| Foundation / database | Tested | M1 | 1 health test, migration+seed run in test setup | — |
| Authentication / RBAC | Tested | M1 | 13 integration tests passing | — |
| Admin: users, departments, courses, assignments | Not started | M1 | Pending | — |
| Question bank | Not started | M2 | Pending | — |
| Paper generation | Not started | M3 | Pending | — |
| Approval / printing | Not started | M3 | Pending | — |
| Answer scripts | Not started | M4 | Pending | — |
| Digital valuation | Not started | M4 | Pending | — |
| Marks / results | Not started | M5 | Pending | Finalize-role decision |
| Audit viewer / dashboards | Not started | M5 | Pending | — |
| Integration | Not started | All | Pending | — |
| Deployment / docs | In progress | All | Pending | — |

Notes: schema (`001_initial_schema.sql`) already contains all planned tables; it has been migrated but only auth-related tables are exercised so far. Manual curl check of login, RBAC and security headers done against a running server. Nothing is marked Verified yet.
