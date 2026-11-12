-- 003_role_workflows.sql
-- Adds subject-head / department-head supervision, draft saving and finalization,
-- question-paper comments, download access locks, direct marksheets, and
-- seating / invigilation planning.

-- Paper workflow additions ---------------------------------------------------
ALTER TABLE question_papers
  ADD COLUMN download_password_hash text;

ALTER TABLE paper_versions
  ADD COLUMN draft_saved_at timestamptz,
  ADD COLUMN is_finalized  boolean NOT NULL DEFAULT false;

CREATE TABLE paper_head_reviews (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id  bigint NOT NULL REFERENCES paper_versions(id),
  head_id     bigint NOT NULL REFERENCES users(id),
  decision    text NOT NULL CHECK (decision IN ('APPROVED','VETOED')),
  comments    text,
  decided_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (decision <> 'VETOED' OR comments IS NOT NULL)
);
CREATE INDEX idx_paper_head_reviews_version ON paper_head_reviews(version_id);

CREATE TABLE paper_comments (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  paper_id          bigint NOT NULL REFERENCES question_papers(id),
  version_id        bigint REFERENCES paper_versions(id),
  paper_question_id bigint REFERENCES paper_questions(id),
  author_id         bigint NOT NULL REFERENCES users(id),
  body              text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_paper_comments_paper ON paper_comments(paper_id, created_at);

-- Unauthorized download attempts lock the paper for 15 minutes.
CREATE TABLE paper_download_attempts (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  paper_id   bigint NOT NULL REFERENCES question_papers(id),
  user_id    bigint REFERENCES users(id),
  ip_address text,
  outcome    text NOT NULL CHECK (outcome IN ('DENIED','LOCKED','BAD_PASSWORD')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_paper_download_attempts_paper
  ON paper_download_attempts(paper_id, created_at DESC);

CREATE TABLE paper_download_locks (
  paper_id     bigint PRIMARY KEY REFERENCES question_papers(id),
  locked_until timestamptz NOT NULL,
  locked_by    bigint REFERENCES users(id),
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Direct marksheets uploaded by the subject teacher --------------------------
CREATE TABLE exam_marks (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exam_id        bigint NOT NULL REFERENCES examinations(id),
  student_id     bigint NOT NULL REFERENCES students(id),
  marks_obtained numeric(6,2) NOT NULL CHECK (marks_obtained >= 0),
  entered_by     bigint NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exam_id, student_id)
);
CREATE INDEX idx_exam_marks_exam ON exam_marks(exam_id);

-- Seating and invigilation ---------------------------------------------------
CREATE TABLE seating_allocations (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exam_id    bigint NOT NULL REFERENCES examinations(id),
  student_id bigint NOT NULL REFERENCES students(id),
  room_name  text NOT NULL,
  seat_no    integer NOT NULL CHECK (seat_no > 0),
  created_by bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exam_id, student_id),
  UNIQUE (exam_id, room_name, seat_no)
);
CREATE INDEX idx_seating_exam ON seating_allocations(exam_id);

CREATE TABLE invigilations (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exam_id        bigint NOT NULL REFERENCES examinations(id),
  room_name      text NOT NULL,
  invigilator_id bigint NOT NULL REFERENCES users(id),
  starts_at      timestamptz,
  ends_at        timestamptz,
  created_by     bigint NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (exam_id, room_name, invigilator_id)
);
CREATE INDEX idx_invigilations_exam ON invigilations(exam_id);
