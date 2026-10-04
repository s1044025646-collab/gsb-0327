export type Direction = 'nondecreasing' | 'nonincreasing';

export const ALGORITHM_VERSION = 'pava-1.0.0';

export interface InputLimits {
  maxLength: number;
  maxAbsValue: number;
  maxWeight: number;
  maxAccumulator: number;
}

export const LIMITS: InputLimits = {
  maxLength: 100_000,
  maxAbsValue: 1e12,
  maxWeight: 1e9,
  maxAccumulator: Number.MAX_VALUE,
};

export interface PavaBlock {
  start: number;
  end: number;
  weightSum: number;
  weightedSum: number;
  value: number;
}

export interface MergeEvent {
  step: number;
  triggerIndex: number;
  direction: Direction;
  kind: 'violation' | 'equal-coalesce';
  before: {
    left: PavaBlock;
    right: PavaBlock;
  };
  after: PavaBlock;
  affectedIndices: number[];
}

export interface FitResult {
  n: number;
  direction: Direction;
  fit: number[];
  blocks: PavaBlock[];
  residuals: number[];
  weightedSSE: number;
  mergeEvents: MergeEvent[];
  totalMerges: number;
  eventsTruncated: boolean;
  algorithmVersion: string;
}
