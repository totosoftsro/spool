import type { MismatchReport } from './types.js';

/**
 * §11.3: a document is not a valid fixture.
 *
 * Kept strictly distinct from a match failure. Conflating the two produces the
 * failure mode HIF exists to fix — a typo in a fixture surfacing as "request did
 * not match".
 */
export class HifStructuralError extends Error {
  override readonly name = 'HifStructuralError';
  /** JSON-pointer-ish location within the document, when known. */
  readonly at: string | undefined;

  constructor(message: string, at?: string) {
    super(at ? `${message} (at ${at})` : message);
    this.at = at;
  }
}

/** §11.3: the document is valid, but no interaction corresponds to a live request. */
export class HifMatchError extends Error {
  override readonly name = 'HifMatchError';
  readonly report: MismatchReport;

  constructor(message: string, report: MismatchReport) {
    super(message);
    this.report = report;
  }
}

/** Raised when `assertComplete()` finds an unsatisfied `expect` (§5.4). */
export class HifExpectationError extends Error {
  override readonly name = 'HifExpectationError';
  readonly failures: string[];

  constructor(failures: string[]) {
    super(`Fixture expectations not met:\n  ${failures.join('\n  ')}`);
    this.failures = failures;
  }
}

/**
 * A simulated transport failure (§10).
 *
 * `cause` carries the ecosystem-native error where one exists, so that
 * application code catching a connection error catches this too.
 */
export class HifFaultError extends Error {
  override readonly name = 'HifFaultError';
  readonly faultType: string;
  readonly code: string;

  constructor(faultType: string, code: string, message: string) {
    super(message);
    this.faultType = faultType;
    this.code = code;
  }
}
