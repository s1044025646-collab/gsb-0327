import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { AppError, type ErrorCode } from './errors.js';
import { Store } from './db.js';
import { toCSVExport, toJSONExport } from './exporters.js';
import { validateDirection, validateIndex, validateSeries } from './validation.js';

interface ParsedBody {
  y?: unknown;
  w?: unknown;
  direction?: unknown;
  name?: unknown;
  note?: unknown;
  weights?: unknown;
  versionId?: unknown;
  a?: unknown;
  b?: unknown;
  maxEvents?: unknown;
}

async function readJson(req: IncomingMessage): Promise<ParsedBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') throw new AppError('EMPTY_BODY', '请求体为空');
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new AppError('INVALID_JSON', 'JSON 顶层必须为对象');
    }
    return parsed as ParsedBody;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('INVALID_JSON', `JSON 解析失败: ${(err as Error).message}`);
  }
}

function send(res: ServerResponse, status: number, body: unknown, contentType = 'application/json; charset=utf-8'): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(payload);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof AppError) {
    send(res, err.status, { error: { code: err.code as ErrorCode, message: err.message, details: err.details ?? null } });
    return;
  }
  send(res, 500, { error: { code: 'INTERNAL_ERROR', message: (err as Error).message } });
}

export interface StartedServer {
  server: Server;
  port: number;
  close: () => void;
}

export function startServer(store: Store, port = 0): Promise<StartedServer> {
  const server = createServer((req, res) => {
    void handle(store, req, res).catch((err) => sendError(res, err));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = (server.address() as AddressInfo).port;
      resolve({ server, port: actual, close: () => server.close() });
    });
  });
}

async function handle(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const p = url.pathname;
  const method = req.method ?? 'GET';

  // 健康检查 / 限制说明
  if (method === 'GET' && p === '/api/health') {
    send(res, 200, { ok: true, limits: { maxLength: 100_000, maxAbsValue: 1e12, maxWeight: 1e9 } });
    return;
  }

  // 导入序列
  if (method === 'POST' && p === '/api/sequences') {
    const body = await readJson(req);
    const { values, weights } = validateSeries(body.y, body.w);
    const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name : '未命名序列';
    const created = store.importSequence(name, values, weights);
    send(res, 201, created);
    return;
  }

  const seqMatch = p.match(/^\/api\/sequences\/([^/]+)(?:\/(.*))?$/);
  if (method === 'GET' && p === '/api/sequences') {
    send(res, 200, { sequences: store.listSequences() });
    return;
  }
  if (seqMatch) {
    const seqId = decodeURIComponent(seqMatch[1]);
    const sub = seqMatch[2] ?? '';

    if (method === 'GET' && sub === '') {
      const meta = store.getSequence(seqId);
      send(res, 200, { sequence: meta, observations: store.getObservations(seqId), versions: store.listVersions(seqId) });
      return;
    }
    if (method === 'GET' && sub.startsWith('points/')) {
      const index = validateIndex(decodeURIComponent(sub.slice('points/'.length)), store.getSequence(seqId).n);
      const point = store.getPoint(seqId, index);
      send(res, 200, point);
      return;
    }
    if (method === 'POST' && sub === 'versions') {
      const body = await readJson(req);
      const meta = store.getSequence(seqId);
      const { weights } = validateSeries(new Array(meta.n).fill(0), body.weights);
      const note = typeof body.note === 'string' ? body.note : '';
      send(res, 201, store.addWeightVersion(seqId, weights, note));
      return;
    }
    if (method === 'GET' && sub === 'versions') {
      send(res, 200, { versions: store.listVersions(seqId) });
      return;
    }
    if (method === 'GET' && sub === 'compare') {
      const direction = validateDirection(url.searchParams.get('direction'));
      const a = url.searchParams.get('a');
      const b = url.searchParams.get('b');
      if (!a || !b) throw new AppError('VALIDATION_ERROR', '比较需要 a 与 b 两个版本 id 查询参数');
      send(res, 200, store.compareVersions(seqId, a, b, direction));
      return;
    }
  }

  const fitMatch = p.match(/^\/api\/versions\/([^/]+)\/fit\/([^/]+)(?:\/(export|events|blocks|point))?$/);
  if (fitMatch) {
    const versionId = decodeURIComponent(fitMatch[1]);
    const direction = validateDirection(fitMatch[2]);
    const part = fitMatch[3];

    if (method === 'POST' && !part) {
      const body = await readJson(req);
      const maxEvents = body.maxEvents as unknown;
      if (maxEvents !== undefined && (typeof maxEvents !== 'number' || !Number.isInteger(maxEvents) || maxEvents < 0)) {
        throw new AppError('VALIDATION_ERROR', 'maxEvents 必须为非负整数');
      }
      send(res, 200, store.fitVersion(versionId, direction, { maxEvents: maxEvents as number | undefined }));
      return;
    }
    if (method === 'GET') {
      const rec = store.getFit(versionId, direction);
      const version = store.getVersion(versionId);
      if (part === 'blocks') {
        send(res, 200, { blocks: rec.result.blocks });
        return;
      }
      if (part === 'events') {
        send(res, 200, {
          totalMerges: rec.result.totalMerges,
          eventsTruncated: rec.result.eventsTruncated,
          mergeEvents: rec.result.mergeEvents,
        });
        return;
      }
      if (part === 'point') {
        const index = validateIndex(url.searchParams.get('index'), rec.result.n);
        let blockIndex = -1;
        rec.result.blocks.forEach((b, bi) => {
          if (index >= b.start && index <= b.end) blockIndex = bi;
        });
        send(res, 200, {
          index,
          y: store.getPoint(version.sequenceId, index).y,
          weight: version.weights[index],
          fit: rec.result.fit[index],
          residual: rec.result.residuals[index],
          blockIndex,
          block: rec.result.blocks[blockIndex],
        });
        return;
      }
      if (part === 'export') {
        const fmt = url.searchParams.get('format') === 'csv' ? 'csv' : 'json';
        const observations = store.getObservations(version.sequenceId).map((o) => o.y);
        if (fmt === 'csv') {
          send(res, 200, toCSVExport(rec, observations, version.weights), 'text/csv; charset=utf-8');
        } else {
          send(res, 200, toJSONExport(rec), 'application/json; charset=utf-8');
        }
        return;
      }
      send(res, 200, rec);
      return;
    }
  }

  throw new AppError('NOT_FOUND', `未匹配的路由: ${method} ${p}`);
}
