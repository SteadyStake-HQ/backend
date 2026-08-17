/**
 * The contract every campaign verifier implements.
 *
 * The three-state result is the whole point of this file. A verifier answers one of:
 *
 *   met: true            the wallet has done the thing, here is the evidence
 *   met: false           the wallet has not done the thing, and we could tell
 *   unavailable: true    we could not tell — an RPC timed out, a token is not configured,
 *                        an integration is not wired
 *
 * Collapsing the third into `met: false` is the mistake this type exists to prevent. A campaign that
 * treats "the RPC is down" as "this wallet holds no BOT" would flip a mission from earned to unearned
 * on an outage; a campaign that treats "X is not wired" as failure would tell a user they did not
 * follow an account nobody checked. Only `met: true` writes a completion, only `met: false` is shown
 * to the user as not-yet-done, and `unavailable` surfaces as `verifying` with the reason attached.
 */

export interface VerifierEvidence {
  /** Which authoritative record was consulted. Stored as `verification_source`. */
  source: string;
  /** The specific fact: a tx hash, a balance, a run count. Stored as `verification_reference`. */
  reference: string | null;
  /** Free-form detail for the audit log and the dashboard's progress display. */
  detail?: Record<string, unknown>;
}

export interface VerifierMet extends VerifierEvidence {
  met: true;
  unavailable?: false;
}

export interface VerifierNotMet extends VerifierEvidence {
  met: false;
  unavailable?: false;
  /**
   * How far along the wallet is, when the mission has a measurable threshold: 2 of 3 executions,
   * 4 of 10 sessions. Drives the progress readout on the campaign page.
   */
  progress?: { current: number; target: number };
}

export interface VerifierUnavailable {
  met: false;
  unavailable: true;
  source: string;
  reference: null;
  /** Shown to the user, so it must read as a status rather than as a stack trace. */
  reason: string;
  detail?: Record<string, unknown>;
}

export type VerifierResult = VerifierMet | VerifierNotMet | VerifierUnavailable;

export function met(source: string, reference: string | null, detail?: Record<string, unknown>): VerifierMet {
  return { met: true, source, reference, detail };
}

export function notMet(
  source: string,
  progress?: { current: number; target: number },
  detail?: Record<string, unknown>,
): VerifierNotMet {
  return { met: false, source, reference: null, progress, detail };
}

export function unavailable(source: string, reason: string, detail?: Record<string, unknown>): VerifierUnavailable {
  return { met: false, unavailable: true, source, reference: null, reason, detail };
}

export function isUnavailable(result: VerifierResult): result is VerifierUnavailable {
  return result.unavailable === true;
}
