import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { fitIsotonic, IsoError, LIMITS, ALGORITHM_VERSION, Direction } from "./pava.js";
import { parseDirection, parseSequence, parseWeights } from "./validate.js";
import { Store, RunRow } from "./store.js";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new IsoError("INVALID_INPUT", "请求体不是合法 JSON");
  }
}

function runReport(row: RunRow) {
  return {
    id: row.id,
    direction: row.direction,
    algorithmVersion: row.algorithmVersion,
    n: row.y.length,
    y: row.y,
    w: row.w,
    fitted: row.fitted,
    residuals: row.residuals,
    sse: row.sse,
    blocks: row.blocks,
    mergeCount: row.mergeCount,
    traceTruncated: row.traceTruncated,
    createdAt: row.createdAt,
  };
}

function runCsv(row: RunRow): string {
  const blockOf = new Array<number>(row.y.length);
  row.blocks.forEach((b, k) => { for (let i = b.start; i < b.end; i++) blockOf[i] = k; });
  const lines = ["index,y,w,fitted,residual,block"];
  for (let i = 0; i < row.y.length; i++) {
    lines.push(`${i},${row.y[i]},${row.w[i]},${row.fitted[i]},${row.residuals[i]},${blockOf[i]}`);
  }
  return lines.join("\r\n") + "\r\n";
}

export function createApp(store: Store) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    try {
      if (method === "GET" && path === "/health") {
        return sendJson(res, 200, { ok: true, algorithmVersion: ALGORITHM_VERSION });
      }
      if (method === "GET" && path === "/limits") {
        return sendJson(res, 200, { limits: LIMITS, algorithmVersion: ALGORITHM_VERSION });
      }
      if (method === "POST" && path === "/runs") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const y = parseSequence(body.y, "y");
        const w = parseWeights(body.w, y.length);
        const direction = parseDirection(body.direction ?? "increasing");
        const result = fitIsotonic(y, w, direction);
        const id = store.saveRun(y, w, direction, result);
        const row = store.getRun(id)!;
        return sendJson(res, 201, runReport(row));
      }
      if (method === "GET" && path === "/runs") {
        return sendJson(res, 200, { runs: store.listRuns() });
      }
      const runMatch = path.match(/^\/runs\/(\d+)(\/.*)?$/);
      if (method === "GET" && runMatch) {
        const id = Number(runMatch[1]);
        const row = store.getRun(id);
        if (!row) return sendError(res, 404, "NOT_FOUND", `运行 ${id} 不存在`);
        const sub = runMatch[2] ?? "";
        if (sub === "") return sendJson(res, 200, runReport(row));
        if (sub === "/blocks") return sendJson(res, 200, { id, blocks: row.blocks });
        const blockMatch = sub.match(/^\/blocks\/(\d+)$/);
        if (blockMatch) {
          const k = Number(blockMatch[1]);
          const b = row.blocks[k];
          if (!b) return sendError(res, 404, "NOT_FOUND", `块 ${k} 不存在`);
          return sendJson(res, 200, { id, index: k, block: b });
        }
        const pointMatch = sub.match(/^\/points\/(\d+)$/);
        if (pointMatch) {
          const i = Number(pointMatch[1]);
          if (i >= row.y.length) return sendError(res, 404, "NOT_FOUND", `下标 ${i} 越界`);
          return sendJson(res, 200, { id, index: i, y: row.y[i], w: row.w[i], fitted: row.fitted[i], residual: row.residuals[i] });
        }
        if (sub === "/merges") return sendJson(res, 200, { id, mergeCount: row.mergeCount, traceTruncated: row.traceTruncated, merges: row.merges });
        if (sub === "/export") {
          const format = url.searchParams.get("format") ?? "json";
          if (format === "json") return sendJson(res, 200, runReport(row));
          if (format === "csv") {
            res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" });
            return res.end(runCsv(row));
          }
          return sendError(res, 400, "INVALID_INPUT", `不支持的导出格式: ${format}`);
        }
        return sendError(res, 404, "NOT_FOUND", `未知路径 ${path}`);
      }
      if (method === "POST" && path === "/compare") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const y = parseSequence(body.y, "y");
        const direction = parseDirection(body.direction ?? "increasing");
        const wA = parseWeights(body.wA, y.length);
        const wB = parseWeights(body.wB, y.length);
        const a = fitIsotonic(y, wA, direction);
        const b = fitIsotonic(y, wB, direction);
        return sendJson(res, 200, {
          direction,
          versionA: { w: wA, fitted: a.fitted, sse: a.sse, blocks: a.blocks },
          versionB: { w: wB, fitted: b.fitted, sse: b.sse, blocks: b.blocks },
        });
      }
      return sendError(res, 404, "NOT_FOUND", `未知路径 ${method} ${path}`);
    } catch (e) {
      if (e instanceof IsoError) return sendError(res, 400, e.code, e.message);
      return sendError(res, 500, "INTERNAL", (e as Error).message);
    }
  });
  return server;
}

export async function startServer(dbPath: string, preferredPort?: number): Promise<{ port: number; close: () => void }> {
  const store = new Store(dbPath);
  const server = createApp(store);
  const tryListen = (port: number): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, () => resolve((server.address() as AddressInfo).port));
    });
  let port: number;
  if (preferredPort) {
    try {
      port = await tryListen(preferredPort);
    } catch {
      port = await tryListen(0); // 默认选择空闲端口
    }
  } else {
    port = await tryListen(0);
  }
  return { port, close: () => { server.close(); store.close(); } };
}

if (process.argv[1] && process.argv[1].endsWith("server.js") || process.argv[1].endsWith("server.ts")) {
  const dbPath = process.env.ISO_DB ?? "data/isotonic.db";
  const preferred = process.env.PORT ? Number(process.env.PORT) : undefined;
  const { port } = await startServer(dbPath, preferred);
  console.log(`保序回归服务已启动: http://localhost:${port} (数据库: ${dbPath})`);
}

