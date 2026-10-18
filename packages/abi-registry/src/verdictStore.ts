import type { SchemaFieldDiff } from "./verifySchema.js";

/**
 * Verification status outcome for a contract schema.
 */
export type VerdictStatus = "verified" | "mismatch" | "unverifiable";

/**
 * Record of a schema verification run for a contract.
 */
export type VerdictRecord = {
  /** Contract ID that was verified */
  contractId: string;
  /** Verification outcome status */
  status: VerdictStatus;
  /** ISO timestamp when verification occurred */
  verifiedAt: string;
  /** Status from previous verification run, if available */
  previousStatus?: VerdictStatus;
  /** Field-level schema differences if status is "mismatch" */
  diffs?: SchemaFieldDiff[];
  /** Explanation if status is "unverifiable" */
  reason?: string;
  /** Attester addresses associated with this verification */
  attestedBy?: string[];
  /** Version string of the verified specification */
  specVersion?: string;
};

/**
 * Storage interface for recording and querying verification verdicts.
 */
export interface VerdictStore {
  /**
   * Appends a new verdict record to the store.
   *
   * @param verdict The verdict record to persist
   */
  record(verdict: VerdictRecord): Promise<void>;

  /**
   * Retrieves the most recent verdict record for a given contract.
   *
   * @param contractId Contract ID to look up
   * @returns The latest verdict record, or null if none exists
   */
  getLatest(contractId: string): Promise<VerdictRecord | null>;

  /**
   * Retrieves the latest verdict for each contract in the store.
   *
   * @returns An array containing the latest verdict record for each contract
   */
  getAll(): Promise<VerdictRecord[]>;

  /**
   * Retrieves all historical verdicts for a given contract.
   *
   * @param contractId Contract ID to look up
   * @returns An array of verdict records from oldest to newest
   */
  getHistory(contractId: string): Promise<VerdictRecord[]>;
}

/**
 * In-memory implementation of {@link VerdictStore}.
 */
export class InMemoryVerdictStore implements VerdictStore {
  private readonly records: Map<string, VerdictRecord[]> = new Map();

  /**
   * Appends a new verdict record to the store.
   *
   * @param verdict The verdict record to persist
   */
  async record(verdict: VerdictRecord): Promise<void> {
    const existing = this.records.get(verdict.contractId) ?? [];
    existing.push(verdict);
    this.records.set(verdict.contractId, existing);
  }

  /**
   * Retrieves the most recent verdict record for a given contract.
   *
   * @param contractId Contract ID to look up
   * @returns The latest verdict record, or null if none exists
   */
  async getLatest(contractId: string): Promise<VerdictRecord | null> {
    const existing = this.records.get(contractId);
    if (!existing || existing.length === 0) return null;
    return existing[existing.length - 1]!;
  }

  /**
   * Retrieves the latest verdict for each contract in the store.
   *
   * @returns An array containing the latest verdict record for each contract
   */
  async getAll(): Promise<VerdictRecord[]> {
    const all: VerdictRecord[] = [];
    for (const records of this.records.values()) {
      const latest = records[records.length - 1];
      if (latest) all.push(latest);
    }
    return all;
  }

  /**
   * Retrieves all historical verdicts for a given contract.
   *
   * @param contractId Contract ID to look up
   * @returns An array of verdict records from oldest to newest
   */
  async getHistory(contractId: string): Promise<VerdictRecord[]> {
    return this.records.get(contractId) ?? [];
  }
}
