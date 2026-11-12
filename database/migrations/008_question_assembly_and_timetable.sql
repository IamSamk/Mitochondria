-- 008_question_assembly_and_timetable.sql
CREATE TABLE question_contributions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id     bigint NOT NULL REFERENCES courses(id),
  author_id     bigint NOT NULL REFERENCES users(id),
  body          text NOT NULL,
  question_type text NOT NULL CHECK (question_type IN ('MCQ','SHORT','DESCRIPTIVE')),
  marks         numeric(6,2) NOT NULL CHECK (marks > 0),
  difficulty    text NOT NULL CHECK (difficulty IN ('EASY','MEDIUM','HARD')),
  topic         text,
  answer_key    text,
  status        text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','APPROVED','REJECTED','USED')),
  score         numeric(4,2),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_qcontrib_course ON question_contributions(course_id, status);

CREATE TABLE question_reviews (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contribution_id     bigint NOT NULL REFERENCES question_contributions(id) ON DELETE CASCADE,
  reviewer_id         bigint NOT NULL REFERENCES users(id),
  clarity             smallint NOT NULL CHECK (clarity BETWEEN 1 AND 5),
  difficulty_accuracy smallint NOT NULL CHECK (difficulty_accuracy BETWEEN 1 AND 5),
  correctness         smallint NOT NULL CHECK (correctness BETWEEN 1 AND 5),
  comments            text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contribution_id, reviewer_id)
);

CREATE TABLE question_assemblies (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exam_id     bigint NOT NULL REFERENCES examinations(id),
  set_code    char(1) NOT NULL,
  created_by  bigint NOT NULL REFERENCES users(id),
  status      text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','FINALIZED')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE question_assembly_items (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assembly_id      bigint NOT NULL REFERENCES question_assemblies(id) ON DELETE CASCADE,
  contribution_id  bigint NOT NULL REFERENCES question_contributions(id),
  position         integer NOT NULL,
  section_title    text,
  marks            numeric(6,2) NOT NULL,
  UNIQUE (assembly_id, contribution_id)
);

CREATE TABLE exam_slots (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exam_id     bigint NOT NULL REFERENCES examinations(id),
  slot_start  timestamptz NOT NULL,
  slot_end    timestamptz NOT NULL,
  venue       text,
  created_by  bigint NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (slot_end > slot_start)
);
CREATE INDEX idx_exam_slots_exam ON exam_slots(exam_id);
CREATE INDEX idx_exam_slots_time ON exam_slots(slot_start);

ALTER TABLE questions
  ADD COLUMN source_contribution_id bigint REFERENCES question_contributions(id);
