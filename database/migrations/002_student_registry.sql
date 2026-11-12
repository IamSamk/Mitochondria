-- 002_student_registry.sql
-- Give the student registry first-class lifecycle fields so administrators can
-- correct and retire records without deleting historical scripts/results.

ALTER TABLE students
  ADD COLUMN is_active  boolean NOT NULL DEFAULT true,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX idx_students_department ON students(department_id);
CREATE INDEX idx_students_active ON students(is_active);
