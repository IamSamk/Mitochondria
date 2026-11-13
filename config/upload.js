const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { ForbiddenError } = require('./errors');

// All protected uploads live under STORAGE_DIR (never under public/).
const storageRoot = path.resolve(__dirname, '..', process.env.STORAGE_DIR || 'storage');
const answerScriptDir = path.join(storageRoot, 'answer-scripts');
const questionPaperDir = path.join(storageRoot, 'question-papers');
for (const dir of [answerScriptDir, questionPaperDir]) fs.mkdirSync(dir, { recursive: true });

const maxUploadMb = Number(process.env.MAX_UPLOAD_MB) > 0 ? Number(process.env.MAX_UPLOAD_MB) : 25;

const answerScriptStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, answerScriptDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(16).toString('hex')}.pdf`)
});

function pdfOnly(req, file, cb) {
  const looksPdf = file.mimetype === 'application/pdf' && /\.pdf$/i.test(file.originalname || '');
  if (!looksPdf) {
    const err = new Error('Only PDF files are accepted');
    err.status = 422;
    err.code = 'INVALID_FILE_TYPE';
    return cb(err);
  }
  return cb(null, true);
}

const uploadAnswerScript = multer({
  storage: answerScriptStorage,
  limits: { fileSize: maxUploadMb * 1024 * 1024, files: 1 },
  fileFilter: pdfOnly
}).single('script');

/** Resolve an absolute path stored in the DB, refusing anything outside storage/. */
function resolveStoragePath(relativePath) {
  const abs = path.resolve(storageRoot, relativePath || '');
  if (abs !== storageRoot && !abs.startsWith(storageRoot + path.sep)) {
    throw new ForbiddenError('Invalid file path');
  }
  return abs;
}

function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function removeFileQuietly(absPath) {
  try { await fs.promises.unlink(absPath); } catch { /* already gone */ }
}

/**
 * Absolute path to an answer script's PDF, restoring it from the database copy
 * (answer_script_files) when the local disk no longer has it, e.g. after a
 * serverless cold start. `script` needs `id` and `file_path`.
 */
async function ensureScriptFile(script) {
  const abs = resolveStoragePath(script.file_path);
  if (fs.existsSync(abs)) return abs;
  // Required lazily: config/database must not load just because upload config does.
  const { query } = require('./database');
  const { NotFoundError } = require('./errors');
  const { rows } = await query('SELECT content FROM answer_script_files WHERE script_id = $1', [script.id]);
  if (!rows[0]) throw new NotFoundError('The stored script file is missing');
  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, rows[0].content);
  return abs;
}

module.exports = {
  storageRoot,
  answerScriptDir,
  questionPaperDir,
  maxUploadMb,
  uploadAnswerScript,
  resolveStoragePath,
  sha256File,
  removeFileQuietly,
  ensureScriptFile
};
