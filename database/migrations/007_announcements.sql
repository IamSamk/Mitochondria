-- 007_announcements.sql
CREATE TABLE announcements (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title         text NOT NULL,
  body          text NOT NULL,
  audience_role text,
  department_id bigint REFERENCES departments(id),
  created_by    bigint NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_announcements_dept ON announcements(department_id, created_at DESC);
CREATE INDEX idx_announcements_role ON announcements(audience_role, created_at DESC);
