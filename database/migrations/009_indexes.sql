-- 009_indexes.sql
-- Indexes for the hot paths added by the workflow, portal, and reporting modules.

-- Login: authentication looks up users by lower(email).
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email));

-- Paper workflow lookups.
CREATE INDEX IF NOT EXISTS idx_paper_versions_paper ON paper_versions (paper_id);
CREATE INDEX IF NOT EXISTS idx_paper_approvals_version ON paper_approvals (version_id);
CREATE INDEX IF NOT EXISTS idx_paper_releases_version ON paper_releases (version_id);
CREATE INDEX IF NOT EXISTS idx_paper_questions_version ON paper_questions (version_id);

-- Scripts, allocations, evaluations.
CREATE INDEX IF NOT EXISTS idx_answer_scripts_exam ON answer_scripts (exam_id);
CREATE INDEX IF NOT EXISTS idx_answer_scripts_student ON answer_scripts (student_id);
CREATE INDEX IF NOT EXISTS idx_script_allocations_faculty_current ON script_allocations (faculty_id, is_current);
CREATE INDEX IF NOT EXISTS idx_evaluations_script ON evaluations (script_id);
CREATE INDEX IF NOT EXISTS idx_evaluations_status ON evaluations (status);

-- Marks and results.
CREATE INDEX IF NOT EXISTS idx_exam_marks_student ON exam_marks (student_id);
CREATE INDEX IF NOT EXISTS idx_question_marks_evaluation ON question_marks (evaluation_id);
CREATE INDEX IF NOT EXISTS idx_marks_submissions_evaluation ON marks_submissions (evaluation_id);

-- Student portal.
CREATE INDEX IF NOT EXISTS idx_seating_allocations_student ON seating_allocations (student_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC);

-- Revaluation.
CREATE INDEX IF NOT EXISTS idx_reval_requests_student_exam ON revaluation_requests (student_id, exam_id);
CREATE INDEX IF NOT EXISTS idx_reval_windows_exam_open ON revaluation_windows (exam_id, opens_at, closes_at);

-- Question assembly and timetable.
CREATE INDEX IF NOT EXISTS idx_qcontrib_status ON question_contributions (status, course_id);
CREATE INDEX IF NOT EXISTS idx_qassembly_exam ON question_assemblies (exam_id);
CREATE INDEX IF NOT EXISTS idx_exam_slots_exam_start ON exam_slots (exam_id, slot_start);
