# Examination Management Platform

Classroom project: digitizes the exam lifecycle from question-paper preparation to final marks.
Modular monolith: Node.js + Express 5, EJS, Bootstrap 5, **PostgreSQL**, **pnpm**.

> Stack change vs. the original brief: PostgreSQL (`pg`, `connect-pg-simple`) replaces MySQL; pnpm replaces npm.

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
`pnpm db:reset` drops and recreates the dev schema (never in production).

## Demo accounts (synthetic; password `Demo@12345`)
| Role | Email |
|---|---|
| Admin | admin@college.test |
| Controller | controller@college.test |
| Faculty (CS101) | faculty1@college.test |
| Faculty (CS102) | faculty2@college.test |
| Reviewer | reviewer@college.test |
| Printing Coordinator | printing@college.test |
| Marks Verifier | verifier@college.test |

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
