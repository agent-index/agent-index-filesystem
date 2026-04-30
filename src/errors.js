/**
 * Typed errors for the AIFS MCP server.
 * Each error maps to a machine-readable code returned in tool responses.
 */

export class AifsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AifsError';
    this.code = code;
    this.details = details;
  }

  toResponse() {
    return {
      error: this.code,
      message: this.message,
      ...this.details,
    };
  }
}

export class FileNotFoundError extends AifsError {
  constructor(path) {
    super('FILE_NOT_FOUND', `No file exists at path: ${path}`, { path });
  }
}

export class PathNotFoundError extends AifsError {
  constructor(path) {
    super('PATH_NOT_FOUND', `No directory exists at path: ${path}`, { path });
  }
}

export class AccessDeniedError extends AifsError {
  constructor(path, action = 'access') {
    super('ACCESS_DENIED', `Permission denied to ${action}: ${path}`, { path });
  }
}

export class NotAuthenticatedError extends AifsError {
  constructor(reason = 'no_credential') {
    // needs_auth is a top-level flag on the response so callers can branch
    // on a single boolean instead of pattern-matching the `error` string.
    super('NOT_AUTHENTICATED', `Not authenticated: ${reason}`, { reason, needs_auth: true });
  }
}

export class WriteConflictError extends AifsError {
  constructor(path) {
    super('WRITE_CONFLICT', `Write conflict at path: ${path}. Retry with a fresh read.`, { path });
  }
}

export class NotEmptyError extends AifsError {
  constructor(path) {
    super('NOT_EMPTY', `Cannot delete non-empty directory: ${path}`, { path });
  }
}

export class AuthFailedError extends AifsError {
  constructor(message = 'Authentication failed', details = {}) {
    super('AUTH_FAILED', message, details);
  }
}

export class BackendError extends AifsError {
  constructor(message, originalError) {
    super('BACKEND_ERROR', message, {
      originalMessage: originalError?.message,
    });
  }
}

// ─── v2.0 errors (access control + revision-aware writes + search) ────

export class RevisionConflictError extends AifsError {
  constructor(path, expectedRevision, actualRevision) {
    super(
      'REVISION_CONFLICT',
      `Revision mismatch at path: ${path}. Re-read, re-apply changes, and retry.`,
      { path, expected_revision: expectedRevision, actual_revision: actualRevision }
    );
  }
}

export class InvalidSubjectError extends AifsError {
  constructor(subject, reason = 'unknown') {
    super(
      'INVALID_SUBJECT',
      `Subject is not a valid identity: ${subject} (${reason})`,
      { subject, reason }
    );
  }
}

export class InvalidRoleError extends AifsError {
  constructor(role, validRoles = ['reader', 'commenter', 'writer']) {
    super(
      'INVALID_ROLE',
      `Role "${role}" is not accepted. Valid roles: ${validRoles.join(', ')}`,
      { role, valid_roles: validRoles }
    );
  }
}

export class InvalidRecipientError extends AifsError {
  constructor(recipient, reason = 'unknown') {
    super(
      'INVALID_RECIPIENT',
      `Recipient is not a valid identity for ownership transfer: ${recipient} (${reason})`,
      { recipient, reason }
    );
  }
}

export class InvalidScopeError extends AifsError {
  constructor(scope, reason = 'unknown') {
    super(
      'INVALID_SCOPE',
      `Search scope is invalid: ${scope} (${reason})`,
      { scope, reason }
    );
  }
}

export class NotImplementedError extends AifsError {
  constructor(operation, backend = 'this backend') {
    super(
      'NOT_IMPLEMENTED',
      `Operation "${operation}" is not implemented for ${backend}`,
      { operation, backend }
    );
  }
}
