import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { fitIsotonic } from "../src/pava.js";
import { parseDirection, parseSequence, parseWeights } from "../src/validate.js";

test("校验: 拒绝非有限值/字符串/非法方向/非正权重/长度不一致/null", () => {
  assert.throws(() => parseSequence([1, "2"], "y"), /数字/);
  assert.throws(() => parseSequence([null], "y"), /数字/);
  assert.throws(() => parseSequence([Infinity], "y"), /有限/);
  assert.throws(() => parseDirection("up"), /方向/);
  assert.throws(() => parseWeights([1, 0], 2), /严格为正/);
  assert.throws(() => parseWeights([1, -2], 2), /严格为正/);
  assert.throws(() => parseWeights([1], 2), /不一致/);
  assert.deepEqual(parseWeights(undefined, 3), [1, 1, 1]);
});

test("保存与重启后读取一致", () => {
  const dir = mkdtempSync(join(tmpdir(), "iso-"));
  const db = join(dir, "t.db");
  const y = [3, 1, 2];
  const w = [1, 1, 1];
  const r = fitIsotonic(y, w, "increasing");
  let id: number;
  {
    const s = new Store(db);
    id = s.saveRun(y, w, "increasing", r);
    s.close();
  }
  {
    const s = new Store(db);
    const row = s.getRun(id)!;
    assert.deepEqual(row.y, y);
    assert.deepEqual(row.fitted, r.fitted);
    assert.equal(row.sse, r.sse);
    assert.equal(row.algorithmVersion, r.algorithmVersion);
    s.close();
  }
  rmSync(dir, { recursive: true, force: true });
});

test("改变一个权重创建新版本, 旧报告不被重算", () => {
  const s = new Store(":memory:");
  const y = [3, 1, 2];
  const r1 = fitIsotonic(y, [1, 1, 1], "increasing");
  const id1 = s.saveRun(y, [1, 1, 1], "increasing", r1);
  const r2 = fitIsotonic(y, [5, 1, 1], "increasing");
  const id2 = s.saveRun(y, [5, 1, 1], "increasing", r2);
  assert.notEqual(id1, id2);
  assert.deepEqual(s.getRun(id1)!.fitted, r1.fitted);
  assert.deepEqual(s.getRun(id2)!.fitted, r2.fitted);
  s.close();
});

test("失败操作回滚, 不留下不完整记录", () => {
  const s = new Store(":memory:");
  const y = [3, 1, 2];
  const r = fitIsotonic(y, [1, 1, 1], "increasing");
  // 构造一个会在序列化时失败的结果 (循环引用)
  const bad = { ...r } as Record<string, unknown>; bad.blocks = bad;
  const before = s.listRuns().length;
  assert.throws(() => s.saveRun(y, [1, 1, 1], "increasing", bad as never));
  assert.equal(s.listRuns().length, before);
  // 数据库仍然可用
  const id = s.saveRun(y, [1, 1, 1], "increasing", r);
  assert.ok(s.getRun(id));
  s.close();
});
