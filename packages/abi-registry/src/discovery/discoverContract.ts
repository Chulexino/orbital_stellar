import { fetchContractWasm } from "./fetchContractCode.js";
import { parseWasmSpec, NoEmbeddedSpecError } from "./parseContractSpec.js";
import type { ContractSpec } from "../spec.js";

export { NoEmbeddedSpecError } from "./parseContractSpec.js";
export type { ParsedWasmSpec } from "./parseContractSpec.js";

/**
 * Options for {@link discoverContractSpec}.
 */
export type DiscoverContractSpecOptions = {
  /** RPC URL of the network the contract is deployed on. */
  rpcUrl: string;
  /** Contract ID (C...) to fetch and parse. */
  contractId: string;
  /** Network to record on the resulting spec. */
  network?: "mainnet" | "testnet" | "futurenet";
};

/**
 * Discovers a deployed contract's interface: fetches its WASM bytecode via
 * RPC, then parses the embedded `contractspecv0` section - no human, no JSON
 * file. Throws `NoEmbeddedSpecError` for non-Rust/stripped contracts, or for
 * any contract with no WASM to fetch in the first place - verified against
 * a real mainnet USDC lookup: Stellar Asset Contracts (SACs - exactly what
 * USDC/EURC/AQUA/the native XLM wrapper are) use
 * `ContractExecutable::StellarAsset`, not `::Wasm`, so there's no code to
 * fetch, and the SDK doesn't surface that cleanly (it throws from deep
 * inside XDR serialization rather than a typed "not a WASM contract"
 * error). Any WASM-fetch failure is therefore treated the same as a missing
 * spec section: nothing to discover. Callers (e.g. the auto-publish
 * indexer) should fall back to a manually published registry override in
 * that case, per maintainer.md.
 *
 * @version and @name aren't intrinsic to WASM bytecode - they're
 * publishing concepts, not code concepts - so this fills in placeholders
 * (`version: "0.0.0"`, `name: contractId`) that satisfy `validateSpec`.
 * Callers that go on to publish the result should set a real version first.
 *
 * @param opts The RPC URL, contract ID, and optional network to discover.
 * @returns The discovered {@link ContractSpec}, with placeholder `version`
 *   and `name`.
 * @throws {@link NoEmbeddedSpecError} When the WASM can't be fetched or has no
 *   embedded `contractspecv0` section.
 */
export async function discoverContractSpec(
  opts: DiscoverContractSpecOptions,
): Promise<ContractSpec> {
  let wasm: Buffer;
  try {
    wasm = await fetchContractWasm(opts.rpcUrl, opts.contractId);
  } catch {
    throw new NoEmbeddedSpecError();
  }
  const parsed = parseWasmSpec(wasm);

  return {
    version: "0.0.0",
    name: opts.contractId,
    contractId: opts.contractId,
    ...(opts.network ? { network: opts.network } : {}),
    functions: parsed.functions,
    events: parsed.events,
    types: parsed.types,
    xdrEntries: parsed.xdrEntries,
  };
}
