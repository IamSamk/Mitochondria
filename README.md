# Examination Management Platform

Classroom project: digitizes the exam lifecycle from question-paper preparation to final marks.
Modular monolith: Node.js + Express 5, EJS, Bootstrap 5, **PostgreSQL**, **pnpm**.

> Stack change vs. the original brief: PostgreSQL (`pg`, `connect-pg-simple`) replaces MySQL; pnpm replaces npm.

## What is implemented
Every sidebar page is a real, database-backed workflow (no mock screens):

- **Admin** — user accounts and roles, student registry (add/edit/deactivate records used by script uploads), departments, courses, faculty-course assignments, filterable audit log.
- **Controller** — create/edit examinations and advance their lifecycle; monitor approved papers and release them for printing; upload answer-script PDFs with page-count validation, hold/verify/reallocate them; finalize verified marks; view results and export CSV.
- **Faculty** — question bank and contributed question pool with review/scoring, multi-set paper builder with repeatable draft saves, mark-total validation, PDF generation on submission, teacher finalization after approval, revisions after rejection, direct marksheet entry/CSV import with later edits, one-click seating and invigilation generation with row-level editing and template-based optimal placement, exam timetable conflict solver, announcements, per-question evaluation of allocated scripts with drafts and correction cycles.
- **Reviewer** — head-approved paper queue, paper detail, approve/reject with comments, PDF download.
- **Subject Head** — supervise department papers, approve submissions into the reviewer queue, veto a paper at any pre-release stage (clearing teacher finalization), discuss papers and individual questions in comments, read department marksheets and logistics plans.
- **Department Head** — read-only supervision of the whole department: papers, marksheets, seating and invigilation, plus the same comment and veto rights.
- **Printing Coordinator** — released-paper queue and PDF downloads only.
- **Marks Verifier** — submitted-marks queue, verify or send back with a reason, download scripts, read finalized results.
- **Student** — login with default password, dashboard, upcoming exams, published results, seat assignment, notifications, announcements, revaluation applications.

Every signed-in role also has **My account**: a read-only profile summary plus self-service display-name update and password change. Changing a password keeps the current session signed in and terminates every other session for that account. Students are records in a registry, not sign-in accounts — deactivating one hides them from the script-upload picker but keeps their historical scripts and results.

Uploaded scripts and generated papers live outside the web root and are only served through authorized, role-checked download routes. Every form is CSRF-protected and every route enforces RBAC server-side. Paper downloads are additionally protected: unauthorised attempts are recorded with the user and IP, freeze downloads for 15 minutes, and the owner can review the attempts, clear the freeze, or set an optional download password. Teachers can only finalize their own papers, and the controller cannot release a paper before that finalization.

## Prerequisites (Windows)
- Node.js 22+ (`node -v`)
- pnpm 10+ (`npm i -g pnpm`)
- PostgreSQL 16+ with `psql` on PATH

## Setup
```powershell
git clone <repo-url>; cd examination-management-platform
pnpm install
copy .env.example .env        # then edit secrets
```
Create the databases (run in psql as the `postgres` superuser):
```sql
CREATE ROLE emp WITH LOGIN PASSWORD 'emp_dev_password' CREATEDB;
CREATE DATABASE emp OWNER emp;
CREATE DATABASE emp_test OWNER emp;
```
Initialize and run:
```powershell
pnpm db:migrate     # applies database/migrations/*.sql
pnpm db:seed        # roles + synthetic demo data
pnpm dev            # http://localhost:3000
pnpm test           # rebuilds emp_test, runs Jest + Supertest
```
## Local data (development)

Locally we use a Docker Postgres container (`emp-postgres`) on port 5432 with two databases:
- `emp` — development database (DATABASE_URL)
- `emp_test` — test database, rebuilt from migrations + seed on every `pnpm test` (TEST_DATABASE_URL)

Credentials: user `emp`, password `emp_dev_password`. Demo data comes from `scripts/seed.js` (roles + synthetic accounts, courses, students). `pnpm db:seed:demo` (`scripts/seed-demo.js`) adds full workflow scenarios on top: see "Demo scenarios" below.

## Deploying to Vercel / Supabase

1. Create a hosted Postgres database (Supabase, Neon via Vercel Marketplace, or similar) and copy its connection string.
   - For Supabase, prefer the **Session pooler** (port 5432) or direct connection; the transaction pooler (port 6543) can break prepared statements.
2. In Vercel → Project → Settings → Environment Variables add:
   - `DATABASE_URL` — the connection string
   - `SESSION_SECRET` — a long random value
   - `CSRF_SECRET` — a long random value
   - `SEED_DEMO_DATA=true` — optional, creates the demo accounts during the build
