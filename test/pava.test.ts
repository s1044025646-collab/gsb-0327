import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitIsotonic } from '../src/pava.js';
import { AppError } from '../src/errors.js';

function expectSorted(fit: number[], nondecreasing: boolean): void {
  for (let i = 1; i < fit.length; i++) {
    if (nondecreasing) assert.ok(fit[i - 1] <= fit[i] + 1e-12);
    else assert.ok(fit[i - 1] >= fit[i] - 1e-12);
  }
}

function weightedSSEBrute(y: number[], w: number[], fit: number[]): number {
  return y.reduce((acc, yi, i) => acc + w[i] * (yi - fit[i]) ** 2, 0);
}

test('空序列返回空结果与零误差', () => {
  const r = fitIsotonic([], [], 'nondecreasing');
  assert.deepEqual(r.fit, []);
  assert.deepEqual(r.blocks, []);
  assert.equal(r.weightedSSE, 0);
});

test('单点原样返回', () => {
  const r = fitIsotonic([7], [2], 'nondecreasing');
  assert.deepEqual(r.fit, [7]);
  assert.equal(r.weightedSSE, 0);
  assert.equal(r.blocks[0].weightSum, 2);
});

test('等权 [3,1,2] 触发向前连续合并', () => {
  const r = fitIsotonic([3, 1, 2], [1, 1, 1], 'nondecreasing');
  assert.deepEqual(r.fit, [2, 2, 2]);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.totalMerges, 2);
  assert.equal(r.mergeEvents[0].affectedIndices.join(','), '0,1');
  assert.equal(r.mergeEvents[1].affectedIndices.join(','), '0,1,2');
  // 加权统计按权重核算
  assert.equal(r.blocks[0].weightedSum, 6);
  assert.equal(r.blocks[0].weightSum, 3);
});

test('改首点权重后块均值按权重计算 [3,1,1] -> 2.4', () => {
  const r = fitIsotonic([3, 1, 2], [3, 1, 1], 'nondecreasing');
  r.fit.forEach((v) => assert.ok(Math.abs(v - 2.4) < 1e-12));
  // SSE = 3*0.6^2 + 1.4^2 + 0.4^2 = 1.08 + 1.96 + 0.16 = 3.2
  assert.ok(Math.abs(r.weightedSSE - 3.2) < 1e-12);
});

test('已单调序列保持不变且无合并', () => {
  const r = fitIsotonic([1, 2, 3], [1, 1, 1], 'nondecreasing');
  assert.deepEqual(r.fit, [1, 2, 3]);
  assert.equal(r.totalMerges, 0);
  assert.equal(r.blocks.length, 3);
});

test('两种方向结果不同：非递增 [3,1,2] -> [3,1.5,1.5]', () => {
  const dec = fitIsotonic([3, 1, 2], [1, 1, 1], 'nonincreasing');
  assert.deepEqual(dec.fit, [3, 1.5, 1.5]);
  assert.equal(dec.blocks.length, 2);
  const inc = fitIsotonic([3, 1, 2], [1, 1, 1], 'nondecreasing');
  assert.notDeepEqual(inc.fit, dec.fit);
});

test('全相等、全逆序、负数、重复值', () => {
  assert.deepEqual(fitIsotonic([5, 5, 5], [1, 1, 1], 'nondecreasing').fit, [5, 5, 5]);
  const rev = fitIsotonic([3, 2, 1], [1, 2, 3], 'nondecreasing');
  expectSorted(rev.fit, true);
  assert.ok(rev.blocks.length === 1);
  const neg = fitIsotonic([-1, -5, -2], [1, 1, 1], 'nondecreasing');
  assert.deepEqual(neg.fit, [-3, -3, -2]);
  const dup = fitIsotonic([2, 2, 1, 1], [1, 1, 1, 1], 'nondecreasing');
  assert.deepEqual(dup.fit, [1.5, 1.5, 1.5, 1.5]);
});

test('多次回退合并（每次新点都向前吞并多个块）', () => {
  const y = [5, 4, 3, 2, 1];
  const r = fitIsotonic(y, [1, 1, 1, 1, 1], 'nondecreasing');
  assert.deepEqual(r.fit, [3, 3, 3, 3, 3]);
  assert.equal(r.totalMerges, 4);
});

test('手算加权误差小例子', () => {
  // y=[4,1], w=[1,3] -> 均值 (4+3)/4=1.75
  // SSE = 1*(4-1.75)^2 + 3*(1-1.75)^2 = 5.0625 + 1.6875 = 6.75
  const r = fitIsotonic([4, 1], [1, 3], 'nondecreasing');
  assert.deepEqual(r.fit, [1.75, 1.75]);
  assert.ok(Math.abs(r.weightedSSE - 6.75) < 1e-12);
});

