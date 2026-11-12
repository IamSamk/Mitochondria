# Roadmap: Student portal, question assembly, notifications, and optimal seating

This plan extends the examination platform into a full student-facing, question-assembly,
and seating-optimisation system. It is organised into phases so each can be built and
tested independently. Nothing here is implemented yet; it is the design contract.

## 1. New role: STUDENT

- Add role id 9 `STUDENT` to `roles` (seeded) and to `config/navigation.js`:
  `Dashboard, My Exams, Results, Revaluation, My Seat`.
- Students are **records first, accounts second**: `students.user_id` (new FK to `users`)
  links a registry record to a sign-in account. A student may exist without an account
  (historical records) and an account may exist without a student record (staff).
- Google sign-in via `passport-google-oauth20`; on first login, match the OAuth email
  to an existing `students.user_id`-less record by email and link it, otherwise create
  a pending record requiring admin approval. Store `google_sub` on `users`.
- Bulk add: admin uploads CSV (`student_code, full_name, email, department_code`);
  service creates `students` rows and, when `createAccounts=true`, `users` rows with
  role `STUDENT`, a random unusable password, and `user_id` linkage. Idempotent on
  `student_code` and email.
- Admin UI gets a "Students & accounts" panel to assign/revoke the STUDENT role and
  link/unlink accounts. Subject/department heads **do not** get any student-portal or
  revaluation access (RBAC: only `ADMIN`, `CONTROLLER`, `FACULTY` where appropriate,
  `VERIFIER`, and the student themselves).

## 2. Notifications

Table `notifications(id, user_id, type, title, body, link, read_at, created_at)` with
index `(user_id, read_at, created_at DESC)`.

- Types: `EXAM_SCHEDULED`, `EXAM_REMINDER`, `RESULT_PUBLISHED`, `REVALUATION_UPDATE`,
  `PAPER_RELEASED` (staff), `SEAT_ASSIGNED`.
- `notifications.service.js`: `notify(users[], payload)` inserts rows in a transaction;
  optional email via `nodemailer` when `SMTP_*` env vars are set (graceful no-op
  otherwise).
- Triggers:
  - Controller publishes/updates an exam schedule → notify all active students in the
    exam's department (and any explicitly enrolled cohort).
  - 24h and 1h before `exam_date` → reminder (cron via `node-cron` or a Vercel cron).
  - Result finalised → notify each student with their marks and a link.
  - Seat assigned → notify student with room/seat.
- UI: bell icon in header with unread count; `/notifications` page with mark-as-read.

## 3. Question assembly (CodeTendra-style)

Extend the question bank into a **contributed question pool**:

Tables:
- `question_contributions(id, course_id, author_id, body, question_type, marks,
  difficulty, topic, answer_key, status, score, created_at, updated_at)` — teachers
  submit; status `PENDING | APPROVED | REJECTED | USED`.
- `question_reviews(id, contribution_id, reviewer_id, clarity, difficulty_accuracy,
  correctness, comments, created_at)` — subject heads/reviewers score 1–5 on each
  axis; aggregate `score = avg(clarity+difficulty_accuracy+correctness)`.
- `question_assemblies(id, exam_id, set_code, created_by, status, created_at)` and
  `question_assembly_items(id, assembly_id, contribution_id, position, section_title,
  marks)` — a paper is assembled from approved contributions.

Workflow:
1. Faculty submit questions to the pool (reuse existing `questions` table or migrate
   into `question_contributions`; keep `questions` as the canonical bank and add a
   `source_contribution_id` FK so assembled papers trace back).
2. Subject head/reviewer reviews the pool, scores, approves/rejects.
3. Assembly screen (controller or subject head): choose topics, difficulty mix, and
   total marks; service greedily selects approved contributions to hit the mark total
   with balanced difficulty; manual override allowed.
4. Approved assembly → generates a `paper_version` (reusing existing PDF pipeline) and
   enters the existing head/reviewer/finalize/release flow.

RBAC: faculty submit own; subject head reviews own department; controller assembles;
reviewer can score.

## 4. Revaluation

Tables:
- `revaluation_windows(id, exam_id, opens_at, closes_at, fee_amount, created_by)`.
- `revaluation_requests(id, student_id, exam_id, result_id, reason, status, fee_paid,
  created_at, resolved_by, resolved_at, old_marks, new_marks, notes)`.
  status: `SUBMITTED | UNDER_REVIEW | APPROVED | REJECTED | CLOSED`.

Workflow:
- Student applies within an open window, pays fee (recorded, not processed online
  initially), submits reason.
- Faculty/verifier reviews the script (reuses answer-script download), decides.
- On approval, marks updated in `results`/`exam_marks` with an audit entry and
  `new_marks` recorded; student notified.

RBAC: student owns their requests; faculty/verifier review; controller opens/closes
windows; admin overrides.

## 5. Optimal seating algorithm (DSA)

### 5.1 Data model

- `room_templates(id, name, rows, cols, created_by, is_shared)` — faculty/admin
  templates; grid up to 100×100. A template implies `capacity = rows*cols`.
- `exam_rooms(id, exam_id, template_id, room_number, display_order)` — an exam's
  chosen rooms, each assigned a template and a room number.
- `seating_plans(id, exam_id, generated_by, algorithm, params, created_at)` and
  `seating_seats(id, plan_id, student_id, exam_room_id, row, col, seat_no)`.

### 5.2 Input

