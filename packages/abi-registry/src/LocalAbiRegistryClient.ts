// LocalAbiRegistryClient.ts
// Provides an ABI registry client that reads contract specs from a local directory.
// This enables offline or self‑hosted usage without any network calls.

import { TtlLruCache, DEFAULT_MAX_CACHE_SIZE, DEFAULT_CACHE_TTL_MS } from "./TtlLruCache.js";
import type { XdrContractSpec } from "./types.js";

/**
 * Configuration for the LocalAbiRegistryClient.
 * `specsDir` is the absolute path to a directory containing one JSON file per contract spec.
 * The filename (without .json) should correspond to the contractId.
 */
export interface LocalAbiRegistryClientConfig {
  /** Absolute path to the directory containing spec JSON files */
  specsDir: string;
  /** Maximum number of specs to keep in the LRU cache. Defaults to 512. */
  maxCacheSize?: number;
  /** Time‑to‑live for cached specs in milliseconds. Defaults to 5 minutes. */
  cacheTtlMs?: number;
}

/**
 * ABI registry client that reads and caches contract specs from a local directory.
 */
export class LocalAbiRegistryClient {
  private readonly specsDir: string;
  private readonly cache: TtlLruCache<XdrContractSpec | null>;

  /**
   * @param config Client configuration including specs directory and cache settings
   */
  constructor(config: LocalAbiRegistryClientConfig) {
    // Remove trailing slash if present
    this.specsDir = config.specsDir.replace(/\\\/$/, "");
    this.cache = new TtlLruCache(
      config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
      config.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE,
    );
  }

  /**
   * Fetch a single contract spec from the local directory (cached).
   *
   * @param contractId Contract ID to fetch spec for
   * @returns The contract spec, or null if not found
   */
  async getSpec(contractId: string): Promise<XdrContractSpec | null> {
    const cached = this.getCached(contractId);
    if (cached !== undefined) return cached;
    const spec = await this.loadFromDisk(contractId);
    this.setCache(contractId, spec);
    return spec;
  }

  /**
   * Fetch multiple specs, loading only those not present in the cache.
   *
   * @param contractIds Array of contract IDs to fetch
   * @returns Record mapping contract IDs to their specs or null
   */
  async getSpecs(contractIds: string[]): Promise<Record<string, XdrContractSpec | null>> {
    const result: Record<string, XdrContractSpec | null> = {};
    const uncached: string[] = [];

    for (const id of contractIds) {
      const cached = this.getCached(id);
      if (cached !== undefined) {
        result[id] = cached;
      } else {
        uncached.push(id);
      }
    }

    if (uncached.length === 0) return result;

    const loaded = await Promise.all(uncached.map((id) => this.loadFromDisk(id)));
    for (const [i, id] of uncached.entries()) {
      const spec = loaded[i] as XdrContractSpec | null;
      this.setCache(id, spec);
      result[id] = spec;
    }
    return result;
  }

  private getCached(contractId: string): XdrContractSpec | null | undefined {
    return this.cache.get(contractId);
  }

  private setCache(contractId: string, value: XdrContractSpec | null): void {
    this.cache.set(contractId, value);
  }

  private async loadFromDisk(contractId: string): Promise<XdrContractSpec | null> {
    const path = `${this.specsDir}/${contractId}.json`;
    try {
      const { readFile } = await import("node:fs/promises");
      const data = await readFile(path, { encoding: "utf8" });
      const spec: XdrContractSpec = JSON.parse(data);
      return spec;
    } catch {
      // Missing file or parse error – treat as not found.
      return null;
    }
  }
}
