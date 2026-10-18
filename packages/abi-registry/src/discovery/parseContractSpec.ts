/**
 * Parses the `contractspecv0` custom WASM section soroban-sdk embeds via
 * `#[contractimpl]`/{`#[contractevent]`}/{`#[contracttype]` into the canonical
 * spec building blocks - no human, no JSON file.
 *
 * The WASM section-walking logic and the streaming multi-entry XDR read loop
 * below were both verified against real WASM binaries built from
 * `contracts/registry` and `contracts/demo-emitter` (soroban-sdk 27), not
 * guessed.
 */

import { createRequire } from "node:module";
import { xdr } from "@stellar/stellar-sdk";
import { mapSpecEntries } from "./xdrToSpec.js";
import type { XdrReader as XdrReaderType } from "@stellar/js-xdr";
import type { EventSpec, FunctionSpec, UserDefinedType } from "../spec.js";

// @stellar/js-xdr resolves to two different module shapes depending on the
// bundler: plain Node resolves its CJS `main` entry (a flat exports object,
// no static ESM exports to speak of), while Turbopack/webpack (via Next.js)
// resolves its real-ESM `module` entry (named exports, no default). A
// static `import` - default, namespace, or named - can't satisfy both:
// Turbopack statically verifies every export reference against whichever
// shape it resolved, including inside an unreached `??` branch, so even a
// dual-fallback expression trips "Export default doesn't exist". `require`
// sidesteps this entirely - it's opaque to static export analysis and
// always resolves the flat CJS shape. Safe here because every call path
// into this module runs under Next.js's `nodejs` runtime (not Edge), where
// `require` is available. Verified against a plain Node run and a real
// Next.js Turbopack production build.
const require = createRequire(import.meta.url);
const XdrReader: typeof XdrReaderType = (
  require("@stellar/js-xdr") as { XdrReader: typeof XdrReaderType }
).XdrReader;

/**
 * Thrown when a contract's WASM has no embedded `contractspecv0` section -
 * typically a non-Rust or stripped contract. Callers should fall back to a
 * manually published registry override.
 */
export class NoEmbeddedSpecError extends Error {
  constructor() {
    super(
      "No embedded contractspecv0 section found in this contract's WASM - likely a non-Rust or stripped contract. Fall back to a manually published registry override.",
    );
    this.name = "NoEmbeddedSpecError";
  }
}

const WASM_MAGIC = 0x6d736100; // "\0asm" read as a little-endian u32

/** Locates a named custom section's payload in a WASM binary, or null if absent. */
function findCustomSection(wasm: Uint8Array, sectionName: string): Buffer | null {
  const buf = Buffer.isBuffer(wasm) ? wasm : Buffer.from(wasm);
  if (buf.length < 8 || buf.readUInt32LE(0) !== WASM_MAGIC) {
    throw new Error("parseWasmSpec: not a valid WASM binary (bad magic number)");
  }

  let offset = 8; // skip magic (4 bytes) + version (4 bytes)

  function readVarUint32(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (offset >= buf.length) {
        throw new Error("parseWasmSpec: truncated WASM binary while reading a LEB128 length");
      }
      const byte = buf[offset++]!;
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    return result >>> 0;
  }

  while (offset < buf.length) {
    const id = buf[offset]!;
    offset += 1;
    const size = readVarUint32();
    const sectionEnd = offset + size;

    if (id === 0) {
      // Custom section: payload starts with a length-prefixed name.
      const nameLen = readVarUint32();
      const name = buf.subarray(offset, offset + nameLen).toString("utf-8");
      const payloadStart = offset + nameLen;
      if (name === sectionName) {
        return buf.subarray(payloadStart, sectionEnd);
      }
    }
    offset = sectionEnd;
  }

  return null;
}

/**
 * The canonical spec building blocks extracted from a contract's WASM by
 * {@link parseWasmSpec}.
 */
export type ParsedWasmSpec = {
  /** Functions declared in the contract's `contractspecv0` section. */
  functions: FunctionSpec[];
  /** Events declared in the contract's `contractspecv0` section. */
  events: EventSpec[];
  /** User-defined types keyed by type name. */
  types: Record<string, UserDefinedType>;
  /** Raw base64 XDR entries, preserved for decode.ts's ScSpecEntry-based decode path. */
  xdrEntries: string[];
};

/**
 * Parses a contract's WASM bytecode into the canonical spec building blocks.
 * Protocol-23+ contracts built with `#[contractevent]` yield full event
 * schemas; older contracts yield functions/UDTs only with `events: []` -
 * `contractspecv0` predates `#[contractevent]`, so older builds simply never
 * emitted `ScSpecEntryEventV0` entries in the first place (this function
 * doesn't need special-case logic for that; it falls out naturally from
 * there being no such entries to map).
 *
 * Throws {@link NoEmbeddedSpecError} when the section is absent - stripped
 * or non-Rust contracts have no embedded spec to discover.
 *
 * @param wasmBytes The contract's WASM bytecode.
 * @returns The parsed functions, events, types, and raw XDr entries.
 * @throws {@link NoEmbeddedSpecError} When no `contractspecv0` section is
 *   present.
 */
export function parseWasmSpec(wasmBytes: Uint8Array): ParsedWasmSpec {
  const payload = findCustomSection(wasmBytes, "contractspecv0");
  if (!payload) {
    throw new NoEmbeddedSpecError();
  }

  // xdr.ScSpecEntry.fromXDR() only handles a buffer containing exactly one
  // value; the section is a back-to-back concatenation of entries with no
  // outer framing, so we stream them with a shared cursor instead. Verified
  // against real WASM binaries - reader.eof correctly lands exactly on the
  // section boundary after reading all entries.
  const reader = new XdrReader(payload);
  const entries: xdr.ScSpecEntry[] = [];
  while (!reader.eof) {
    // ScSpecEntry.read()'s public .d.ts types `io` as `Buffer`, but the
    // generated implementation accepts any reader exposing the cursor
    // protocol XdrReader implements - verified at runtime.
    entries.push(xdr.ScSpecEntry.read(reader as unknown as Buffer));
  }

  const { functions, events, types } = mapSpecEntries(entries);
  return {
    functions,
    events,
    types,
    xdrEntries: entries.map((entry) => entry.toXDR("base64")),
  };
}
