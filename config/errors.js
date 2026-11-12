// Shared error types. Throw these from services/controllers; the central handler maps them.
class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
class ForbiddenError extends AppError { constructor(m = 'You do not have access to this resource') { super(403, 'FORBIDDEN', m); } }
class NotFoundError extends AppError { constructor(m = 'Not found') { super(404, 'NOT_FOUND', m); } }
class ValidationError extends AppError { constructor(m = 'Invalid input', details) { super(422, 'VALIDATION_ERROR', m); this.details = details; } }

module.exports = { AppError, ForbiddenError, NotFoundError, ValidationError };
