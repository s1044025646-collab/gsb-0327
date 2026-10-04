import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fitIsotonic } from './pava.js';
import type { FitResult } from './types.js';

function renderTable(title: string, y: number[], w: number[], r: FitResult): void {
  console.log(`\n=== ${title}（方向: ${r.direction}，加权 SSE = ${r.weightedSSE}，合并次数 = ${r.totalMerges}）===`);
  const blockOf: number[] = new Array(r.n);
  r.blocks.forEach((b, bi) => {
    for (let i = b.start; i <= b.end; i++) blockOf[i] = bi;
  });
  const rows = y.map((yi, i) => ({
    pos: i,
    y: yi,
    w: w[i],
    fit: r.fit[i],
    residual: r.residuals[i],
    block: blockOf[i],
  }));
  console.table(rows);
  console.log('最终常值块:');
  console.table(
    r.blocks.map((b, bi) => ({
      block: bi,
      start: b.start,
      end: b.end,
      weightSum: b.weightSum,
      weightedSum: b.weightedSum,
      value: b.value,
    })),
  );
}

function showForwardMerge(): void {
  // [3,1,2] 等权非递减：先合并 (3,1)->2，再与 2 合并，触发“继续向前检查”
  const y = [3, 1, 2];
  const w = [1, 1, 1];
  const r = fitIsotonic(y, w, 'nondecreasing', 100);
  renderTable('演示 1：等权 [3,1,2] 向前连续合并', y, w, r);
  console.log('合并过程（解释记录）:');
  console.dir(r.mergeEvents, { depth: null });
}

function showWeightChange(): void {
  // 改首点权重为 3：加权合并均值 (3*3 + 1*1 + 1*2) / 5 = 2.4
  const y = [3, 1, 2];
  const w = [3, 1, 1];
  const r = fitIsotonic(y, w, 'nondecreasing');
  renderTable('演示 2：改变首点权重 [3,1,1]，块均值按权重计算', y, w, r);
}

function showMonotone(): void {
  const y = [1, 2, 3];
  const w = [1, 1, 1];
  const r = fitIsotonic(y, w, 'nondecreasing');
  renderTable('演示 3：已单调序列保持不变', y, w, r);
}

function showDirections(): void {
  const y = [3, 1, 2];
  const w = [1, 1, 1];
  renderTable('演示 4a：[3,1,2] 非递减', y, w, fitIsotonic(y, w, 'nondecreasing'));
  renderTable('演示 4b：[3,1,2] 非递增（后两点合并为 1.5，首点保持 3）', y, w, fitIsotonic(y, w, 'nonincreasing'));
}

function main(): void {
  mkdirSync(resolve('data'), { recursive: true });
  console.log('PAVA 加权保序回归终端演示（仅计算展示，持久化由 CLI/API 演示见 README）');
  showForwardMerge();
  showWeightChange();
  showMonotone();
  showDirections();
}

main();