For an exam (or a combined session of multiple exams):
- `students[]` each tagged with `examId` (the exam they sit) and `studentId`.
- `rooms[]` each with `template` (rows, cols) and `roomNumber`.

### 5.3 Constraints & objective

- Primary: no two adjacent seats (8-neighbourhood) hold students of the **same**
  exam, to prevent copying in mixed halls.
- Secondary: balance room utilisation; avoid a student sitting next to someone with
  an adjacent exam slot (scheduling constraint, see §6).
- Tertiary: deterministic, reproducible output (seeded RNG) so re-runs are stable.

### 5.4 Algorithm

Use a **greedy constructive placement with backtracking fallback**, backed by a
max-heap (priority queue) of exam groups:

1. Sort exams by descending student count (largest-first) to avoid fragmentation.
2. For each room in order, create an empty `rows × cols` grid initialised to `null`.
3. Maintain for each exam a remaining-student queue (FIFO by student code).
4. Placement loop (repeat until all students placed or no room left):
   a. Pick the exam with the most remaining students whose placement is feasible
      (max-heap by remaining count, tie-break by exam id).
   b. Find the best cell in the current room using a scoring function:
      `score(cell) = -(number of already-placed neighbours with the same exam)`
      plus a small penalty for cells whose neighbours are of the *same exam as the
      candidate's next exam slot* (scheduling). Choose the cell with the lowest score
      (most negative = most constrained); break ties by row-major order.
   c. Place the next student of that exam in the cell; mark occupied.
   d. If no cell in the current room can accept any exam without a same-exam
      neighbour, move to the next room; if none left, invoke backtracking.
5. **Backtracking fallback** (only when greedy leaves unplaced students or violates
   a hard constraint): depth-first search over remaining (student, cell) pairs with
   MRV (fewest legal cells first) and forward checking; prune when a remaining
   student has zero legal cells. Cap backtracking at a configurable node limit
   (e.g. 10^5) and fall back to "best-effort" placement with a violation report
   if exceeded.
6. After placement, assign `seat_no` by row-major order per room and persist.

Data structures:
- `Grid`: 2D array `cell[examId | null]`.
- `MaxHeap<ExamGroup>` keyed by `remaining`.
- `Map<studentId, {roomId,row,col}>` for O(1) lookup.
- `Set` of occupied cells per room.
- Adjacency via 8-direction offsets.

Complexity: O(S · R · C) greedy where S students, R rooms, C cells per room, plus
O(B) backtracking in the worst case (exponential, but bounded by the node cap).
For 100×100 rooms this is ~10^4 cells per room and trivially fast.

### 5.5 Faculty UX for templates

- "Seating templates" page: list/create/edit templates. Choose dimensions via
  presets (30×30, 50×50, 100×100) or custom (≤100 each). Preview grid.
- When generating a plan: select one or more templates, assign a room number to each
  instance (e.g. template A × 5 rooms numbered 101–105, template B × 6 rooms).
- "Generate" runs the algorithm and shows a visual grid per room with student codes;
  faculty can drag-and-drop to override, then save. Overrides are recorded in
  `seating_seats.overridden_by`.

### 5.6 Conflict-aware scheduling (exam timetable)

- `exam_slots(id, exam_id, slot_start, slot_end, venue)` plus a conflict graph where
  two exams conflict if they share a student.
- Greedy graph colouring assigns slots minimising the number of slots while ensuring
  no student has two exams in the same or adjacent slot; backtracking fallback for
  small graphs.
- This feeds the seating constraint in §5.3 (adjacent-slot exams should not be
  neighbours).

## 6. Announcing papers, scores, results

- Controller/faculty can mark a result set as `PUBLISHED`; students see it on
  `/results` and receive a `RESULT_PUBLISHED` notification.
- Paper announcements: when a paper is released for printing, notify relevant
  faculty/heads (not students, to preserve confidentiality) — students only learn
  exam logistics.
- Faculty dashboard gains "Announcements" composer for department-wide notices
  (stored in `announcements` table, targeted by role/department).

## 7. Phase plan

| Phase | Scope | Key deliverables |
|---|---|---|
| P1 | Student accounts & portal | `STUDENT` role, Google OAuth, bulk import, `/student/*` routes, notifications table + bell |
| P2 | Notifications & scheduling | Exam schedule publish, reminders, result/seat notifications |
| P3 | Question assembly | Contribution pool, reviews/scoring, assembly → paper_version |
| P4 | Revaluation | Windows, requests, review, mark adjustment, audit |
| P5 | Seating templates & algorithm | Templates, multi-room plans, greedy+backtracking, visual editor |
| P6 | Timetable conflict solver | Conflict graph, slot colouring, integration with seating |
| P7 | Announcements & polish | Department notices, dashboards, docs, tests |

Each phase ships with migration(s), services, routes, views, and tests; the
automated suite must stay green and the dev DB must be re-seeded.

## 8. Open questions for the team

1. Should Google sign-in be the only student auth, or also email/password for
   students without Google accounts?
2. Is the revaluation fee recorded only, or integrated with a payment gateway?
3. Seating: should the algorithm also separate students by branch/section, or only
   by exam?
4. Question scoring: who reviews (subject head only, or any reviewer)? Minimum
   score threshold for inclusion?
5. Notification delivery: in-app only, or email/SMS as well?
6. Timetable: fixed slots provided by the college, or system-generated?
