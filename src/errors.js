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
    super('NOT_AUTHENTICATED', `Not authenticated: ${reason}`, { reason });
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
