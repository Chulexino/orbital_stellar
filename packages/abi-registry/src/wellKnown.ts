/**
 * Converts the hand-authored, snake_case "well-known spec" format
 * (`specs/well-known/*.json`, validated against `specs/well-known/schema.json`)
 * into the canonical {@link ContractSpec} shape used everywhere else in this
 * package (publishing, decoding, typegen). The well-known format stays a
 * human-authoring convenience - nothing downstream of this converter should
 * touch it directly.
 */

import type { ContractSpec, EventSpec, FieldSpec, FunctionSpec, PrimitiveType } from "./spec.js";

type WellKnownFieldRaw = { name: string; type: string; doc?: string };
type WellKnownOutputRaw = { type: string; doc?: string };
type WellKnownFunctionRaw = {
  name: string;
  doc?: string;
  params: WellKnownFieldRaw[];
  outputs: WellKnownOutputRaw[];
};
type WellKnownEventRaw = {
  name: string;
  doc?: string;
  topics: WellKnownFieldRaw[];
  data: WellKnownFieldRaw[];
};
/**
 * Raw, hand-authored well-known specification format before canonicalization.
 */
export type WellKnownSpecRaw = {
  version: string;
  name: string;
  description: string;
  contract_id: string;
  network: "mainnet" | "testnet" | "futurenet";
  source: string;
  tags?: string[];
  functions: WellKnownFunctionRaw[];
  events?: WellKnownEventRaw[];
};

// The well-known format only uses these primitives today. Extend this map
// (and, if composite types show up, add real vec<T>/map<K,V> parsing) if a
// future well-known spec needs more than a flat primitive type.
const TYPE_MAP: Readonly<Record<string, PrimitiveType>> = {
  address: "address",
  bool: "bool",
  string: "string",
  symbol: "symbol",
  bytes: "bytes",
  u32: "u32",
  i32: "i32",
  u64: "u64",
  i64: "i64",
  u128: "u128",
  i128: "i128",
  u256: "u256",
  i256: "i256",
  void: "void",
};

function mapType(rawType: string): PrimitiveType {
  const mapped = TYPE_MAP[rawType.toLowerCase()];
  if (!mapped) {
    throw new Error(
      `wellKnownToContractSpec: unsupported well-known type "${rawType}" - only flat primitives are supported`,
    );
  }
  return mapped;
}

function mapField(field: WellKnownFieldRaw): FieldSpec {
  return { name: field.name, type: mapType(field.type), ...(field.doc ? { doc: field.doc } : {}) };
}

function mapFunction(fn: WellKnownFunctionRaw): FunctionSpec {
  if (fn.outputs.length > 1) {
    throw new Error(
      `wellKnownToContractSpec: function "${fn.name}" has ${fn.outputs.length} outputs - Soroban functions return at most one value`,
    );
  }
  return {
    name: fn.name,
    ...(fn.doc ? { doc: fn.doc } : {}),
    params: fn.params.map(mapField),
    returns: fn.outputs.length === 1 ? mapType(fn.outputs[0]!.type) : "void",
  };
}

function mapEvent(ev: WellKnownEventRaw): EventSpec {
  return {
    name: ev.name,
    ...(ev.doc ? { doc: ev.doc } : {}),
    topics: [
      { name: "event_name", type: "symbol", doc: `Event name symbol, always "${ev.name}".` },
      ...ev.topics.map(mapField),
    ],
    data: ev.data.map(mapField),
  };
}

/**
 * Converts a well-known spec (already validated against
 * `specs/well-known/schema.json`) into the canonical {@link ContractSpec}.
 * Throws if the input uses a type this converter doesn't understand - the
 * well-known format is deliberately flat/primitive-only today.
 */
export function wellKnownToContractSpec(raw: WellKnownSpecRaw): ContractSpec {
  return {
    version: raw.version,
    name: raw.name,
    description: raw.description,
    contractId: raw.contract_id,
    network: raw.network,
    functions: raw.functions.map(mapFunction),
    events: (raw.events ?? []).map(mapEvent),
    types: {},
  };
}
