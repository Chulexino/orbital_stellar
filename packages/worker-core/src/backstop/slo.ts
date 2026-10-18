import type {
  AlertManager,
  VerdictRecord,
  VerdictStatus,
  VerdictStore,
} from "@orbital-stellar/abi-registry";

/**
 * Dedicated operator ID representing the Orbital backstop service operator.
 */
export const ORBITAL_BACKSTOP_OPERATOR_ID = "orbital";

const MAX_LEDGER = 1_000_000;
const MAX_STROOPS = 9223372036854775807n;
const WINDOW_STATUSES = new Set<WorkerWindowStatus>(["fired", "missed", "late", "not-due"]);

/** Execution outcome status for a worker execution window. */
export type WorkerWindowStatus = "fired" | "missed" | "late" | "not-due";

/** Recorded execution verdict for a worker over an evaluation window. */
export type WorkerWindowVerdict = {
  workerId: string;
  operatorId: string;
  windowId: string;
  status: WorkerWindowStatus;
  ledgerStart: number;
  ledgerEnd: number;
};

/** SLA bounds and operational constraints for the backstop operator. */
export type BackstopSloBounds = {
  latencyBoundLedgers: number;
  gracePeriodLedgers: number;
  xlmFloatMinStroops: bigint;
  monitoringLagGraceLedgers: number;
};

/** High-level SLO compliance status of the backstop service. */
export type SloStatus = "meeting" | "breached" | "unverifiable";

/** Store responsible for persisting and querying worker execution window verdicts. */
export type WorkerVerdictStore = {
  record(verdict: WorkerWindowVerdict): Promise<void>;
  getByOperator(operatorId: string): Promise<WorkerWindowVerdict[]>;
};

/** Operator reputation score details and status. */
export type OperatorScore = {
  operatorId: string;
  formulaVersion: string;
  kind: "scored" | "insufficient-data";
};

/** Scorer that computes an operator's reputation score from historical window verdicts. */
export type OperatorScorer = {
  score(store: WorkerVerdictStore, operatorId: string): Promise<OperatorScore>;
};

/** Parameters for evaluating backstop operator SLO compliance. */
export type EvaluateBackstopSloInput = {
  windows: WorkerWindowVerdict[];
  bounds: BackstopSloBounds;
  xlmFloatStroops: bigint;
  chainHeadLedger: number;
  lastProcessedLedger: number;
  store: WorkerVerdictStore;
  scorer: OperatorScorer;
  alertManager: AlertManager;
  sloVerdictStore: VerdictStore;
};

/** Result of an SLO evaluation, including compliance status, operator score, and recorded ABI verdict. */
export type BackstopSloResult = {
  status: SloStatus;
  operatorScore: OperatorScore;
  abiRecord: VerdictRecord;
};

/** Error codes identifying specific failures when evaluating backstop SLOs. */
export type BackstopSloErrorCode =
  | "MISSING_DEPENDENCY"
  | "INVALID_OPERATOR"
  | "LEDGER_OUT_OF_RANGE"
  | "STROOPS_OUT_OF_RANGE"
  | "BOUNDS_OUT_OF_RANGE"
  | "UNKNOWN_VERDICT";

/** Error thrown when backstop SLO evaluation fails due to invalid parameters or dependencies. */
export class BackstopSloError extends Error {
  /** The programmatic error code for this error. */
  readonly code: BackstopSloErrorCode;

  /**
   * Initializes a new instance of {@link BackstopSloError}.
   *
   * @param code - The specific error code.
   * @param message - Descriptive error message.
   */
  constructor(code: BackstopSloErrorCode, message: string) {
    super(message);
    this.name = "BackstopSloError";
    this.code = code;
  }
}

function requireDep<T>(value: T | undefined | null, name: string): T {
  if (value === undefined || value === null) {
    throw new BackstopSloError("MISSING_DEPENDENCY", `Missing ${name}`);
  }
  return value;
}

function assertLedger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_LEDGER) {
    throw new BackstopSloError(
      "LEDGER_OUT_OF_RANGE",
      `${label} must be an integer in 0..${MAX_LEDGER}`,
    );
  }
}

function assertBoundLedger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LEDGER) {
    throw new BackstopSloError(
      "BOUNDS_OUT_OF_RANGE",
      `${label} must be an integer in 1..${MAX_LEDGER}`,
    );
  }
}

function sloToAbi(status: SloStatus): VerdictStatus {
  switch (status) {
    case "meeting":
      return "verified";
    case "breached":
      return "mismatch";
    case "unverifiable":
      return "unverifiable";
  }
}

function assertOperatorId(id: string): void {
  if (id.length === 0 || id.length > 128) {
    throw new BackstopSloError("INVALID_OPERATOR", "operatorId must be 1..128 characters");
  }
}

