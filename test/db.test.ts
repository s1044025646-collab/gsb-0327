import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.js';
import { AppError } from '../src/errors.js';

function tempDb(): string {
  return join(tmpdir(), `pava-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
}

test('失败操作回滚，不留下残缺记录', () => {
  const path = tempDb();
  const store = new Store(path);
  const { version } = store.importSequence('t', [3, 1, 2], [1, 1, 1]);

  // 合法拟合成功
  const ok = store.fitVersion(version.id, 'nondecreasing');
  assert.deepEqual(ok.result.fit, [2, 2, 2]);

  // 直接构造非法方向绕过 fitVersion 的正常入口，确认事务中抛错时无残留
  assert.throws(
    () => store.fitVersion(version.id, 'sideways' as never),
    AppError,
  );
  const rows = store.db.prepare('SELECT COUNT(*) AS c FROM fits').get() as { c: number };
  assert.equal(rows.c, 1);

  // 算法前校验失败：数据库内数据被改到超范围，拟合必须整体失败且不留记录
  assert.throws(
    () => {
      const v2 = store.addWeightVersion(version.sequenceId, [1, 1, 1], '触发溢出');
      store.db.prepare('UPDATE observations SET y = ? WHERE seq_id = ? AND pos = 0').run(1e200, version.sequenceId);
      store.fitVersion(v2.id, 'nondecreasing');
    },
    AppError,
  );
  const rows2 = store.db.prepare('SELECT COUNT(*) AS c FROM fits').get() as { c: number };
  assert.equal(rows2.c, 1);

  store.close();
  rmSync(path, { force: true });
});

test('重启后逐点读取原报告且导出内容一致', () => {
  const path = tempDb();
  let store = new Store(path);
  const { sequence, version } = store.importSequence('t', [3, 1, 2], [2, 1, 1]);
  const before = store.fitVersion(version.id, 'nondecreasing');
  store.fitVersion(version.id, 'nonincreasing');
  const snapshot = JSON.stringify(before.result);
  store.close();

  store = new Store(path);
  const after = store.getFit(version.id, 'nondecreasing');
  assert.equal(JSON.stringify(after.result), snapshot);
  assert.equal(store.getPoint(sequence.id, 1).y, 1);
  const point = store.getFit(version.id, 'nondecreasing');
  assert.equal(point.result.fit[0], 2.25); // (6+1+2)/4
  assert.equal(after.algorithmVersion, 'pava-1.0.0');
  store.close();
  rmSync(path, { force: true });
});

test('新权重版本不重算旧报告，compare 给出差异', () => {
  const path = tempDb();
  const store = new Store(path);
  const { sequence, version: v1 } = store.importSequence('t', [3, 1, 2], [1, 1, 1]);
  const first = store.fitVersion(v1.id, 'nondecreasing');
  assert.deepEqual(first.result.fit, [2, 2, 2]);

  const v2 = store.addWeightVersion(sequence.id, [3, 1, 1], '首点加权');
  store.fitVersion(v2.id, 'nondecreasing');

  // 旧报告保持原样
  const oldAgain = store.getFit(v1.id, 'nondecreasing');
  assert.deepEqual(oldAgain.result.fit, [2, 2, 2]);

  const cmp = store.compareVersions(sequence.id, v1.id, v2.id, 'nondecreasing');
  cmp.fitDelta.forEach((d) => assert.ok(Math.abs(d - 0.4) < 1e-12));
  assert.ok(Math.abs(cmp.weightedSSEDelta - 1.2) < 1e-12);

  // 幂等：重复 fit 返回冻结报告
  const repeat = store.fitVersion(v1.id, 'nondecreasing');
  assert.equal(repeat.createdAt, first.createdAt);

  store.close();
  rmSync(path, { force: true });
});

test('空序列与单点序列持久化', () => {
  const path = tempDb();
  const store = new Store(path);
  const { version: empty } = store.importSequence('empty', [], []);
  const r0 = store.fitVersion(empty.id, 'nondecreasing');
  assert.equal(r0.result.weightedSSE, 0);
  assert.deepEqual(r0.result.fit, []);

  const { version: one } = store.importSequence('one', [42], [1]);
  const r1 = store.fitVersion(one.id, 'nonincreasing');
  assert.deepEqual(r1.result.fit, [42]);
  store.close();
  rmSync(path, { force: true });
});
