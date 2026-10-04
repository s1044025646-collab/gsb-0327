import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Direction, FitResult } from "./pava.js";

export interface RunRow {
  id: number;
  direction: Direction;
  algorithmVersion: string;
  y: number[];
  w: number[];
  fitted: number[];
  residuals: number[];
  sse: number;
  blocks: FitResult["blocks"];
  merges: FitResult["merges"];
  mergeCount: number;
  traceTruncated: boolean;
  createdAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        direction TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        y_json TEXT NOT NULL,
        w_json TEXT NOT NULL,
        fitted_json TEXT NOT NULL,
        residuals_json TEXT NOT NULL,
        sse REAL NOT NULL,
        blocks_json TEXT NOT NULL,
        merges_json TEXT NOT NULL,
        merge_count INTEGER NOT NULL,
        trace_truncated INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  saveRun(y: number[], w: number[], direction: Direction, r: FitResult): number {
    // 原子保存: 原始输入与结果在同一事务中写入, 失败则整体回滚
    this.db.exec("BEGIN");
    try {
      const stmt = this.db.prepare(`
        INSERT INTO runs (direction, algorithm_version, y_json, w_json, fitted_json, residuals_json, sse, blocks_json, merges_json, merge_count, trace_truncated, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const info = stmt.run(
        direction,
        r.algorithmVersion,
        JSON.stringify(y),
        JSON.stringify(w),
        JSON.stringify(r.fitted),
        JSON.stringify(r.residuals),
        r.sse,
        JSON.stringify(r.blocks),
        JSON.stringify(r.merges),
        r.mergeCount,
        r.traceTruncated ? 1 : 0,
        new Date().toISOString()
      );
      this.db.exec("COMMIT");
      return Number(info.lastInsertRowid);
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  getRun(id: number): RunRow | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as number,
      direction: row.direction as Direction,
      algorithmVersion: row.algorithm_version as string,
      y: JSON.parse(row.y_json as string),
      w: JSON.parse(row.w_json as string),
      fitted: JSON.parse(row.fitted_json as string),
      residuals: JSON.parse(row.residuals_json as string),
      sse: row.sse as number,
      blocks: JSON.parse(row.blocks_json as string),
      merges: JSON.parse(row.merges_json as string),
      mergeCount: row.merge_count as number,
      traceTruncated: (row.trace_truncated as number) === 1,
      createdAt: row.created_at as string,
    };
  }

  listRuns(): Array<{ id: number; direction: string; n: number; sse: number; algorithmVersion: string; createdAt: string }> {
    const rows = this.db.prepare("SELECT id, direction, y_json, sse, algorithm_version, created_at FROM runs ORDER BY id").all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      direction: r.direction as string,
      n: (JSON.parse(r.y_json as string) as unknown[]).length,
      sse: r.sse as number,
      algorithmVersion: r.algorithm_version as string,
      createdAt: r.created_at as string,
    }));
  }

  close(): void {
    this.db.close();
  }
}
