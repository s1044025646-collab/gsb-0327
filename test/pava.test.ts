import { test } from "node:test";
import assert from "node:assert/strict";
import { fitIsotonic, IsoError } from "../src/pava.js";

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const closeArr = (a: number[], b: number[], eps = 1e-9) => a.length === b.length && a.every((v, i) => close(v, b[i], eps));

test("空序列返回空结果与零误差", () => {
  const r = fitIsotonic([], [], "increasing");
  assert.deepEqual(r.fitted, []);
  assert.deepEqual(r.blocks, []);
  assert.equal(r.sse, 0);
});

test("单点原样返回", () => {
  const r = fitIsotonic([4.5], [2], "increasing");
  assert.deepEqual(r.fitted, [4.5]);
  assert.equal(r.sse, 0);
  assert.equal(r.blocks.length, 1);
});

test("全相等序列保持不变", () => {
  const r = fitIsotonic([2, 2, 2, 2], [1, 1, 1, 1], "increasing");
  assert.deepEqual(r.fitted, [2, 2, 2, 2]);
  assert.equal(r.sse, 0);
});

test("全逆序合并为一个块", () => {
  const r = fitIsotonic([4, 3, 2, 1], [1, 1, 1, 1], "increasing");
  assert.deepEqual(r.fitted, [2.5, 2.5, 2.5, 2.5]);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.mergeCount, 3);
});

test("负数与重复值", () => {
  const r = fitIsotonic([-1, -3, -3, 0], [1, 2, 1, 1], "increasing");
  assert.ok(r.fitted.every((v, i) => i === 0 || r.fitted[i - 1] <= v));
  assert.ok(r.sse >= 0);
});

test("已单调序列不变, 合并次数为 0", () => {
  const r = fitIsotonic([1, 2, 3], [1, 1, 1], "increasing");
  assert.deepEqual(r.fitted, [1, 2, 3]);
  assert.equal(r.mergeCount, 0);
});

test("手算: y=3,1,2 等权 -> fitted 全为 2, SSE=2", () => {
  const r = fitIsotonic([3, 1, 2], [1, 1, 1], "increasing");
  assert.ok(closeArr(r.fitted, [2, 2, 2]));
  assert.ok(close(r.sse, 2));
  assert.equal(r.merges.length, 1);
  assert.ok(close(r.merges[0].merged.mean, 2));
  assert.equal(r.blocks.length, 1);
});

test("手算: y=3,1,2 权重 5,1,1 -> fitted 全为 18/7, SSE=26/7", () => {
  const r = fitIsotonic([3, 1, 2], [5, 1, 1], "increasing");
  assert.ok(closeArr(r.fitted, [18 / 7, 18 / 7, 18 / 7]));
  assert.ok(close(r.sse, 26 / 7));
});

test("多次回退合并: y=5,1,4,2,3", () => {
  const r = fitIsotonic([5, 1, 4, 2, 3], [1, 1, 1, 1, 1], "increasing");
  assert.ok(r.fitted.every((v, i) => i === 0 || r.fitted[i - 1] <= v));
  assert.ok(r.mergeCount >= 2);
});

test("非递增方向: y=1,2,3 -> fitted 全为 2", () => {
  const r = fitIsotonic([1, 2, 3], [1, 1, 1], "decreasing");
  assert.ok(closeArr(r.fitted, [2, 2, 2]));
  assert.ok(close(r.sse, 2));
});

test("两种方向产生不同结果", () => {
  const inc = fitIsotonic([3, 1, 2], [1, 1, 1], "increasing");
  const dec = fitIsotonic([3, 1, 2], [1, 1, 1], "decreasing");
  assert.ok(!closeArr(inc.fitted, dec.fitted));
});

test("权重统一乘正数不改变拟合", () => {
  const y = [3, 1, 2, 0, 5];
  const w = [1, 2, 1, 3, 1];
  const a = fitIsotonic(y, w, "increasing");
  const b = fitIsotonic(y, w.map((x) => x * 7.5), "increasing");
  assert.ok(closeArr(a.fitted, b.fitted));
});

test("观测整体平移同步平移结果", () => {
  const y = [3, 1, 2, 0, 5];
  const w = [1, 2, 1, 3, 1];
  const a = fitIsotonic(y, w, "increasing");
  const b = fitIsotonic(y.map((v) => v + 10), w, "increasing");
  assert.ok(closeArr(b.fitted, a.fitted.map((v) => v + 10)));
});

test("重复拟合结果一致", () => {
  const y = [3, 1, 2];
  const a = fitIsotonic(y, [1, 1, 1], "increasing");
  const b = fitIsotonic(y, [1, 1, 1], "increasing");
  assert.deepEqual(a.fitted, b.fitted);
  assert.equal(a.sse, b.sse);
});

test("块范围恰好覆盖序列且不重叠, 块均值可重新核算", () => {
  const y = [5, 1, 4, 2, 3, 9, 0];
  const w = [1, 3, 1, 2, 1, 1, 4];
  const r = fitIsotonic(y, w, "increasing");
  let pos = 0;
  for (const b of r.blocks) {
    assert.equal(b.start, pos);
    pos = b.end;
    let ws = 0, vs = 0;
    for (let i = b.start; i < b.end; i++) { ws += w[i]; vs += w[i] * y[i]; }
    assert.ok(close(b.weightSum, ws));
    assert.ok(close(b.valueSum, vs));
    assert.ok(close(b.mean, vs / ws));
  }
  assert.equal(pos, y.length);
});

// 枚举所有连续分块, 计算最优加权误差作对照
function bruteForceBest(y: number[], w: number[]): number {
  const n = y.length;
  let best = Infinity;
  const blockCost = (s: number, e: number) => {
    let ws = 0, vs = 0, qs = 0;
    for (let i = s; i < e; i++) { ws += w[i]; vs += w[i] * y[i]; qs += w[i] * y[i] * y[i]; }
    return { cost: qs - (vs * vs) / ws, mean: vs / ws };
  };
  const go = (i: number, acc: number, lastMean: number) => {
    if (i === n) { best = Math.min(best, acc); return; }
    for (let e = i + 1; e <= n; e++) { const b = blockCost(i, e); if (b.mean >= lastMean) go(e, acc + b.cost, b.mean); }
  };
  go(0, 0, -Infinity);
  return best;
}

test("极小序列与暴力枚举连续分块对照", () => {
  const cases: Array<[number[], number[]]> = [
    [[3, 1, 2], [1, 1, 1]],
    [[2, 0, 1], [2, 1, 3]],
    [[1, 4, 2, 3], [1, 1, 2, 1]],
    [[0, -1, 5, -2], [1, 2, 1, 1]],
  ];
  for (const [y, w] of cases) {
    const r = fitIsotonic(y, w, "increasing");
    assert.ok(close(r.sse, bruteForceBest(y, w), 1e-9), `y=${y} w=${w}`);
  }
});

test("非法输入被拒绝", () => {
  assert.throws(() => fitIsotonic([NaN], [1], "increasing"));
});
