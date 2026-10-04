import type { FitRecord } from './db.js';

export function toJSONExport(rec: FitRecord): string {
  return JSON.stringify(
    {
      versionId: rec.versionId,
      direction: rec.direction,
      algorithmVersion: rec.algorithmVersion,
      createdAt: rec.createdAt,
      n: rec.result.n,
      weightedSSE: rec.result.weightedSSE,
      totalMerges: rec.result.totalMerges,
      eventsTruncated: rec.result.eventsTruncated,
      fit: rec.result.fit,
      blocks: rec.result.blocks,
      residuals: rec.result.residuals,
      mergeEvents: rec.result.mergeEvents,
    },
    null,
    2,
  );
}

export function toCSVExport(rec: FitRecord, observations: number[], weights: number[]): string {
  const header = 'index,y,weight,fit,residual,block,blockStart,blockEnd';
  const blockOf: number[] = new Array(rec.result.n);
  rec.result.blocks.forEach((b, bi) => {
    for (let i = b.start; i <= b.end; i++) blockOf[i] = bi;
  });
  const fmt = (v: number): string => {
    if (Number.isInteger(v)) return String(v);
    return String(v);
  };
  const lines = [header];
  for (let i = 0; i < rec.result.n; i++) {
    const b = rec.result.blocks[blockOf[i]];
    lines.push(
      [i, fmt(observations[i]), fmt(weights[i]), fmt(rec.result.fit[i]), fmt(rec.result.residuals[i]), blockOf[i], b.start, b.end].join(','),
    );
  }
  lines.push(`# weightedSSE=${fmt(rec.result.weightedSSE)}`);
  return lines.join('\n');
}
