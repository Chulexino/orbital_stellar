import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { generateContractTypes } from "./generate.js";
import type { ContractSpec } from "./spec.js";
import type { OrbitalCodegenConfig, OrbitalLockFile, CodegenContract } from "./config.js";

/**
 * Options for {@link watchCodegen}.
 */
export type CodegenWatchOptions = {
  /** How often to poll for spec changes, in milliseconds (default 15000). */
  pollIntervalMs?: number;
  /** Debounce window for bursts of changes, in milliseconds (default 2000). */
  debounceMs?: number;
  /** Working directory to resolve `orbital.lock.json` from (defaults to `process.cwd()). */
  cwd?: string;
};

async function resolveContractSpec(
  contractId: string,
  config: OrbitalCodegenConfig,
): Promise<{ spec: ContractSpec; hash: string } | null> {
  const specPath = resolve(config.outDir, `${contractId}.spec.json`);
  if (!existsSync(specPath)) {
    const contract = config.contracts.find((c: CodegenContract) => c.contractId === contractId);
    if (contract?.name) {
      const namedPath = resolve(config.outDir, `${contract.name}.spec.json`);
      if (existsSync(namedPath)) {
        const content = readFileSync(namedPath, "utf-8");
        const hash = createHash("sha256").update(content).digest("hex");
        return { spec: JSON.parse(content) as ContractSpec, hash };
      }
    }
    return null;
  }

  const content = readFileSync(specPath, "utf-8");
  const hash = createHash("sha256").update(content).digest("hex");
  return { spec: JSON.parse(content) as ContractSpec, hash };
}

/**
 * Regenerates the `.d.ts` types for a single contract from its cached
 * spec file in the config's output directory. Writes atomically via a
 * temporary file + rename so a consumer never observes a partial file.
 *
 * @param contractId Contract ID (C...) to generate types for.
 * @param config The orbital codegen configuration.
 * @param contractName Optional output name override; defaults to `contractId`.
 * @returns The sha256 hex of the spec used, or `null` when no cached spec
 *   could be found for the contract.
 */
export async function generateForContract(
  contractId: string,
  config: OrbitalCodegenConfig,
  contractName?: string,
): Promise<string | null> {
  const resolved = await resolveContractSpec(contractId, config);
  if (!resolved) return null;

  const { spec, hash } = resolved;
  const name = contractName ?? contractId;
  const outPath = resolve(config.outDir, `${name}.d.ts`);

  const generated = generateContractTypes(spec);

  const tmpPath = `${outPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, generated, "utf-8");
  renameSync(tmpPath, outPath);

  return hash;
}

/**
 * Writes an {@link OrbitalLockFile} to `orbital.lock.json` in `cwd`,
 * atomically via a temporary file + rename.
 *
 * @param cwd Directory the lock file lives in.
 * @param lock The lock file contents to persist.
 */
export function writeLockFile(cwd: string, lock: OrbitalLockFile): void {
  const lockPath = resolve(cwd, "orbital.lock.json");
  const tmpPath = `${lockPath}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(lock, null, 2), "utf-8");
  renameSync(tmpPath, lockPath);
}

/**
 * Watches the configured contracts and regenerates their types when their
 * cached specs change, updating `orbital.lock.json` as it goes. Runs until
 * SIGINT/SIGTERM is received, then exits cleanly.
 *
 * @param config The orbital codegen configuration.
 * @param options Polling/debounce/cwd tuning; see {@link CodegenWatchOptions}.
 * @returns A promise that resolves when the watcher stops.
 */
export async function watchCodegen(
  config: OrbitalCodegenConfig,
  options: CodegenWatchOptions = {},
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 15_000;
  const debounceMs = options.debounceMs ?? 2_000;
  const cwd = options.cwd ?? process.cwd();

  let lockFile: OrbitalLockFile | null = null;
  let pendingTimeout: ReturnType<typeof setTimeout> | null = null;
  let shouldRun = true;
  let needsRegeneration = false;

  const onSigint = () => {
    shouldRun = false;
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      pendingTimeout = null;
    }
    console.log("\n[orbital codegen --watch] SIGINT received, exiting cleanly.");
    process.exit(0);
  };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  console.log(
    `[orbital codegen --watch] Watching ${config.contracts.length} contract(s) (poll every ${pollIntervalMs}ms)...`,
  );
  if (debounceMs > 0) {
    console.log(`[orbital codegen --watch] Burst debounce window: ${debounceMs}ms`);
  }

  try {
    const lockPath = resolve(cwd, "orbital.lock.json");
    if (existsSync(lockPath)) {
      lockFile = JSON.parse(readFileSync(lockPath, "utf-8")) as OrbitalLockFile;
    }
  } catch {
    lockFile = null;
  }

  const regenerate = async () => {
    needsRegeneration = false;
    const updatedLock: OrbitalLockFile = { ...(lockFile ?? {}) };
    let anyChanged = false;

    for (const contract of config.contracts) {
      const hash = await generateForContract(contract.contractId, config, contract.name);

      if (hash === null) {
        console.log(`  [${contract.name ?? contract.contractId}] SKIP - spec not resolvable`);
        continue;
      }

      const name = contract.name ?? contract.contractId;
      const prevHash = lockFile?.[name]?.specHash;

      if (prevHash === hash) {
        console.log(`  [${name}] OK - hash unchanged (${hash.slice(0, 12)}...)`);
      } else {
        console.log(
          `  [${name}] REGENERATED - ${prevHash ? `old: ${prevHash.slice(0, 12)}... new: ${hash.slice(0, 12)}...` : `hash: ${hash.slice(0, 12)}...`}`,
        );
        anyChanged = true;
      }

      updatedLock[name] = {
        specHash: hash,
        verifiedAt: new Date().toISOString(),
      };
    }

    if (anyChanged || !lockFile) {
      writeLockFile(cwd, updatedLock);
      lockFile = updatedLock;
    }
  };

  await regenerate();

  while (shouldRun) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    if (!shouldRun) break;

    if (needsRegeneration) continue;
    needsRegeneration = true;

    if (debounceMs > 0) {
      if (pendingTimeout) clearTimeout(pendingTimeout);
      pendingTimeout = setTimeout(async () => {
        pendingTimeout = null;
        await regenerate();
      }, debounceMs);
    } else {
      await regenerate();
    }
  }

  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigint);
}
