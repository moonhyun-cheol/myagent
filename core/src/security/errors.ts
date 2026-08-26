export class SecurityError extends Error {
  readonly code: 'NAS_WRITE_FORBIDDEN' | 'NAS_CONSENT_REQUIRED' | 'OUTSIDE_MY_AGENT_ROOT';

  constructor(code: SecurityError['code'], message: string) {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
  }
}
