-- 004_student_portal.sql
-- Student sign-in accounts, notifications, and bulk-import support.

ALTER TABLE students
  ADD COLUMN user_id bigint REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN email    text;

CREATE UNIQUE INDEX idx_students_user ON students(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_students_email ON students(email);

-- In-app notifications for every role, but primarily students.
CREATE TABLE notifications (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  title      text NOT NULL,
  body       text,
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user_unread
  ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;
CREATE INDEX idx_notifications_user_all
  ON notifications(user_id, created_at DESC);
