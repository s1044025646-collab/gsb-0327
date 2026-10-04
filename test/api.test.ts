import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.js';
import { startServer, type StartedServer } from '../src/server.js';

async function call(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  accept = 'application/json',
): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: accept },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, text, json };
}

test('HTTP API 端到端：导入/拟合/单点/块/事件/比较/导出/错误码', async () => {
  const path = join(tmpdir(), `pava-api-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  const store = new Store(path);
  const started: StartedServer = await startServer(store, 0);
  const base = `http://127.0.0.1:${started.port}`;

  try {
    const health = await call(base, 'GET', '/api/health');
    assert.equal(health.status, 200);

    const imported = await call(base, 'POST', '/api/sequences', { name: 'demo', y: [3, 1, 2] });
    assert.equal(imported.status, 201);
    const seqId = imported.json.sequence.id;
    const v1 = imported.json.version.id;

    const fit = await call(base, 'POST', `/api/versions/${v1}/fit/nondecreasing`, {});
    assert.deepEqual(fit.json.result.fit, [2, 2, 2]);

    const point = await call(base, 'GET', `/api/versions/${v1}/fit/nondecreasing/point?index=0`);
    assert.equal(point.json.fit, 2);
    assert.equal(point.json.blockIndex, 0);

    const blocks = await call(base, 'GET', `/api/versions/${v1}/fit/nondecreasing/blocks`);
    assert.equal(blocks.json.blocks[0].end, 2);

    const events = await call(base, 'GET', `/api/versions/${v1}/fit/nondecreasing/events`);
    assert.equal(events.json.totalMerges, 2);

    const seqGet = await call(base, 'GET', `/api/sequences/${seqId}`);
    assert.equal(seqGet.json.observations[2].y, 2);

    const v2 = await call(base, 'POST', `/api/sequences/${seqId}/versions`, { weights: [3, 1, 1], note: 'w' });
    assert.equal(v2.status, 201);
    await call(base, 'POST', `/api/versions/${v2.json.id}/fit/nondecreasing`, {});
    const cmp = await call(base, 'GET', `/api/sequences/${seqId}/compare?direction=nondecreasing&a=${v1}&b=${v2.json.id}`);
    cmp.json.fitDelta.forEach((d: number) => assert.ok(Math.abs(d - 0.4) < 1e-12));

    const jsonExp = await call(base, 'GET', `/api/versions/${v1}/fit/nondecreasing/export?format=json`);
    assert.equal(jsonExp.status, 200);
    assert.ok(jsonExp.text.includes('"weightedSSE"'));
    const csvExp = await call(base, 'GET', `/api/versions/${v1}/fit/nondecreasing/export?format=csv`);
    assert.ok(csvExp.text.startsWith('index,y,weight,fit,residual,block,blockStart,blockEnd'));

    // 错误码
    const badWeight = await call(base, 'POST', '/api/sequences', { y: [1, 2], w: [1, -1] });
    assert.equal(badWeight.status, 400);
    assert.equal(badWeight.json.error.code, 'VALIDATION_ERROR');
    const nullY = await call(base, 'POST', '/api/sequences', { y: [1, null] });
    assert.equal(nullY.json.error.code, 'VALIDATION_ERROR');
    const badDir = await call(base, 'POST', `/api/versions/${v1}/fit/up`, {});
    assert.equal(badDir.status, 400);
    const notFound = await call(base, 'GET', '/api/sequences/nope');
    assert.equal(notFound.status, 404);
    const empty = await call(base, 'POST', '/api/sequences');
    assert.equal(empty.json.error.code, 'EMPTY_BODY');
  } finally {
    started.close();
    store.close();
    rmSync(path, { force: true });
  }
});
