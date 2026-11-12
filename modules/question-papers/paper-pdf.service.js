const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { storageRoot, questionPaperDir, sha256File } = require('../../config/upload');

function fmtDate(value) {
  if (!value) return '—';
  return new Date(value).toISOString().slice(0, 10);
}

/**
 * Render an exam paper to PDF. Deliberately contains no answer-key data.
 * Returns { absPath, relPath, sha256 }.
 */
async function generatePaperPdf({ paper, version, exam, course, questions }) {
  const dir = path.join(questionPaperDir, String(paper.id));
  fs.mkdirSync(dir, { recursive: true });
  const absPath = path.join(dir, `set-${paper.set_code}-v${version.version_no}.pdf`);
  const relPath = path.relative(storageRoot, absPath).split(path.sep).join('/');

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 56, bottom: 56, left: 56, right: 56 },
      bufferPages: true,
      info: { Title: `${exam.name} — Set ${paper.set_code}`, Author: 'Examination Management Platform' }
    });
    const stream = fs.createWriteStream(absPath);
    doc.pipe(stream);
    doc.on('error', reject);
    stream.on('error', reject);
    stream.on('finish', resolve);

    doc.font('Helvetica-Bold').fontSize(16).text('Examination Management Platform', { align: 'center' });
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).text(course.title, { align: 'center' });
    doc.moveDown(0.6);
    doc.font('Helvetica-Bold').fontSize(13).text(exam.name, { align: 'center' });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9)
      .text(`Course: ${course.code} — ${course.title}   |   Set: ${paper.set_code}   |   Version: ${version.version_no}`, { align: 'center' });
    doc.text(`Date: ${fmtDate(exam.exam_date)}   |   Duration: ${exam.duration_minutes} minutes   |   Maximum marks: ${Number(exam.max_marks)}`, { align: 'center' });
    doc.moveDown(0.7);
    doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor('#999999').stroke();
    doc.moveDown(0.6);

    if (exam.instructions) {
      doc.font('Helvetica-Bold').fontSize(9).text('Instructions');
      doc.font('Helvetica').fontSize(9).text(exam.instructions, { width: 483 });
      doc.moveDown(0.6);
    }

    let currentSection = null;
    for (const q of questions) {
      if (q.section_title !== currentSection) {
        currentSection = q.section_title;
        doc.moveDown(0.4);
        doc.font('Helvetica-Bold').fontSize(11).text(currentSection);
        doc.moveDown(0.3);
      }
      const startY = doc.y;
      doc.font('Helvetica-Bold').fontSize(10).text(`${q.display_no}.`, 56, startY, { width: 24, continued: false });
      doc.font('Helvetica').fontSize(10).text(q.body, 84, startY, { width: 420 });
      doc.font('Helvetica-Bold').fontSize(9).text(`[${Number(q.marks)}]`, 500, startY, { width: 39, align: 'right' });

      if (Array.isArray(q.options_json) && q.options_json.length) {
        doc.moveDown(0.2);
        for (const o of q.options_json) {
          doc.font('Helvetica').fontSize(9).text(`${o.label}. ${o.body}`, 96, doc.y, { width: 400 });
        }
      }
      doc.moveDown(0.7);
      if (doc.y > 720) doc.addPage();
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(8).fillColor('#666666')
        .text(`Page ${i + 1} of ${range.count}`, 56, 800, { width: 483, align: 'center' });
    }
    doc.end();
  });

  const sha256 = await sha256File(absPath);
  return { absPath, relPath, sha256 };
}

module.exports = { generatePaperPdf };