3. Redeploy. The build (`pnpm build`) applies pending migrations and seeds roles automatically.

To inject a full, realistic demo dataset into a hosted database (Supabase/Neon) after deploy:
```powershell
$env:DATABASE_URL="<hosted url>"; $env:NODE_ENV="production"; pnpm db:seed:demo
```

If a variable is missing, the site shows a "Server is not configured yet" page instead of crashing.

## Demo accounts (synthetic; password `Demo@12345`)
| Role | Email |
|---|---|
| Admin | admin@college.test |
| Controller | controller@college.test |
| Faculty (CS101) | faculty1@college.test |
| Faculty (CS102) | faculty2@college.test |
| Faculty (CS201, CS202) | faculty3@college.test |
| Faculty (CS101, second teacher) | faculty4@college.test |
| Faculty (ECE: EC101, EC102) | faculty5@college.test |
| Faculty (MECH: ME101) | faculty6@college.test |
| Reviewer | reviewer@college.test |
| Printing Coordinator | printing@college.test |
| Marks Verifier | verifier@college.test |
| Subject Head (CSE / ECE) | subjecthead@college.test / subjecthead.ece@college.test |
| Department Head (CSE / ECE) | depthead@college.test / depthead.ece@college.test |
| Students (CSE) | student1@college.test ... student5@college.test |
| Student (ECE) | student.ece@college.test |
| Deactivated faculty (login refused) | former.faculty@college.test |

Base data (`pnpm db:seed`): 3 departments, 7 courses, 65 students (one inactive).

## Demo scenarios (`pnpm db:seed:demo`)
Walks synthetic exams through every workflow state using the app's own routes, so each role
has work waiting. Runs once per database (skips if already present). It is not part of the Vercel
build (it makes thousands of queries, which is slow from Vercel's build region to a distant
database); run it from your machine instead: `$env:DATABASE_URL="<hosted url>"; pnpm db:seed:demo`.
The production Supabase database already has this data loaded.

| Exam | State | What to try |
|---|---|---|
| CS101 Data Structures - Midterm 2026 | Evaluation | 17 scripts covering every state: finalized, verified (controller to finalize), submitted (verifier queue), sent back (faculty1), draft, allocated, re-allocated, verified-but-unallocated, awaiting verification, on hold (missing page). Results + CSV. Paper download denied to faculty3 is logged. |
| CS102 Database Systems - Midterm 2026 | Paper preparation | Set A in reviewer queue, Set B in subject-head queue, Set C rejected with comments and a draft revision. |
| CS201 Operating Systems - End Semester 2026 | Paper preparation | Set A approved (faculty3 to finalize), Set B finalized (controller to release, then printing). |
| CS202 Computer Networks - Internal Assessment 1 | Marks finalized | Direct marksheet for all CSE students, seating + invigilation, revaluation window open: one approved, one under review, one rejected; student4/5 can still apply. |
| CS101 Data Structures - End Semester 2026 | Planned | Incomplete draft paper, room templates + seating plan, invigilation, question pool (one contribution pending review) and an auto-assembled Set B to materialize. |
| CS102 End Semester, ME101 Quiz 1, Midterm Examination - Data Structures (Mar 2027) | Planned | Timetable slots; the March exam has 6 ready 10/5-mark questions in the bank for a 50-mark paper. |
| EC101 Signals and Systems - Midterm 2026 | Marks finalized | ECE marksheet: visible to ECE heads, not CSE heads. |
| CS101 Data Structures - Internal Assessment 1 | Closed | Read-only historical exam with marks. |

## Conventions (shared contracts)
- **DB**: snake_case plural tables, `bigint` identity PKs, `timestamptz` (UTC), status via `CHECK`. Schema changes only via new numbered files in `database/migrations/` (never edit an applied one).
- **Modules**: `modules/<name>/<name>.routes.js` exporting an Express router; register in `app.js`.
- **Errors**: throw `AppError` subclasses from `config/errors.js`; handled centrally.
- **API responses**: `{ success: true, data }` or `{ success: false, error: { code, message, details? } }`.
- **Auth**: `requireAuth` then `requireRole('CODE', ...)` on every route; resource-level checks (course/owner) inside services.
- **Transactions**: use `withTransaction` from `config/database.js`; pass the client to `logAudit` so audit commits atomically.
- **Files**: stored under `storage/` (never statically served); delivered only through authorized routes.
- **Git**: feature branches, PR + 1 review, never commit `.env`, uploads or real data.

See `docs/permissions.md` and `docs/status.md`.