/**
 * Evaluates the backstop operator's SLO compliance across recent windows, computes reputation score,
 * records verdicts in the ABI store, and triggers alerts on status transitions.
 *
 * @param input - Evaluation parameters and dependencies including ledger state, bounds, windows, stores, and alert manager.
 * @returns An object containing the SLO compliance status, the operator reputation score, and the persisted ABI verdict record.
 * @throws {@link BackstopSloError} If required dependencies are missing, operator IDs are invalid, or numbers/bounds are out of range.
 */
export async function evaluateBackstopSlo(
  input: EvaluateBackstopSloInput,
): Promise<BackstopSloResult> {
  const store = requireDep(input.store, "store");
  const scorer = requireDep(input.scorer, "scorer");
  const alertManager = requireDep(input.alertManager, "alertManager");
  const sloVerdictStore = requireDep(input.sloVerdictStore, "sloVerdictStore");
  const windows = requireDep(input.windows, "windows");
  const bounds = requireDep(input.bounds, "bounds");

  assertBoundLedger(bounds.latencyBoundLedgers, "latencyBoundLedgers");
  assertBoundLedger(bounds.gracePeriodLedgers, "gracePeriodLedgers");
  assertBoundLedger(bounds.monitoringLagGraceLedgers, "monitoringLagGraceLedgers");
  if (bounds.xlmFloatMinStroops < 0n || bounds.xlmFloatMinStroops > MAX_STROOPS) {
    throw new BackstopSloError("BOUNDS_OUT_OF_RANGE", "xlmFloatMinStroops out of range");
  }

  assertLedger(input.chainHeadLedger, "chainHeadLedger");
  assertLedger(input.lastProcessedLedger, "lastProcessedLedger");
  if (input.lastProcessedLedger > input.chainHeadLedger) {
    throw new BackstopSloError(
      "LEDGER_OUT_OF_RANGE",
      "lastProcessedLedger exceeds chainHeadLedger",
    );
  }
  if (
    typeof input.xlmFloatStroops !== "bigint" ||
    input.xlmFloatStroops < 0n ||
    input.xlmFloatStroops > MAX_STROOPS
  ) {
    throw new BackstopSloError("STROOPS_OUT_OF_RANGE", "xlmFloatStroops must be in 0..2^63-1");
  }

  for (const window of windows) {
    assertOperatorId(window.operatorId);
    if (window.operatorId !== ORBITAL_BACKSTOP_OPERATOR_ID) {
      throw new BackstopSloError(
        "INVALID_OPERATOR",
        "evaluateBackstopSlo only publishes Orbital windows",
      );
    }
    if (!WINDOW_STATUSES.has(window.status)) {
      throw new BackstopSloError("UNKNOWN_VERDICT", `Unknown window status: ${window.status}`);
    }
    assertLedger(window.ledgerStart, "ledgerStart");
    assertLedger(window.ledgerEnd, "ledgerEnd");
    await store.record(window);
  }

  let operatorScore = await scorer.score(store, ORBITAL_BACKSTOP_OPERATOR_ID);
  const orbitalRows = await store.getByOperator(ORBITAL_BACKSTOP_OPERATOR_ID);
  if (orbitalRows.length === 0) {
    operatorScore = {
      operatorId: ORBITAL_BACKSTOP_OPERATOR_ID,
      formulaVersion: operatorScore.formulaVersion,
      kind: "insufficient-data",
    };
  }

  const lag = input.chainHeadLedger - input.lastProcessedLedger;
  const missed = windows.some((w) => w.status === "missed");
  const floatLow = input.xlmFloatStroops < bounds.xlmFloatMinStroops;
  const lagHigh = lag > bounds.monitoringLagGraceLedgers;

  let status: SloStatus;
  if (missed || floatLow || lagHigh) {
    status = "breached";
  } else if (windows.length === 0) {
    status = "unverifiable";
  } else {
    status = "meeting";
  }

  const contractId = `backstop:${ORBITAL_BACKSTOP_OPERATOR_ID}`;
  const abiStatus = sloToAbi(status);
  const previous = await sloVerdictStore.getLatest(contractId);
  const abiRecord: VerdictRecord = {
    contractId,
    status: abiStatus,
    verifiedAt: new Date().toISOString(),
    previousStatus: previous?.status,
  };
  await sloVerdictStore.record(abiRecord);

  const isRepeat = previous?.status === abiStatus;
  const isFirstNonBreach = previous === null && abiStatus !== "mismatch";
  if (!isRepeat && !isFirstNonBreach) {
    const prevRecord: VerdictRecord = previous ?? {
      contractId,
      status: "verified",
      verifiedAt: "",
    };
    await alertManager.alertTransition(prevRecord, abiRecord);
  }

  return { status, operatorScore, abiRecord };
}
