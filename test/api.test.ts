import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.js";

let base = "";
let dir = "";
let closeFn: () => void = () => {};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "iso-api-"));
  const { port, close } = await startServer(join(dir, "api.db"));
  base = `http://localhost:${port}`;
  closeFn = close;
});

after(() => {
  closeFn();
  rmSync(dir, { recursive: true, force: true });
});

test("API 全流程: 创建/查询/块/合并/导出/比较", async () => {
  const created = await (await fetch(`${base}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ y: [3, 1, 2], direction: "increasing" }),
  })).json();
  assert.equal(created.fitted.join(","), "2,2,2");
  assert.equal(created.sse, 2);
  const id = created.id;

  const point = await (await fetch(`${base}/runs/${id}/points/1`)).json();
  assert.equal(point.y, 1);
  assert.equal(point.fitted, 2);

  const blocks = await (await fetch(`${base}/runs/${id}/blocks`)).json();
  assert.equal(blocks.blocks.length, 1);

  const merges = await (await fetch(`${base}/runs/${id}/merges`)).json();
  assert.equal(merges.mergeCount, 1);

  const csv = await (await fetch(`${base}/runs/${id}/export?format=csv`)).text();
  assert.match(csv, /index,y,w,fitted,residual,block/);
  assert.match(csv, /0,3,1,2,1,0/);

  const cmp = await (await fetch(`${base}/compare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ y: [3, 1, 2], wA: [1, 1, 1], wB: [5, 1, 1] }),
  })).json();
  assert.notDeepEqual(cmp.versionA.fitted, cmp.versionB.fitted);

  const health = await (await fetch(`${base}/health`)).json();
  assert.ok(health.ok);
});

test("API 错误码: 非法方向/字符串/非正权重/长度不一致/404", async () => {
  const post = (body: unknown) => fetch(`${base}/runs`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  let r = await post({ y: [1, 2], direction: "up" });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, "BAD_DIRECTION");

  r = await post({ y: [1, "2"] });
  assert.equal((await r.json()).error.code, "INVALID_INPUT");

  r = await post({ y: [1, 2], w: [1, 0] });
  assert.equal((await r.json()).error.code, "NON_POSITIVE_WEIGHT");

  r = await post({ y: [1, 2], w: [1] });
  assert.equal((await r.json()).error.code, "LENGTH_MISMATCH");

  r = await post({ y: [null] });
  assert.equal((await r.json()).error.code, "INVALID_INPUT");

  r = await fetch(`${base}/runs/999`);
  assert.equal(r.status, 404);
});
