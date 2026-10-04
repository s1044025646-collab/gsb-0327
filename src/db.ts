import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AppError } from './errors.js';
import { fitIsotonic } from './pava.js';
import { ALGORITHM_VERSION, type Direction, type FitResult } from './types.js';

export interface SequenceMeta {
  id: string;
  name: string;
  n: number;
  createdAt: string;
}

export interface VersionMeta {
  id: string;
  sequenceId: string;
  versionNo: number;
  note: string;
  createdAt: string;
  weights: number[];
}

export interface FitRecord {
  versionId: string;
  direction: Direction;
  algorithmVersion: string;
  result: FitResult;
  createdAt: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sequences (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        n INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS observations (
        seq_id TEXT NOT NULL,
        pos INTEGER NOT NULL,
        y REAL NOT NULL,
        PRIMARY KEY (seq_id, pos),
        FOREIGN KEY (seq_id) REFERENCES sequences(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS weight_versions (
        id TEXT PRIMARY KEY,
        seq_id TEXT NOT NULL,
        version_no INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE (seq_id, version_no),
        FOREIGN KEY (seq_id) REFERENCES sequences(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS weights (
        version_id TEXT NOT NULL,
        pos INTEGER NOT NULL,
        w REAL NOT NULL,
        PRIMARY KEY (version_id, pos),
        FOREIGN KEY (version_id) REFERENCES weight_versions(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS fits (
        version_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('nondecreasing','nonincreasing')),
        algorithm_version TEXT NOT NULL,
        n INTEGER NOT NULL,
        weighted_sse REAL NOT NULL,
        total_merges INTEGER NOT NULL,
        events_truncated INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (version_id, direction),
        FOREIGN KEY (version_id) REFERENCES weight_versions(id) ON DELETE CASCADE
      );
    `);
  }

  /** 导入序列：原子写入序列头、冻结的观测（原始顺序）与 v1 权重。 */
  importSequence(name: string, values: number[], weights: number[]): { sequence: SequenceMeta; version: VersionMeta } {
    const seqId = randomUUID();
    const versionId = randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO sequences (id, name, n, created_at) VALUES (?, ?, ?, ?)')
        .run(seqId, name, values.length, now);
      const insObs = this.db.prepare('INSERT INTO observations (seq_id, pos, y) VALUES (?, ?, ?)');
      for (let i = 0; i < values.length; i++) insObs.run(seqId, i, values[i]);
      this.db
        .prepare('INSERT INTO weight_versions (id, seq_id, version_no, note, created_at) VALUES (?, ?, 1, ?, ?)')
        .run(versionId, seqId, '初始权重版本', now);
      const insW = this.db.prepare('INSERT INTO weights (version_id, pos, w) VALUES (?, ?, ?)');
      for (let i = 0; i < weights.length; i++) insW.run(versionId, i, weights[i]);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return {
      sequence: { id: seqId, name, n: values.length, createdAt: now },
      version: { id: versionId, sequenceId: seqId, versionNo: 1, note: '初始权重版本', createdAt: now, weights },
    };
  }

  getSequence(seqId: string): SequenceMeta {
    const row = this.db.prepare('SELECT id, name, n, created_at AS createdAt FROM sequences WHERE id = ?').get(seqId) as
      | SequenceMeta
      | undefined;
    if (!row) throw new AppError('NOT_FOUND', `序列 ${seqId} 不存在`);
    return row;
  }

  listSequences(): SequenceMeta[] {
    return this.db
      .prepare('SELECT id, name, n, created_at AS createdAt FROM sequences ORDER BY created_at, id')
      .all() as unknown as SequenceMeta[];
  }

  getObservations(seqId: string): { pos: number; y: number }[] {
    this.getSequence(seqId);
    return this.db
      .prepare('SELECT pos, y FROM observations WHERE seq_id = ? ORDER BY pos')
      .all(seqId) as { pos: number; y: number }[];
  }

  getPoint(seqId: string, pos: number): { pos: number; y: number } {
    this.getSequence(seqId);
    const row = this.db
      .prepare('SELECT pos, y FROM observations WHERE seq_id = ? AND pos = ?')
      .get(seqId, pos) as { pos: number; y: number } | undefined;
    if (!row) throw new AppError('NOT_FOUND', `序列 ${seqId} 不存在下标 ${pos}`);
    return row;
  }

  listVersions(seqId: string): VersionMeta[] {
    this.getSequence(seqId);
    const rows = this.db
      .prepare('SELECT id, seq_id AS sequenceId, version_no AS versionNo, note, created_at AS createdAt FROM weight_versions WHERE seq_id = ? ORDER BY version_no')
      .all(seqId) as Omit<VersionMeta, 'weights'>[];
    return rows.map((r) => ({ ...r, weights: this.readWeights(r.id) }));
  }

  getVersion(versionId: string): VersionMeta {
    const row = this.db
      .prepare('SELECT id, seq_id AS sequenceId, version_no AS versionNo, note, created_at AS createdAt FROM weight_versions WHERE id = ?')
      .get(versionId) as Omit<VersionMeta, 'weights'> | undefined;
    if (!row) throw new AppError('NOT_FOUND', `权重版本 ${versionId} 不存在`);
    return { ...row, weights: this.readWeights(versionId) };
  }

  private readWeights(versionId: string): number[] {
    const rows = this.db
      .prepare('SELECT w FROM weights WHERE version_id = ? ORDER BY pos')
      .all(versionId) as { w: number }[];
    return rows.map((r) => r.w);
  }

  /**
   * 基于同一序列的冻结观测创建新权重版本。
   * 只冻结权重，不触发任何既有报告重算。
   */
  addWeightVersion(seqId: string, weights: number[], note: string): VersionMeta {
    const seq = this.getSequence(seqId);
    if (weights.length !== seq.n) {
      throw new AppError('VALIDATION_ERROR', `权重长度 ${weights.length} 与序列长度 ${seq.n} 不一致`);
    }
    const maxRow = this.db
      .prepare('SELECT COALESCE(MAX(version_no), 0) AS m FROM weight_versions WHERE seq_id = ?')
      .get(seqId) as { m: number };
    const versionId = randomUUID();
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('INSERT INTO weight_versions (id, seq_id, version_no, note, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(versionId, seqId, maxRow.m + 1, note, now);
      const insW = this.db.prepare('INSERT INTO weights (version_id, pos, w) VALUES (?, ?, ?)');
      for (let i = 0; i < weights.length; i++) insW.run(versionId, i, weights[i]);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { id: versionId, sequenceId: seqId, versionNo: maxRow.m + 1, note, createdAt: now, weights };
  }

  /**
   * 执行拟合并原子保存：同一事务内完成算法结果、解释记录与摘要落盘。
   * 算法抛错（含溢出/校验失败）时事务回滚，不会留下“成功但没有完整拟合值”的记录。
   * 已存在的报告保持冻结，重复拟合返回既有结果（幂等，不悄悄重算）。
   */
  fitVersion(versionId: string, direction: Direction, opts?: { force?: boolean; maxEvents?: number }): FitRecord {
    if (direction !== 'nondecreasing' && direction !== 'nonincreasing') {
      throw new AppError(
        'VALIDATION_ERROR',
        `非法方向: ${JSON.stringify(direction)}，必须为 "nondecreasing" 或 "nonincreasing"`,
      );
    }
    const version = this.getVersion(versionId);
    const existing = this.findFit(versionId, direction);
    if (existing && !opts?.force) return existing;

    const obs = this.getObservations(version.sequenceId);
    const y = obs.map((o) => o.y);
    const result = fitIsotonic(y, version.weights, direction, opts?.maxEvents ?? 10_000);
    const now = new Date().toISOString();
    const json = JSON.stringify(result);
    if (json.includes('null')) {
      throw new AppError('INTERNAL_ERROR', '序列化结果中出现 null，拒绝保存（null 不是合法拟合值）');
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO fits (version_id, direction, algorithm_version, n, weighted_sse, total_merges, events_truncated, result_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(version_id, direction) DO UPDATE SET
             algorithm_version = excluded.algorithm_version,
             n = excluded.n,
             weighted_sse = excluded.weighted_sse,
             total_merges = excluded.total_merges,
             events_truncated = excluded.events_truncated,
             result_json = excluded.result_json,
             created_at = excluded.created_at`,
        )
        .run(
          versionId,
          direction,
          ALGORITHM_VERSION,
          result.n,
          result.weightedSSE,
          result.totalMerges,
          result.eventsTruncated ? 1 : 0,
          json,
          now,
        );
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { versionId, direction, algorithmVersion: ALGORITHM_VERSION, result, createdAt: now };
  }

  findFit(versionId: string, direction: string): FitRecord | undefined {
    const row = this.db
      .prepare('SELECT result_json AS resultJson, created_at AS createdAt, algorithm_version AS algorithmVersion FROM fits WHERE version_id = ? AND direction = ?')
      .get(versionId, direction) as { resultJson: string; createdAt: string; algorithmVersion: string } | undefined;
    if (!row) return undefined;
    return {
      versionId,
      direction: direction as Direction,
      algorithmVersion: row.algorithmVersion,
      result: JSON.parse(row.resultJson) as FitResult,
      createdAt: row.createdAt,
    };
  }

  getFit(versionId: string, direction: string): FitRecord {
    const rec = this.findFit(versionId, direction);
    if (!rec) throw new AppError('NOT_FOUND', `版本 ${versionId} 在方向 ${direction} 下尚无拟合报告`);
    return rec;
  }

  /** 比较同一序列两个权重版本的报告（必须均已拟合）。 */
  compareVersions(seqId: string, v1: string, v2: string, direction: Direction): {
    sequenceId: string;
    direction: Direction;
    a: FitRecord;
    b: FitRecord;
    fitDelta: number[];
    weightedSSEDelta: number;
  } {
    this.getSequence(seqId);
    const a = this.requireFitOfSequence(seqId, v1, direction);
    const b = this.requireFitOfSequence(seqId, v2, direction);
    if (a.result.n !== b.result.n) {
      throw new AppError('CONFLICT', '两个版本长度不一致，无法比较');
    }
    const fitDelta = a.result.fit.map((f, i) => b.result.fit[i] - f);
    return {
      sequenceId: seqId,
      direction,
      a,
      b,
      fitDelta,
      weightedSSEDelta: b.result.weightedSSE - a.result.weightedSSE,
    };
  }

  private requireFitOfSequence(seqId: string, versionId: string, direction: Direction): FitRecord {
    const version = this.getVersion(versionId);
    if (version.sequenceId !== seqId) {
      throw new AppError('VALIDATION_ERROR', `版本 ${versionId} 不属于序列 ${seqId}`);
    }
    return this.getFit(versionId, direction);
  }
}
