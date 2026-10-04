export type ErrorCode =
  | 'EMPTY_BODY'
  | 'INVALID_JSON'
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'NUMERIC_OVERFLOW'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  get status(): number {
    switch (this.code) {
      case 'NOT_FOUND':
        return 404;
      case 'CONFLICT':
        return 409;
      case 'NUMERIC_OVERFLOW':
        return 422;
      default:
        return 400;
    }
  }
}
