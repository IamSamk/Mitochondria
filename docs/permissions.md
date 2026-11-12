# Role-Permission Matrix (draft v2)

Decisions confirmed by the team: multiple paper sets (A/B/C); separate Reviewer, Printing Coordinator and Marks Verifier; **no** separate Answer Script Coordinator (Controller does it); one evaluator per script with student ID visible; staff-only results (no student portal). The **Subject Head** and **Department Head** supervise the same department scope; the subject head acts (approves/vetoes), while the department head is read-only apart from comments.

Legend: ✔ allowed, own = only own records / assigned courses / own department, — denied.

| Capability | Admin | Controller | Faculty | Reviewer | Printing | Verifier | Subject Head | Dept. Head |
|---|---|---|---|---|---|---|---|---|
| Manage users / roles / deactivate | ✔ | — | — | — | — | — | — | — |
| Manage student registry (add/edit/deactivate) | ✔ | — | — | — | — | — | — | — |
| View/update own profile, change own password | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Manage departments, courses, faculty-course assignment | ✔ | — | — | — | — | — | — | — |
| View audit log | ✔ | — | — | — | — | — | — | — |
| Create/edit examinations, deadlines | — | ✔ | — | — | — | — | — | — |
| Create/edit questions | — | — | own courses | — | — | — | — | — |
| View answer keys | — | — | own courses | — | — | — | — | — |
| Assemble paper sets, save drafts repeatedly, submit, revise | — | — | own courses | — | — | — | — | — |
| Finalize own approved paper | — | — | own paper | — | — | — | — | — |
| Approve / reject papers (reviewer stage) | — | — | — | ✔ | — | — | — | — |
| Head-approve a submission into the reviewer queue | — | — | — | — | — | — | own dept | — |
| Veto a paper before release (clears finalization) | — | — | — | — | — | — | own dept | — |
| Comment on papers / individual questions | ✔ | ✔ | own dept | ✔ | — | — | own dept | own dept |
| Release approved + finalized version for printing | — | ✔ | — | — | — | — | — | — |
| Download paper PDF (role/status-gated) | ✔ | ✔ | own paper | reviewable sets | released only | — | own dept, non-draft | own dept, non-draft |
| Review unauthorised download attempts, clear freeze | ✔ | — | own paper | — | — | — | — | — |
| Set optional paper download password | ✔ | — | own paper | — | — | — | — | — |
| Upload / verify / allocate scripts | — | ✔ | — | — | — | — | — | — |
| View scripts | — | ✔ | allocated only | — | — | ✔ (read) | — | — |
| Enter marks / submit evaluation | — | — | allocated only | — | — | — | — | — |
| Enter/import/edit direct exam marksheets | — | — | own courses | — | — | — | — | — |
| View department marksheets (read-only) | — | — | — | — | — | — | own dept | own dept |
| Generate/edit seating and invigilation | — | — | own courses | — | — | — | — | — |
| View department seating and invigilation | — | — | — | — | — | — | own dept | own dept |
| Verify marks, request correction | — | — | — | — | — | ✔ | — | — |
| Finalize marks, reopen with reason | — | ✔ | — | — | — | ✔ (verify step) | — | — |
| Reports / mark sheets / CSV | — | ✔ | own evaluations | — | — | ✔ | own dept (read) | own dept (read) |

Resolved: **finalize is Controller-only**; the Verifier verifies a submitted evaluation or sends it back with a reason, and the Controller finalizes verified marks or reopens finalized ones with a reason. Student registry records are managed by Admin and are never sign-in accounts (no student portal). Paper status flow: `DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → RELEASED_FOR_PRINTING`, with subject-head veto possible at `SUBMITTED`/`UNDER_REVIEW`/`APPROVED`; the teacher finalizes an `APPROVED` paper before the controller can release it.

Student portal: the `STUDENT` role is scoped to its own record — upcoming exams in the department, published results, assigned seat, notifications, and revaluation applications. Heads and faculty have no access to student portal routes or data.
