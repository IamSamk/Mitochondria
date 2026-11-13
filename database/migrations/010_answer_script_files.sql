-- 010_answer_script_files.sql
-- Keep a durable copy of every uploaded answer-script PDF in the database.
-- Serverless hosts (Vercel) only have a temporary /tmp disk, so the on-disk file
-- disappears on cold start; the app restores it from here on demand.
-- Separate table so listing/querying answer_scripts never drags file bytes along.

CREATE TABLE answer_script_files (
  script_id  bigint PRIMARY KEY REFERENCES answer_scripts(id),
  content    bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
