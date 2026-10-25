export const EXIT = {
  ok: 0,
  validation: 1,
  usage: 2,
  config: 3,
  orchestrator: 4,
  agent: 5,
  guard: 6,
  gate: 7,
} as const;

export class CliError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export type PromptErrorKind = 'bad_request' | 'conflict' | 'invalid' | 'state';

export class PromptError extends Error {
  constructor(
    readonly kind: PromptErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'PromptError';
  }
}

export function fail(exitCode: number, message: string): never {
  throw new CliError(exitCode, message);
}
