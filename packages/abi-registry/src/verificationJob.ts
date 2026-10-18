import type { ContractSpec } from "./spec.js";
import { verifySchema, type SchemaVerdict, type VerifySchemaOptions } from "./verifySchema.js";
import type { VerdictStore, VerdictRecord } from "./verdictStore.js";
import type { SpecStore, RegisteredSpec } from "./specStore.js";
import type { IssueReporter } from "./issueReporter.js";
import type { AlertManager } from "./alertManager.js";

/**
 * Configuration options for running a batch verification job over registered specs.
 */
export type VerificationJobConfig = {
  /** Spec store providing the registered contract specifications to verify */
  specStore: SpecStore;
  /** Verdict store where verification results and history are recorded */
  verdictStore: VerdictStore;
  /** Options passed to the schema verification engine (e.g. RPC URL) */
  verifyOptions: VerifySchemaOptions;
  /** Optional issue reporter to open tickets on schema mismatches */
  issueReporter?: IssueReporter;
  /** Optional alert manager to notify on verdict status changes */
  alertManager?: AlertManager;
  /** Optional callback invoked as each contract verification completes */
  onVerdict?: (record: VerdictRecord) => void;
};

/**
 * Summary result of a verification job run across all registered contracts.
 */
export type JobResult = {
  /** Total number of contract specs processed */
  total: number;
  /** Count of specs that matched on-chain bytecode */
  verified: number;
  /** Count of specs that had schema differences against on-chain bytecode */
  mismatch: number;
  /** Count of contracts that could not be verified (e.g. no embedded spec) */
  unverifiable: number;
  /** Errors encountered during verification processing */
  errors: { contractId: string; error: string }[];
  /** URLs or identifiers of issues created for mismatches */
  issuesCreated: string[];
};

function verdictToStatus(verdict: SchemaVerdict): VerdictRecord["status"] {
  switch (verdict.status) {
    case "match":
      return "verified";
    case "mismatch":
      return "mismatch";
    case "unverifiable":
      return "unverifiable";
  }
}

/**
 * Runs a verification job across all specifications in the spec store.
 *
 * Compares each registered spec against the deployed on-chain contract spec,
 * records verdicts in the verdict store, reports mismatches via the issue reporter,
 * and notifies the alert manager when statuses transition.
 *
 * @param config Configuration specifying stores, options, and reporters
 * @returns Summary of verification counts, created issues, and encountered errors
 */
export async function runVerificationJob(config: VerificationJobConfig): Promise<JobResult> {
  const result: JobResult = {
    total: 0,
    verified: 0,
    mismatch: 0,
    unverifiable: 0,
    errors: [],
    issuesCreated: [],
  };

  const specs = await config.specStore.getAll();
  result.total = specs.length;

  for (const registered of specs) {
    try {
      const record = await verifySingleContract(registered, config);
      if (record.status === "verified") result.verified++;
      else if (record.status === "mismatch") result.mismatch++;
      else if (record.status === "unverifiable") result.unverifiable++;

      config.onVerdict?.(record);

      if (record.status === "mismatch" && config.issueReporter) {
        const issueUrl = await config.issueReporter.reportMismatch({
          contractId: record.contractId,
          contractName: registered.spec.name,
          diffs: record.diffs ?? [],
          submittedVersion: registered.spec.version,
          previousStatus: record.previousStatus,
        });
        if (issueUrl) result.issuesCreated.push(issueUrl);
      }

      if (record.previousStatus && record.previousStatus !== record.status && config.alertManager) {
        const prevRecord: VerdictRecord = {
          contractId: record.contractId,
          status: record.previousStatus,
          verifiedAt: "",
        };
        await config.alertManager.alertTransition(prevRecord, record);
      }
    } catch (error) {
      result.errors.push({
        contractId: registered.contractId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

async function verifySingleContract(
  registered: RegisteredSpec,
  config: VerificationJobConfig,
): Promise<VerdictRecord> {
  const previous = await config.verdictStore.getLatest(registered.contractId);

  const submittedSpec: ContractSpec = {
    ...registered.spec,
    contractId: registered.contractId,
  };

  const verdict = await verifySchema(registered.contractId, submittedSpec, config.verifyOptions);

  const record: VerdictRecord = {
    contractId: registered.contractId,
    status: verdictToStatus(verdict),
    verifiedAt: new Date().toISOString(),
    previousStatus: previous?.status,
    specVersion: registered.spec.version,
  };

  if (verdict.status === "mismatch") {
    record.diffs = verdict.diffs;
  }
  if (verdict.status === "unverifiable") {
    record.reason = verdict.reason;
    record.attestedBy = registered.attestedBy;
  }

  await config.verdictStore.record(record);
  return record;
}
