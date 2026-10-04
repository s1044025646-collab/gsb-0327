export const ALGORITHM_VERSION = "pava-1.0.0";

export const LIMITS = {
  MAX_N: 100000,
  MAX_ABS_VALUE: 1e15,
  MAX_WEIGHT: 1e15,
  MAX_TRACE_RECORDS: 1000,
} as const;

export type Direction = "increasing" | "decreasing";

export class IsoError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Block {
  start: number; // inclusive
  end: number;   // exclusive
  weightSum: number;
  valueSum: number; // sum of w*y
  mean: number;
}

export interface MergeRecord {
  step: number;
  leftBlock: { start: number; end: number; weightSum: number; valueSum: number; mean: number };
  rightBlock: { start: number; end: number; weightSum: number; valueSum: number; mean: number };
  merged: { start: number; end: number; weightSum: number; valueSum: number; mean: number };
  affectedIndices: number[];
}

export interface FitResult {
  direction: Direction;
  n: number;
  fitted: number[];
  residuals: number[];
  sse: number;
  blocks: Block[];
  merges: MergeRecord[];
  mergeCount: number;
  traceTruncated: boolean;
  algorithmVersion: string;
}

function blockMean(b: { weightSum: number; valueSum: number }): number {
  return b.valueSum / b.weightSum;
}

function checkFinite(what: string, v: number): void {
  if (!Number.isFinite(v)) {
    throw new IsoError("OVERFLOW", `累计量溢出: ${what} 不再是有限数`);
  }
}

interface InternalBlock {
  start: number;
  end: number;
  weightSum: number;
  valueSum: number;
}

function pavaIncreasing(y: number[], w: number[]): { fitted: number[]; blocks: InternalBlock[]; merges: MergeRecord[]; mergeCount: number; traceTruncated: boolean } {
  const n = y.length;
  const blocks: InternalBlock[] = [];
  const merges: MergeRecord[] = [];
  let mergeCount = 0;
  let traceTruncated = false;

  for (let i = 0; i < n; i++) {
    const valueSum = w[i] * y[i];
    checkFinite("块加权观测和", valueSum);
    blocks.push({ start: i, end: i + 1, weightSum: w[i], valueSum });

    while (blocks.length >= 2) {
      const right = blocks[blocks.length - 1];
      const left = blocks[blocks.length - 2];
      if (blockMean(left) <= blockMean(right)) break;

      const weightSum = left.weightSum + right.weightSum;
      const valueSumM = left.valueSum + right.valueSum;
      checkFinite("合并块权重和", weightSum);
      checkFinite("合并块加权观测和", valueSumM);
      const merged: InternalBlock = { start: left.start, end: right.end, weightSum, valueSum: valueSumM };

      mergeCount++;
      if (merges.length < LIMITS.MAX_TRACE_RECORDS) {
        const affected: number[] = [];
        for (let k = merged.start; k < merged.end; k++) affected.push(k);
        merges.push({
          step: mergeCount,
          leftBlock: { start: left.start, end: left.end, weightSum: left.weightSum, valueSum: left.valueSum, mean: blockMean(left) },
          rightBlock: { start: right.start, end: right.end, weightSum: right.weightSum, valueSum: right.valueSum, mean: blockMean(right) },
          merged: { start: merged.start, end: merged.end, weightSum: merged.weightSum, valueSum: merged.valueSum, mean: blockMean(merged) },
          affectedIndices: affected,
        });
      } else {
        traceTruncated = true;
      }

      blocks.pop();
      blocks.pop();
      blocks.push(merged);
    }
  }

  const fitted = new Array<number>(n);
  for (const b of blocks) {
    const m = blockMean(b);
    for (let k = b.start; k < b.end; k++) fitted[k] = m;
  }
  return { fitted, blocks, merges, mergeCount, traceTruncated };
}

export function fitIsotonic(y: number[], w: number[], direction: Direction): FitResult {
  const n = y.length;
  const empty: FitResult = {
    direction, n: 0, fitted: [], residuals: [], sse: 0, blocks: [],
    merges: [], mergeCount: 0, traceTruncated: false, algorithmVersion: ALGORITHM_VERSION,
  };
  if (n === 0) return empty;

  let result: FitResult;
  if (direction === "increasing") {
    const r = pavaIncreasing(y, w);
    result = { ...empty, direction, n, fitted: r.fitted, blocks: toBlocks(r.blocks), merges: r.merges, mergeCount: r.mergeCount, traceTruncated: r.traceTruncated };
  } else {
    // 非递增: 对 y 取负后做非递减拟合, 再映射回原方向
    const negY = y.map((v) => -v);
    const r = pavaIncreasing(negY, w);
    const fitted = r.fitted.map((v) => -v);
    const blocks = toBlocks(r.blocks).map((b) => ({ ...b, valueSum: -b.valueSum, mean: -b.mean }));
    const merges = r.merges.map((m) => ({
      step: m.step,
      leftBlock: { ...m.leftBlock, valueSum: -m.leftBlock.valueSum, mean: -m.leftBlock.mean },
      rightBlock: { ...m.rightBlock, valueSum: -m.rightBlock.valueSum, mean: -m.rightBlock.mean },
      merged: { ...m.merged, valueSum: -m.merged.valueSum, mean: -m.merged.mean },
      affectedIndices: m.affectedIndices,
    }));
    result = { ...empty, direction, n, fitted, blocks, merges, mergeCount: r.mergeCount, traceTruncated: r.traceTruncated };
  }

  const residuals = new Array<number>(n);
  let sse = 0;
  for (let i = 0; i < n; i++) {
    const r = y[i] - result.fitted[i];
    residuals[i] = r;
    sse += w[i] * r * r;
    checkFinite("加权平方误差累计", sse);
  }
  result.residuals = residuals;
  result.sse = sse;
  return result;
}

function coalesceAdjacent(bs: Block[]): Block[] {
  // Display rule: adjacent blocks with equal fitted mean are merged into one constant block.
  const out: Block[] = [];
  for (const b of bs) {
    const last = out[out.length - 1];
    if (last && last.mean === b.mean) {
      out[out.length - 1] = { start: last.start, end: b.end, weightSum: last.weightSum + b.weightSum, valueSum: last.valueSum + b.valueSum, mean: last.mean };
    } else {
      out.push({ ...b });
    }
  }
  return out;
}

function toBlocks(bs: InternalBlock[]): Block[] {
  return coalesceAdjacent(bs.map((b) => ({ start: b.start, end: b.end, weightSum: b.weightSum, valueSum: b.valueSum, mean: blockMean(b) })));
}