test('枚举所有连续分块的块均值做最优性对照', () => {
  const cases: Array<[number[], number[]]> = [
    [[3, 1, 2], [1, 1, 1]],
    [[3, 1, 2], [3, 1, 1]],
    [[4, 1, 3, 2], [2, 1, 1, 3]],
    [[-2, 0, -1, 5, 4], [1, 2, 1, 1, 2]],
  ];
  for (const [y, w] of cases) {
    const r = fitIsotonic(y, w, 'nondecreasing');
    const n = y.length;
    let best = Infinity;
    // 用切点位掩码枚举所有连续分块
    for (let mask = 0; mask < 1 << (n - 1); mask++) {
      const bounds = [0];
      for (let i = 0; i < n - 1; i++) if (mask & (1 << i)) bounds.push(i + 1);
      bounds.push(n);
      const means: number[] = [];
      let sse = 0;
      for (let b = 0; b < bounds.length - 1; b++) {
        let ws = 0;
        let wsum = 0;
        for (let i = bounds[b]; i < bounds[b + 1]; i++) {
          ws += w[i] * y[i];
          wsum += w[i];
        }
        const m = ws / wsum;
        for (let i = bounds[b]; i < bounds[b + 1]; i++) {
          sse += w[i] * (y[i] - m) ** 2;
          means[i] = m;
        }
      }
      let nondec = true;
      for (let i = 1; i < n; i++) if (means[i - 1] > means[i] + 1e-9) nondec = false;
      if (nondec) best = Math.min(best, sse);
    }
    assert.ok(Math.abs(r.weightedSSE - best) < 1e-9, `PAVA SSE ${r.weightedSSE} 应等于枚举最优 ${best}`);
    assert.ok(Math.abs(r.weightedSSE - weightedSSEBrute(y, w, r.fit)) < 1e-9);
  }
});

test('权重统一乘正数不改变拟合', () => {
  const y = [5, 1, 4, 2];
  const a = fitIsotonic(y, [1, 2, 1, 3], 'nondecreasing');
  const b = fitIsotonic(y, [7, 14, 7, 21], 'nondecreasing');
  assert.deepEqual(b.fit, a.fit);
});

test('观测整体平移，结果同步平移', () => {
  const y = [5, 1, 4, 2];
  const w = [1, 2, 1, 3];
  const a = fitIsotonic(y, w, 'nondecreasing');
  const shifted = y.map((v) => v + 10);
  const b = fitIsotonic(shifted, w, 'nondecreasing');
  b.fit.forEach((f, i) => assert.ok(Math.abs(f - (a.fit[i] + 10)) < 1e-9));
});

test('重复拟合结果稳定（幂等）', () => {
  const r1 = fitIsotonic([9, 1, 8, 2, 7], [1, 1, 1, 1, 1], 'nondecreasing');
  const r2 = fitIsotonic([9, 1, 8, 2, 7], [1, 1, 1, 1, 1], 'nondecreasing');
  assert.deepEqual(r2.fit, r1.fit);
  assert.deepEqual(r2.blocks, r1.blocks);
});

test('解释记录限量但不提前结束计算', () => {
  const y = Array.from({ length: 10 }, (_, i) => 10 - i);
  const r = fitIsotonic(y, undefined, 'nondecreasing', 3);
  assert.equal(r.mergeEvents.length, 3);
  assert.equal(r.eventsTruncated, true);
  assert.equal(r.totalMerges, 9);
  assert.equal(r.fit.length, 10);
  assert.ok(r.fit.every((v) => v === 5.5));
});

test('块范围恰好覆盖且互不重叠，并可由原始观测重算', () => {
  const y = [9, 1, 8, 2, 7];
  const w = [1, 2, 1, 3, 1];
  const r = fitIsotonic(y, w, 'nondecreasing');
  assert.equal(r.blocks[0].start, 0);
  assert.equal(r.blocks[r.blocks.length - 1].end, 4);
  for (let i = 1; i < r.blocks.length; i++) assert.equal(r.blocks[i].start, r.blocks[i - 1].end + 1);
  for (const b of r.blocks) {
    let ws = 0;
    let wsum = 0;
    for (let i = b.start; i <= b.end; i++) {
      ws += w[i] * y[i];
      wsum += w[i];
    }
    assert.ok(Math.abs(b.weightedSum - ws) < 1e-9);
    assert.ok(Math.abs(b.weightSum - wsum) < 1e-9);
    assert.ok(Math.abs(b.value - ws / wsum) < 1e-12);
  }
});

test('拒绝非法输入', () => {
  assert.throws(() => fitIsotonic(['1', '2'], undefined, 'nondecreasing'), AppError);
  assert.throws(() => fitIsotonic([1, null], undefined, 'nondecreasing'), AppError);
  assert.throws(() => fitIsotonic([1, NaN], undefined, 'nondecreasing'), AppError);
  assert.throws(() => fitIsotonic([1, Infinity], undefined, 'nondecreasing'), AppError);
  assert.throws(() => fitIsotonic([1, 2], [1], 'nondecreasing'), AppError);
  assert.throws(() => fitIsotonic([1, 2], [1, 0], 'nondecreasing'), AppError);
  assert.throws(() => fitIsotonic([1, 2], [1, -3], 'nondecreasing'), AppError);
  assert.throws(() => fitIsotonic([1, 2], [1, 1], 'increasing' as never), AppError);
});

test('缺省权重统一为一', () => {
  const r = fitIsotonic([3, 1], undefined, 'nondecreasing');
  assert.deepEqual(r.fit, [2, 2]);
});
