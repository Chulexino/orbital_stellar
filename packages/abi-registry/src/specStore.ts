import type { ContractSpec } from "./spec.js";

/**
 * A contract specification registered in a spec store, including submission metadata.
 */
export type RegisteredSpec = {
  /** Bech32 contract address */
  contractId: string;
  /** The canonical contract specification */
  spec: ContractSpec;
  /** Optional publisher address or identifier */
  publisher?: string;
  /** ISO timestamp when the spec was submitted */
  submittedAt: string;
  /** Optional array of attester addresses who signed this specification */
  attestedBy?: string[];
};

/**
 * Storage interface for registering and retrieving contract specifications.
 */
export interface SpecStore {
  /**
   * Registers or updates a contract spec.
   *
   * @param spec The registered spec record to store
   */
  register(spec: RegisteredSpec): Promise<void>;

  /**
   * Retrieves a contract spec by contract ID.
   *
   * @param contractId Contract ID to look up
   * @returns The registered spec, or null if not found
   */
  get(contractId: string): Promise<RegisteredSpec | null>;

  /**
   * Returns all registered contract specs in the store.
   *
   * @returns An array of all registered specs
   */
  getAll(): Promise<RegisteredSpec[]>;

  /**
   * Removes a contract spec by contract ID.
   *
   * @param contractId Contract ID to remove
   */
  remove(contractId: string): Promise<void>;
}

/**
 * In-memory implementation of {@link SpecStore}.
 */
export class InMemorySpecStore implements SpecStore {
  private readonly specs: Map<string, RegisteredSpec> = new Map();

  /**
   * Registers or updates a contract spec in memory.
   *
   * @param spec The registered spec record to store
   */
  async register(spec: RegisteredSpec): Promise<void> {
    this.specs.set(spec.contractId, spec);
  }

  /**
   * Retrieves a contract spec by contract ID.
   *
   * @param contractId Contract ID to look up
   * @returns The registered spec, or null if not found
   */
  async get(contractId: string): Promise<RegisteredSpec | null> {
    return this.specs.get(contractId) ?? null;
  }

  /**
   * Returns all registered contract specs in the store.
   *
   * @returns An array of all registered specs
   */
  async getAll(): Promise<RegisteredSpec[]> {
    return Array.from(this.specs.values());
  }

  /**
   * Removes a contract spec by contract ID.
   *
   * @param contractId Contract ID to remove
   */
  async remove(contractId: string): Promise<void> {
    this.specs.delete(contractId);
  }
}
