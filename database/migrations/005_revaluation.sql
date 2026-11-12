-- 005_revaluation.sql
CREATE TABLE revaluation_windows (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exam_id     bigint NOT NULL REFERENCES examinations(id),
  opens_at    timestamptz NOT NULL,
  closes_at   timestamptz NOT NULL,
  fee_amount  numeric(8,2) NOT NULL DEFAULT 0,
  created_by  bigint NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (closes_at > opens_at)
);
CREATE INDEX idx_reval_windows_exam ON revaluation_windows(exam_id);

CREATE TABLE revaluation_requests (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id  bigint NOT NULL REFERENCES students(id),
  exam_id     bigint NOT NULL REFERENCES examinations(id),
  reason      text NOT NULL,
  status      text NOT NULL DEFAULT 'SUBMITTED'
                CHECK (status IN ('SUBMITTED','UNDER_REVIEW','APPROVED','REJECTED','CLOSED')),
  fee_paid    boolean NOT NULL DEFAULT false,
  old_marks   numeric(6,2),
  new_marks   numeric(6,2),
  reviewer_id bigint REFERENCES users(id),
  resolved_at timestamptz,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_reval_requests_student ON revaluation_requests(student_id);
CREATE INDEX idx_reval_requests_exam ON revaluation_requests(exam_id);
CREATE INDEX idx_reval_requests_status ON revaluation_requests(status);
