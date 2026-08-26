export type AutomatonErrorCode =
  | 'AUTOMATON_HARD_TIMEOUT'
  | 'AUTOMATON_STALL_DETECTED'
  | 'MCP_SPAWN_FAILED';

export class AutomatonDispatchError extends Error {
  readonly code: AutomatonErrorCode;

  constructor(code: AutomatonErrorCode, message: string) {
    super(message);
    this.name = 'AutomatonDispatchError';
    this.code = code;
  }
}
