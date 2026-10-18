import type { VerdictRecord } from "./verdictStore.js";

/**
 * Handles notifications when a contract's verification verdict status changes.
 */
export interface AlertManager {
  /**
   * Notifies of a verdict transition.
   *
   * @param previous The previous verdict record
   * @param current The current verdict record
   */
  alertTransition(previous: VerdictRecord, current: VerdictRecord): Promise<void>;
}

/**
 * Alert manager that logs verdict transitions and diffs to the console.
 */
export class ConsoleAlertManager implements AlertManager {
  /**
   * Logs a verdict transition and any schema diffs to `console.error`.
   *
   * @param previous The previous verdict record
   * @param current The current verdict record
   */
  async alertTransition(previous: VerdictRecord, current: VerdictRecord): Promise<void> {
    console.error(
      `[ABI Registry Alert] Contract ${current.contractId}: status transitioned from "${previous.status}" to "${current.status}" at ${current.verifiedAt}`,
    );
    if (current.diffs && current.diffs.length > 0) {
      console.error(`[ABI Registry Alert] Diffs:`, JSON.stringify(current.diffs, null, 2));
    }
  }
}

/**
 * Alert manager that discards all verdict transitions without action.
 */
export class NoopAlertManager implements AlertManager {
  /**
   * Discards the verdict transition.
   *
   * @param _previous The previous verdict record
   * @param _current The current verdict record
   */
  async alertTransition(_previous: VerdictRecord, _current: VerdictRecord): Promise<void> {}
}
