import type { Capability, Outcome } from "../../../src/harness/types.js";

export interface DogfoodMetadata {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly repoSha: string;
  readonly repoDirty: boolean;
  readonly testbedBaseUrl: string;
  readonly browxaiCapabilities: readonly string[];
  readonly rowlessCapabilities: readonly string[];
  readonly byobAttachPosture: "recorded_only";
  readonly model: string;
  readonly effort: string;
  readonly sandbox: string;
  readonly approvalPolicy: string;
  readonly kDefault: number;
  readonly headless: boolean;
  readonly mode: "live" | "mock";
}

export interface CoverageBucket {
  readonly toolsTouched: readonly string[];
  readonly toolsMissed: readonly string[];
  readonly pct: number;
}

export interface FrictionMetric {
  readonly tool: string;
  readonly capability?: Capability;
  readonly errorCount: number;
  readonly retryCount: number;
  readonly abandonCount: number;
  readonly schemaValidationFailureCount: number;
  readonly wrongToolAttemptCount: number;
  readonly changedArgumentRetryCount: number;
  readonly avgDurationMs: number;
  readonly firstSuccessLatencyMs?: number;
  readonly reasoningSummaryCount: number;
  readonly confusionScore: number;
}

export interface CapabilityFrictionRollup {
  readonly errorCount: number;
  readonly retryCount: number;
  readonly abandonCount: number;
  readonly schemaValidationFailureCount: number;
  readonly wrongToolAttemptCount: number;
  readonly avgConfusionScore: number;
}

export interface OracleToolOutcome {
  readonly tool: string;
  readonly outcome: Outcome;
  readonly detail?: string;
}

export interface MissionRunOutcome {
  readonly runIndex: number;
  readonly passed: boolean;
  readonly status: "passed" | "passed_with_friction" | "incomplete" | "failed";
  readonly coverageComplete: boolean;
  readonly toolsTouched: readonly string[];
  readonly toolsMissing: readonly string[];
  readonly finalMarkerPresent: boolean;
  readonly oraclePassed: boolean;
  readonly frictionCount: number;
  readonly failReason?: string;
  readonly agentReflection: string;
  readonly oracleResults: readonly OracleToolOutcome[];
}

export interface MissionOutcome {
  readonly passed: boolean;
  readonly status: "passed" | "passed_with_friction" | "unstable_pass" | "incomplete" | "failed";
  readonly stability: "single-run" | "stable_pass" | "unstable_pass" | "stable_fail";
  readonly passCount: number;
  readonly runCount: number;
  readonly requiredPassCount: number;
  readonly coverageComplete: boolean;
  readonly toolsTouched: readonly string[];
  readonly toolsMissing: readonly string[];
  readonly failReason?: string;
  readonly agentReflection: string;
  readonly runs: readonly MissionRunOutcome[];
}

export interface DogfoodReport {
  readonly metadata: DogfoodMetadata;
  readonly coverageMatrix: Record<string, CoverageBucket>;
  readonly capabilityFriction: Record<string, CapabilityFrictionRollup>;
  readonly frictionMetrics: Record<string, FrictionMetric>;
  readonly missionOutcomes: Record<string, MissionOutcome>;
  readonly aggregateSummary: {
    readonly totalToolsTouched: number;
    readonly coveragePct: number;
    readonly aggregateStability: "single-run" | "stable" | "unstable" | "failed";
    readonly topFrictionTools: readonly string[];
  };
  readonly traces: ReadonlyArray<{
    readonly missionId: string;
    readonly runIndex: number;
    readonly path: string;
  }>;
}

export interface NormalizedDogfoodReport {
  readonly schemaVersion: 1;
  readonly metadata: Omit<DogfoodMetadata, "generatedAt" | "testbedBaseUrl" | "repoDirty">;
  readonly coverageMatrix: DogfoodReport["coverageMatrix"];
  readonly capabilityFriction: DogfoodReport["capabilityFriction"];
  readonly frictionMetrics: Record<
    string,
    Omit<FrictionMetric, "avgDurationMs" | "firstSuccessLatencyMs" | "reasoningSummaryCount">
  >;
  readonly missionOutcomes: Record<
    string,
    Omit<MissionOutcome, "agentReflection" | "runs"> & {
      readonly runs: ReadonlyArray<
        Omit<MissionRunOutcome, "agentReflection" | "oracleResults"> & {
          readonly oracleOutcomes: readonly Outcome[];
        }
      >;
    }
  >;
  readonly aggregateSummary: DogfoodReport["aggregateSummary"];
}
