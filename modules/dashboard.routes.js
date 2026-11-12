const express = require('express');
const { query } = require('../config/database');
const { requireAuth } = require('../middleware/auth.middleware');
const { requireRole } = require('../middleware/role.middleware');
const academics = require('./academics/academics.service');
const exams = require('./examinations/examinations.service');
const papers = require('./question-papers/question-papers.service');
const evaluations = require('./evaluations/evaluations.service');
const scripts = require('./answer-scripts/answer-scripts.service');
const approvals = require('./approvals/approvals.service');

const router = express.Router();

const count = async (sql, params = []) => (await query(sql, params)).rows[0].n;

function fmtDate(value, withTime = false) {
  if (!value) return '—';
  const iso = new Date(value).toISOString();
  return withTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

function when(value) {
  return fmtDate(value, true);
}

async function adminView() {
  const [users, departments, courses, auditToday, recent] = await Promise.all([
    count('SELECT count(*)::int AS n FROM users WHERE is_active'),
    count('SELECT count(*)::int AS n FROM departments WHERE is_active'),
    count('SELECT count(*)::int AS n FROM courses WHERE is_active'),
    count(`SELECT count(*)::int AS n FROM audit_logs WHERE created_at >= now() - interval '24 hours'`),
    query(`SELECT a.action, a.entity_type, a.created_at, u.full_name AS actor_name
             FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
            ORDER BY a.created_at DESC, a.id DESC LIMIT 8`)
  ]);
  return {
    cards: [
      { label: 'Active users', value: users, href: '/admin/users' },
      { label: 'Departments', value: departments, href: '/admin/academics' },
      { label: 'Courses', value: courses, href: '/admin/academics' },
      { label: 'Audit events (24h)', value: auditToday, href: '/admin/audit' }
    ],
    tables: [{
      title: 'Recent activity', href: '/admin/audit', columns: ['When', 'Actor', 'Action', 'Entity'],
      empty: 'No audit activity yet.',
      rows: recent.rows.map((r) => [when(r.created_at), r.actor_name || 'System', r.action, r.entity_type || '—'])
    }]
  };
}

async function controllerView(user) {
  const [openExams, awaitingRelease, pendingScripts, awaitingFinalize, finalized, recentExams, releaseRows, scriptRows] =
    await Promise.all([
      count(`SELECT count(*)::int AS n FROM examinations WHERE status <> 'CLOSED'`),
      count(`SELECT count(*)::int AS n FROM paper_versions WHERE status = 'APPROVED'`),
      count(`SELECT count(*)::int AS n FROM answer_scripts
              WHERE status IN ('UPLOADED','PENDING_VERIFICATION','ON_HOLD')`),
      count(`SELECT count(*)::int AS n FROM evaluations WHERE status = 'VERIFIED'`),
      count(`SELECT count(*)::int AS n FROM evaluations WHERE status = 'FINALIZED'`),
      exams.listExams({}),
      papers.listAllPapers({ status: 'APPROVED' }),
      query(`SELECT s.id, st.student_code, st.full_name AS student_name, s.status, s.page_count,
                    e.name AS exam_name
               FROM answer_scripts s
               JOIN students st ON st.id = s.student_id
               JOIN examinations e ON e.id = s.exam_id
              WHERE s.status IN ('UPLOADED','PENDING_VERIFICATION','ON_HOLD')
              ORDER BY s.created_at DESC LIMIT 6`)
    ]);
  const queue = await evaluations.listEvaluations({ status: 'VERIFIED' });
  return {
    cards: [
      { label: 'Open examinations', value: openExams, href: '/controller/exams' },
      { label: 'Papers awaiting release', value: awaitingRelease, href: '/controller/papers' },
      { label: 'Scripts needing attention', value: pendingScripts, href: '/controller/scripts' },
      { label: 'Marks awaiting finalize', value: awaitingFinalize, href: '/controller/marks?status=VERIFIED', note: `${finalized} finalized` }
    ],
    tables: [
      {
        title: 'Recent examinations', href: '/controller/exams', columns: ['Exam', 'Course', 'Date', 'Status'],
        empty: 'No examinations yet.',
        rows: recentExams.slice(0, 6).map((e) => [e.name, e.course_code, fmtDate(e.exam_date), e.status.replaceAll('_', ' ')])
      },
      {
        title: 'Approved papers awaiting release', href: '/controller/papers', columns: ['Exam', 'Set', 'Version', 'Marks'],
        empty: 'Nothing awaiting release.',
        rows: releaseRows.slice(0, 6).map((p) => [p.exam_name, p.set_code, `v${p.version_no}`, Number(p.total_marks)])
      },
      {
        title: 'Scripts waiting for verification', href: '/controller/scripts', columns: ['Student', 'Exam', 'Status', 'Pages'],
        empty: 'No scripts waiting.',
        rows: scriptRows.rows.map((s) => [s.student_code, s.exam_name, s.status.replaceAll('_', ' '), s.page_count])
      },
      {
        title: 'Verified marks awaiting finalization', href: '/controller/marks?status=VERIFIED', columns: ['Student', 'Exam', 'Marks', 'Evaluator'],
        empty: 'Nothing waiting to be finalized.',
        rows: queue.slice(0, 6).map((ev) => [ev.student_code, ev.exam_name, Number(ev.total_marks), ev.evaluator_name])
      }
    ]
  };
}

async function facultyView(user) {
  const courseIds = await academics.facultyCourseIds(user.id);
  const [questions, queue, myPapers] = await Promise.all([
    courseIds.length
      ? count(`SELECT count(*)::int AS n FROM questions WHERE NOT is_archived AND course_id = ANY($1::bigint[])`, [courseIds])
      : 0,
    evaluations.listFacultyQueue(user.id),
    papers.listPapersForFaculty(user.id)
  ]);
  const pending = queue.filter((q) => !q.evaluation_status || ['DRAFT', 'REOPENED'].includes(q.evaluation_status));
  const submitted = queue.filter((q) => ['SUBMITTED', 'VERIFIED', 'FINALIZED'].includes(q.evaluation_status));
  const drafts = myPapers.filter((p) => ['DRAFT', 'REJECTED'].includes(p.version_status));
  return {
    cards: [
      { label: 'Assigned courses', value: courseIds.length, href: '/faculty/questions' },
      { label: 'Bank questions', value: questions, href: '/faculty/questions' },
      { label: 'Scripts to evaluate', value: pending.length, href: '/faculty/evaluations', note: `${submitted.length} submitted` },
      { label: 'Paper work', value: drafts.length, href: '/faculty/papers', note: 'draft or rejected' }
    ],
    tables: [
      {
        title: 'My evaluation queue', href: '/faculty/evaluations', columns: ['Student', 'Exam', 'Status', 'Marks'],
        empty: 'No scripts allocated to you yet.',
        rows: queue.slice(0, 6).map((q) => [
          q.student_code, q.exam_name, (q.evaluation_status || 'NOT STARTED').replaceAll('_', ' '),
          q.evaluation_marks !== null && q.evaluation_marks !== undefined ? Number(q.evaluation_marks) : '—'
        ])
      },
      {
        title: 'Papers needing attention', href: '/faculty/papers', columns: ['Exam', 'Set', 'Version', 'Status'],
        empty: 'No draft or rejected papers.',
        rows: drafts.slice(0, 6).map((p) => [p.exam_name, p.set_code, `v${p.version_no}`, p.version_status.replaceAll('_', ' ')])
      }
    ]
  };
}

async function reviewerView(user) {
  const [queue, decisions, recent] = await Promise.all([
    approvals.listQueue(),
    query(`SELECT decision, count(*)::int AS n FROM paper_approvals
            WHERE reviewer_id = $1 GROUP BY decision`, [user.id]),
    approvals.recentDecisions(user.id)
  ]);
  const counts = decisions.rows.reduce((acc, row) => { acc[row.decision] = row.n; return acc; }, {});
  return {
    cards: [
      { label: 'Papers to review', value: queue.length, href: '/reviewer/papers' },
      { label: 'Approved by me', value: counts.APPROVED || 0, href: '/reviewer/papers' },
      { label: 'Rejected by me', value: counts.REJECTED || 0, href: '/reviewer/papers' }
    ],
    tables: [
      {
        title: 'Review queue', href: '/reviewer/papers', columns: ['Exam', 'Course', 'Set', 'Submitted'],
        empty: 'The review queue is empty.',
        rows: queue.slice(0, 8).map((p) => [p.exam_name, p.course_code, `${p.set_code} v${p.version_no}`, when(p.submitted_at)])
      },
      {
        title: 'My recent decisions', href: '/reviewer/papers', columns: ['When', 'Exam', 'Set', 'Decision'],
        empty: 'No decisions yet.',
        rows: recent.map((r) => [when(r.decided_at), r.exam_name, `${r.set_code} v${r.version_no}`, r.decision])
      }
    ]
  };
}

async function printingView() {
  const released = await papers.listReleased();
  const last7 = await count(`SELECT count(*)::int AS n FROM paper_releases
                              WHERE released_at >= now() - interval '7 days'`);
  return {
    cards: [
      { label: 'Released papers', value: released.length, href: '/printing/papers' },
      { label: 'Released this week', value: last7, href: '/printing/papers' }
    ],
    tables: [{
      title: 'Ready to print', href: '/printing/papers', columns: ['Exam', 'Course', 'Set', 'Marks', 'Released'],
      empty: 'No papers have been released for printing.',
      rows: released.slice(0, 8).map((p) => [
        p.exam_name, p.course_code, `${p.set_code} v${p.version_no}`, Number(p.total_marks), when(p.released_at)
      ])
    }]
  };
}

async function verifierView() {
  const list = await evaluations.listEvaluations({});
  const counts = list.reduce((acc, row) => { acc[row.status] = (acc[row.status] || 0) + 1; return acc; }, {});
  return {
    cards: [
      { label: 'Awaiting verification', value: counts.SUBMITTED || 0, href: '/verifier/marks?status=SUBMITTED' },
      { label: 'Sent back for correction', value: counts.REOPENED || 0, href: '/verifier/marks?status=REOPENED' },
      { label: 'Verified', value: counts.VERIFIED || 0, href: '/verifier/marks?status=VERIFIED' },
      { label: 'Finalized', value: counts.FINALIZED || 0, href: '/controller/results' }
    ],
    tables: [{
      title: 'Marks awaiting verification', href: '/verifier/marks?status=SUBMITTED',
      columns: ['Student', 'Exam', 'Marks', 'Evaluator'],
      empty: 'Nothing is waiting for verification.',
      rows: list.filter((ev) => ev.status === 'SUBMITTED').slice(0, 8).map((ev) => [
        ev.student_code, ev.exam_name, Number(ev.total_marks), ev.evaluator_name
      ])
    }]
  };
}

router.get('/dashboard', requireAuth, async (req, res, next) => {
  try {
    const user = req.session.user;
    const view = await ({
      ADMIN: () => adminView(),
      CONTROLLER: () => controllerView(user),
      FACULTY: () => facultyView(user),
      REVIEWER: () => reviewerView(user),
      PRINTING: () => printingView(),
      VERIFIER: () => verifierView()
    }[user.role] || (() => ({ cards: [], tables: [] })))();
    res.render('dashboard', { ...view, title: 'Dashboard' });
  } catch (e) { next(e); }
});

router.get('/', (req, res) => res.redirect(req.session.user ? '/dashboard' : '/login'));
router.get('/admin', requireAuth, requireRole('ADMIN'), (req, res) => res.redirect('/dashboard'));

module.exports = router;
