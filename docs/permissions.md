# Role-Permission Matrix (draft v1)

Decisions confirmed by the team: multiple paper sets (A/B/C); separate Reviewer, Printing Coordinator and Marks Verifier; **no** separate Answer Script Coordinator (Controller does it); one evaluator per script with student ID visible; staff-only results (no student portal).

Legend: ✔ allowed, own = only own records / assigned courses, — denied.

| Capability | Admin | Controller | Faculty | Reviewer | Printing | Verifier |
|---|---|---|---|---|---|---|
| Manage users / roles / deactivate | ✔ | — | — | — | — | — |
| Manage departments, courses, faculty-course assignment | ✔ | — | — | — | — | — |
| View audit log | ✔ | — | — | — | — | — |
| Create/edit examinations, deadlines | — | ✔ | — | — | — | — |
| Create/edit questions | — | — | own courses | — | — | — |
| View answer keys | — | — | own courses | — | — | — |
| Assemble paper sets, submit for review, revise | — | — | own courses | — | — | — |
| Approve / reject papers | — | — | — | ✔ | — | — |
| Release approved version for printing | — | ✔ | — | — | — | — |
| Download released paper PDF | — | ✔ | — | — | ✔ (released only) | — |
| Upload / verify / allocate scripts | — | ✔ | — | — | — | — |
| View scripts | — | ✔ | allocated only | — | — | ✔ (read) |
| Enter marks / submit evaluation | — | — | allocated only | — | — | — |
| Verify marks, request correction | — | — | — | — | — | ✔ |
| Finalize marks, reopen with reason | — | ✔ | — | — | — | ✔ (verify step) |
| Reports / mark sheets / CSV | — | ✔ | own evaluations | — | — | ✔ |

Open item to confirm before the marks module: whether **finalize** is Controller-only or Verifier-only (currently: Verifier verifies, Controller finalizes).
