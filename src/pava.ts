import { AppError } from './errors.js';
import { validateSeries } from './validation.js';
import {
  ALGORITHM_VERSION,
  LIMITS,
  type Direction,
  type FitResult,
  type MergeEvent,
  type PavaBlock,
} from './types.js';

interface RawBlock {
  start: number;
  end: number;
  weightSum: number;
  weightedSum: number;
}

function blockMean(b: RawBlock): number {
  return b.weightedSum / b.weightSum;
}

function checkFinite(label: string, value: number): void {
  if (!Number.isFinite(value)) {
    throw new AppError(
      'NUMERIC_OVERFLOW',
      `累计量${label}溢出（得到 ${value}），请缩小数值范围或序列长度`,
      { accumulator: label },
    );
  }
}

function affectedRange(b: RawBlock): number[] {
  const out: number[] = new Array(b.end - b.start + 1);
  for (let i = b.start; i <= b.end; i++) out[i - b.start] = i;
  return out;
}

/**
 * 加权保序回归（Pool Adjacent Violators Algorithm）。
 *
 * 从单点块开始，每块保存起止位置、权重和 weightSum、加权观测和 weightedSum，
 * 块拟合值 = weightedSum / weightSum（按权重合并，绝不对块均值做简单平均）。
 * 当相邻两块违反目标顺序时合并，合并后继续向前检查，直到顺序恢复。
 *
 * 非递增方向通过对观测取负号复用同一套“非递减”核心，
 * 事件与结果中的均值均映射回原始数值方向。
 */
export function fitIsotonic(
  y: unknown,
  w: unknown,
  direction: Direction,
  maxEvents: number = 10_000,
): FitResult {
  validateDirectionParam(direction);
  const { values, weights } = validateSeries(y, w);
  const n = values.length;
  const sign = direction === 'nondecreasing' ? 1 : -1;

  const checkAcc = (b: RawBlock): void => {
    checkFinite('权重和', b.weightSum);
    checkFinite('加权观测和', b.weightedSum);
  };

  const stack: RawBlock[] = [];
  const events: MergeEvent[] = [];
  let totalMerges = 0;
  let eventsTruncated = false;

  for (let i = 0; i < n; i++) {
    let cur: RawBlock = {
      start: i,
      end: i,
      weightSum: weights[i],
      weightedSum: sign * values[i] * weights[i],
    };
    checkAcc(cur);

    while (stack.length > 0) {
      const prev = stack[stack.length - 1];
      const prevMean = blockMean(prev);
      const curMean = blockMean(cur);
      checkFinite('块均值', prevMean);
      checkFinite('块均值', curMean);

      // 非递减核心中的“违规”：前块均值 > 后块均值
      if (!(prevMean > curMean)) break;

      totalMerges++;
      const merged: RawBlock = {
        start: prev.start,
        end: cur.end,
        weightSum: prev.weightSum + cur.weightSum,
        weightedSum: prev.weightedSum + cur.weightedSum,
      };
      checkAcc(merged);

      if (events.length < maxEvents) {
        const toView = (b: RawBlock): PavaBlock => ({
          start: b.start,
          end: b.end,
          weightSum: b.weightSum,
          weightedSum: sign * b.weightedSum,
          value: sign * blockMean(b),
        });
        events.push({
          step: totalMerges,
          triggerIndex: i,
          direction,
          kind: 'violation' as const,
          before: { left: toView(prev), right: toView(cur) },
          after: toView(merged),
          affectedIndices: affectedRange(merged),
        });
      } else {
        eventsTruncated = true;
      }

      stack.pop();
      cur = merged;
    }
    stack.push(cur);
  }

  // 公开的展示合并规则：相邻块拟合值相同（含浮点容差）时合并为同一常值块。
  // 该合并不改变拟合值与 SSE，但同样按权重累计统计并写入解释记录。
  const coalesced: RawBlock[] = [];
  for (const b of stack) {
    const last = coalesced[coalesced.length - 1];
    if (last) {
      const a = blockMean(last);
      const c = blockMean(b);
      const tol = 1e-12 * Math.max(1, Math.abs(a), Math.abs(c));
      if (Math.abs(a - c) <= tol) {
        const beforeLeft = { ...last };
        const beforeRight = { ...b };
        totalMerges++;
        last.end = b.end;
        last.weightSum += b.weightSum;
        last.weightedSum += b.weightedSum;
        checkAcc(last);
        if (events.length < maxEvents) {
          const toView2 = (src: RawBlock): PavaBlock => ({
            start: src.start,
            end: src.end,
            weightSum: src.weightSum,
            weightedSum: sign * src.weightedSum,
            value: sign * blockMean(src),
          });
          events.push({
            step: totalMerges,
            triggerIndex: b.start,
            direction,
            kind: 'equal-coalesce',
            before: { left: toView2(beforeLeft), right: toView2(beforeRight) },
            after: toView2(last),
            affectedIndices: affectedRange(last),
          });
        } else {
          eventsTruncated = true;
        }
        continue;
      }
    }
    coalesced.push({ ...b });
  }

  // 由最终常值块展开完整拟合序列
  const fit: number[] = new Array(n);
  const blocks: PavaBlock[] = [];
  for (const b of coalesced) {
    const meanOriginal = sign * blockMean(b);
    if (!Number.isFinite(meanOriginal)) {
      throw new AppError('NUMERIC_OVERFLOW', '块均值溢出或非有限', { block: b });
    }
    const view: PavaBlock = {
      start: b.start,
      end: b.end,
      weightSum: b.weightSum,
      weightedSum: sign * b.weightedSum,
      value: meanOriginal,
    };
    blocks.push(view);
    for (let i = b.start; i <= b.end; i++) fit[i] = meanOriginal;
  }

  // 残差与加权平方误差
  const residuals: number[] = new Array(n);
  let weightedSSE = 0;
  for (let i = 0; i < n; i++) {
    const r = values[i] - fit[i];
    residuals[i] = r;
    const term = weights[i] * r * r;
    if (!Number.isFinite(term)) {
      throw new AppError('NUMERIC_OVERFLOW', `第 ${i} 点加权平方误差项溢出`, { index: i });
    }
    weightedSSE += term;
  }
  if (!Number.isFinite(weightedSSE) || weightedSSE > LIMITS.maxAccumulator) {
    throw new AppError('NUMERIC_OVERFLOW', '总加权平方误差溢出');
  }

  return {
    n,
    direction,
    fit,
    blocks,
    residuals,
    weightedSSE,
    mergeEvents: events,
    totalMerges,
    eventsTruncated,
    algorithmVersion: ALGORITHM_VERSION,
  };
}

function validateDirectionParam(direction: Direction): void {
  if (direction !== 'nondecreasing' && direction !== 'nonincreasing') {
    throw new AppError(
      'VALIDATION_ERROR',
      `非法方向: ${JSON.stringify(direction)}，必须为 "nondecreasing" 或 "nonincreasing"`,
      { field: 'direction' },
    );
  }
}
