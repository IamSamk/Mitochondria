-- 006_seating_templates.sql
ALTER TABLE seating_allocations
  ADD COLUMN row_no integer,
  ADD COLUMN col_no integer;

CREATE TABLE room_templates (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       text NOT NULL,
  rows       integer NOT NULL CHECK (rows BETWEEN 1 AND 100),
  cols       integer NOT NULL CHECK (cols BETWEEN 1 AND 100),
  created_by bigint NOT NULL REFERENCES users(id),
  is_shared  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_room_templates_creator ON room_templates(created_by);

CREATE TABLE exam_room_instances (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exam_id      bigint NOT NULL REFERENCES examinations(id),
  template_id  bigint NOT NULL REFERENCES room_templates(id),
  room_number  text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_exam_room_instances_exam ON exam_room_instances(exam_id);
