-- 001_initial_schema.sql
-- Examination Management Platform - initial PostgreSQL schema.
-- Conventions: snake_case, plural table names, bigint identity PKs, timestamptz in UTC,
-- status values enforced with CHECK constraints, no cascading deletes on exam/audit records.

CREATE TABLE roles (
  id          smallint PRIMARY KEY,
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  description text
);

CREATE TABLE departments (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  password_hash text NOT NULL,
  role_id       smallint NOT NULL REFERENCES roles(id),
  department_id bigint REFERENCES departments(id),
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_role ON users(role_id);
CREATE INDEX idx_users_department ON users(department_id);

CREATE TABLE courses (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_id bigint NOT NULL REFERENCES departments(id),
  code          text NOT NULL UNIQUE,
  title         text NOT NULL,
  credits       smallint,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_courses_department ON courses(department_id);

CREATE TABLE faculty_courses (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  faculty_id  bigint NOT NULL REFERENCES users(id),
  course_id   bigint NOT NULL REFERENCES courses(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (faculty_id, course_id)
);
CREATE INDEX idx_faculty_courses_course ON faculty_courses(course_id);

-- Synthetic students only (no real data in development).
CREATE TABLE students (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_code  text NOT NULL UNIQUE,
  full_name     text NOT NULL,
  department_id bigint REFERENCES departments(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE examinations (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id        bigint NOT NULL REFERENCES courses(id),
  name             text NOT NULL,
  exam_type        text NOT NULL,
  exam_date        date NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes > 0),
  max_marks        numeric(6,2) NOT NULL CHECK (max_marks > 0),
  instructions     text,
  paper_deadline   timestamptz,
  evaluation_deadline timestamptz,
  status           text NOT NULL DEFAULT 'PLANNED'
                   CHECK (status IN ('PLANNED','PAPER_PREPARATION','CONDUCTED','EVALUATION','MARKS_FINALIZED','CLOSED')),
  created_by       bigint NOT NULL REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_examinations_course ON examinations(course_id);

-- Question bank ---------------------------------------------------------
CREATE TABLE questions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id   bigint NOT NULL REFERENCES courses(id),
  created_by  bigint NOT NULL REFERENCES users(id),
  question_type text NOT NULL CHECK (question_type IN ('MCQ','SHORT','DESCRIPTIVE')),
  body        text NOT NULL,
  marks       numeric(5,2) NOT NULL CHECK (marks > 0),
  difficulty  text CHECK (difficulty IN ('EASY','MEDIUM','HARD')),
  unit        text,
  topic       text,
  model_answer text,            -- answer key: restricted visibility
  is_archived boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_questions_course ON questions(course_id) WHERE NOT is_archived;

CREATE TABLE question_options (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question_id bigint NOT NULL REFERENCES questions(id),
  label       text NOT NULL,
  body        text NOT NULL,
  is_correct  boolean NOT NULL DEFAULT false,  -- restricted visibility
  UNIQUE (question_id, label)
);

-- Question papers: one per exam per set (A/B/C) ---------------------------
CREATE TABLE question_papers (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exam_id     bigint NOT NULL REFERENCES examinations(id),
  set_code    text NOT NULL DEFAULT 'A' CHECK (set_code ~ '^[A-Z]$'),
  created_by  bigint NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exam_id, set_code)
);

CREATE TABLE paper_versions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  paper_id      bigint NOT NULL REFERENCES question_papers(id),
  version_no    integer NOT NULL CHECK (version_no > 0),
  status        text NOT NULL DEFAULT 'DRAFT'
                CHECK (status IN ('DRAFT','SUBMITTED','UNDER_REVIEW','REJECTED','APPROVED','RELEASED_FOR_PRINTING','SUPERSEDED')),
  total_marks   numeric(6,2) NOT NULL DEFAULT 0,
  pdf_path      text,
  pdf_sha256    text,
  created_by    bigint NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  submitted_at  timestamptz,
  approved_at   timestamptz,
  superseded_at timestamptz,
  UNIQUE (paper_id, version_no)
);
-- At most one live (APPROVED / RELEASED) version per paper.
CREATE UNIQUE INDEX uq_paper_one_live_version
  ON paper_versions(paper_id) WHERE status IN ('APPROVED','RELEASED_FOR_PRINTING');

-- Snapshot of question content and marks per version (immutable once not DRAFT).
CREATE TABLE paper_questions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id       bigint NOT NULL REFERENCES paper_versions(id),
  source_question_id bigint REFERENCES questions(id),
  section_title    text NOT NULL DEFAULT 'Section A',
  display_no       text NOT NULL,
  position         integer NOT NULL,
  question_type    text NOT NULL,
  body             text NOT NULL,
  marks            numeric(5,2) NOT NULL CHECK (marks > 0),
  options_json     jsonb,         -- MCQ options WITHOUT correct flags
  UNIQUE (version_id, position)
);

CREATE TABLE paper_approvals (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id  bigint NOT NULL REFERENCES paper_versions(id),
  reviewer_id bigint NOT NULL REFERENCES users(id),
  decision    text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  comments    text,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (decision <> 'REJECTED' OR comments IS NOT NULL)
);
CREATE INDEX idx_paper_approvals_version ON paper_approvals(version_id);

CREATE TABLE paper_releases (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id  bigint NOT NULL UNIQUE REFERENCES paper_versions(id),
  released_by bigint NOT NULL REFERENCES users(id),
  released_at timestamptz NOT NULL DEFAULT now(),
  note        text
);

-- Answer scripts ----------------------------------------------------------
CREATE TABLE answer_scripts (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exam_id        bigint NOT NULL REFERENCES examinations(id),
  paper_id       bigint REFERENCES question_papers(id),   -- which set the student wrote
  student_id     bigint NOT NULL REFERENCES students(id),
  file_path      text NOT NULL,
  file_sha256    text NOT NULL,
  original_name  text,
  page_count     integer NOT NULL CHECK (page_count > 0),
  expected_pages integer CHECK (expected_pages > 0),
  is_complete    boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'UPLOADED'
                 CHECK (status IN ('UPLOADED','PENDING_VERIFICATION','VERIFIED','ALLOCATED','UNDER_EVALUATION','EVALUATED','MARKS_SUBMITTED','ON_HOLD')),
  hold_reason    text,
  uploaded_by    bigint NOT NULL REFERENCES users(id),
  verified_by    bigint REFERENCES users(id),
  verified_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exam_id, student_id)
);

CREATE TABLE script_allocations (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  script_id     bigint NOT NULL REFERENCES answer_scripts(id),
  faculty_id    bigint NOT NULL REFERENCES users(id),
  allocated_by  bigint NOT NULL REFERENCES users(id),
  reason        text,
  allocated_at  timestamptz NOT NULL DEFAULT now(),
  is_current    boolean NOT NULL DEFAULT true
);
-- Prevent duplicate active allocation of a script.
CREATE UNIQUE INDEX uq_script_one_current_allocation
  ON script_allocations(script_id) WHERE is_current;

-- Evaluation ----------------------------------------------------------------
CREATE TABLE evaluations (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  script_id     bigint NOT NULL UNIQUE REFERENCES answer_scripts(id),
  evaluator_id  bigint NOT NULL REFERENCES users(id),
  status        text NOT NULL DEFAULT 'DRAFT'
                CHECK (status IN ('DRAFT','SUBMITTED','VERIFIED','FINALIZED','REOPENED')),
  total_marks   numeric(6,2) NOT NULL DEFAULT 0,
  remarks       text,
  submitted_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE question_marks (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evaluation_id     bigint NOT NULL REFERENCES evaluations(id),
  paper_question_id bigint NOT NULL REFERENCES paper_questions(id),
  marks_awarded     numeric(5,2) CHECK (marks_awarded >= 0),
  comment           text,
  UNIQUE (evaluation_id, paper_question_id)
);

CREATE TABLE marks_submissions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evaluation_id bigint NOT NULL REFERENCES evaluations(id),
  action        text NOT NULL CHECK (action IN ('SUBMITTED','VERIFIED','FINALIZED','REOPENED','CORRECTED')),
  actor_id      bigint NOT NULL REFERENCES users(id),
  reason        text,
  total_before  numeric(6,2),
  total_after   numeric(6,2),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (action NOT IN ('REOPENED','CORRECTED') OR reason IS NOT NULL)
);
-- At most one FINALIZED record per evaluation unless reopened in between is handled in app logic.

-- Audit ---------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    bigint REFERENCES users(id),
  action      text NOT NULL,
  entity_type text,
  entity_id   bigint,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);

-- Session store (connect-pg-simple) ------------------------------------------
CREATE TABLE user_sessions (
  sid    varchar NOT NULL PRIMARY KEY,
  sess   json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX idx_user_sessions_expire ON user_sessions(expire);
