import { AppError } from './errors.js';
import { LIMITS, type Direction } from './types.js';

export function isStrictlyFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function validateDirection(dir: unknown): Direction {
  if (dir !== 'nondecreasing' && dir !== 'nonincreasing') {
    throw new AppError(
      'VALIDATION_ERROR',
      `非法方向: ${JSON.stringify(dir)}，必须为 "nondecreasing" 或 "nonincreasing"`,
      { field: 'direction' },
    );
  }
  return dir;
}

/**
 * 校验观测序列与权重。
 * - 观测必须为数组，元素必须是有限 number（拒绝字符串隐式转数、null、NaN、Infinity）
 * - 缺省权重统一为 1；显式权重长度必须一致且严格为正的有限数
 */
export function validateSeries(y: unknown, w?: unknown): { values: number[]; weights: number[] } {
  if (!Array.isArray(y)) {
    throw new AppError('VALIDATION_ERROR', '观测值 y 必须为数组', { field: 'y' });
  }
  if (y.length > LIMITS.maxLength) {
    throw new AppError(
      'VALIDATION_ERROR',
      `序列长度 ${y.length} 超过上限 ${LIMITS.maxLength}`,
      { field: 'y', limit: LIMITS.maxLength },
    );
  }
  const values: number[] = new Array(y.length);
  for (let i = 0; i < y.length; i++) {
    const item = y[i];
    if (!isStrictlyFiniteNumber(item)) {
      throw new AppError(
        'VALIDATION_ERROR',
        `第 ${i} 个观测值不是有限数值（拒绝字符串、null、NaN、Infinity）`,
        { field: `y[${i}]`, received: item === null ? 'null' : typeof item },
      );
    }
    if (Math.abs(item) > LIMITS.maxAbsValue) {
      throw new AppError(
        'VALIDATION_ERROR',
        `第 ${i} 个观测值绝对值 ${Math.abs(item)} 超过上限 ${LIMITS.maxAbsValue}`,
        { field: `y[${i}]`, limit: LIMITS.maxAbsValue },
      );
    }
    values[i] = item;
  }

  let weights: number[];
  if (w === undefined || w === null) {
    weights = new Array(values.length).fill(1);
  } else {
    if (!Array.isArray(w)) {
      throw new AppError('VALIDATION_ERROR', '权重 w 必须为数组或省略', { field: 'w' });
    }
    if (w.length !== values.length) {
      throw new AppError(
        'VALIDATION_ERROR',
        `权重长度 ${w.length} 与观测长度 ${values.length} 不一致`,
        { field: 'w', expected: values.length, received: w.length },
      );
    }
    weights = new Array(w.length);
    for (let i = 0; i < w.length; i++) {
      const item = w[i];
      if (!isStrictlyFiniteNumber(item)) {
        throw new AppError(
          'VALIDATION_ERROR',
          `第 ${i} 个权重不是有限数值`,
          { field: `w[${i}]`, received: item === null ? 'null' : typeof item },
        );
      }
      if (item <= 0) {
        throw new AppError(
          'VALIDATION_ERROR',
          `第 ${i} 个权重必须严格为正，实际为 ${item}`,
          { field: `w[${i}]`, received: item },
        );
      }
      if (item > LIMITS.maxWeight) {
        throw new AppError(
          'VALIDATION_ERROR',
          `第 ${i} 个权重 ${item} 超过上限 ${LIMITS.maxWeight}`,
          { field: `w[${i}]`, limit: LIMITS.maxWeight },
        );
      }
      weights[i] = item;
    }
  }
  return { values, weights };
}

export function validateIndex(raw: unknown, n: number): number {
  const index = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(index) || index < 0 || index >= n) {
    throw new AppError('VALIDATION_ERROR', `下标越界：必须为 [0, ${n - 1}] 内的整数`, {
      field: 'index',
      received: raw,
    });
  }
  return index;
}
