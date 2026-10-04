import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './db.js';
import { toCSVExport, toJSONExport } from './exporters.js';
import { startServer } from './server.js';
import { validateDirection, validateSeries } from './validation.js';

interface Args {
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags.set(key, 'true');
      } else {
        flags.set(key, next);
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function parseNumberList(raw: string | undefined, label: string): number[] {
  if (raw === undefined) throw new Error(`缺少 --${label}`);
  let arr: unknown;
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      arr = JSON.parse(raw);
    } catch (err) {
      throw new Error(`--${label} JSON 数组解析失败: ${(err as Error).message}`);
    }
  } else {
    // CLI 显式逗号分隔语法：用户显式声明按数字解析，非 JSON 字段隐式转数
    arr = raw.split(',').map((s) => Number(s.trim()));
    if ((arr as number[]).some((v) => !Number.isFinite(v))) {
      throw new Error(`--${label} 包含无法解析为有限数值的项`);
    }
  }
  if (!Array.isArray(arr)) throw new Error(`--${label} 必须是 JSON 数组或逗号分隔列表`);
  return arr as number[];
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '-h' || command === '--help') {
    console.log(`加权保序回归（PAVA）后端 CLI

用法:
  cli serve [--port 8080] [--db ./data/app.sqlite]   启动 HTTP API（默认空闲端口）
  cli import --y "3,1,2" [--w "1,1,1"] [--name 示例] [--db ...]
  cli list [--db ...]
  cli get <seqId> [--db ...]
  cli point <seqId> <index> [--db ...]
  cli add-version <seqId> --w "2,1,1" [--note 说明] [--db ...]
  cli fit <versionId> <nondecreasing|nonincreasing> [--max-events 10000] [--db ...]
  cli blocks <versionId> <direction> [--db ...]
  cli events <versionId> <direction> [--db ...]
  cli point-fit <versionId> <direction> <index> [--db ...]
  cli compare <seqId> <v1> <v2> <direction> [--db ...]
  cli export <versionId> <direction> <json|csv> [--out file] [--db ...]
`);
    return;
  }

  const args = parseArgs(rest);
  const dbPath = resolve(args.flags.get('db') ?? 'data/app.sqlite');

  if (command === 'serve') {
    const port = Number(args.flags.get('port') ?? '0');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port 必须为 0-65535 的整数（0 表示自动选择空闲端口）');
    const store = new Store(dbPath);
    const started = await startServer(store, port);
    console.log(`HTTP API 已启动: http://127.0.0.1:${started.port}  (数据库 ${dbPath})`);
    process.on('SIGINT', () => {
      started.close();
      store.close();
      process.exit(0);
    });
    return;
  }

  const store = new Store(dbPath);
  try {
    switch (command) {
      case 'import': {
        const y = parseNumberList(args.flags.get('y'), 'y');
        const wRaw = args.flags.get('w');
        const { values, weights } = validateSeries(y, wRaw === undefined ? undefined : parseNumberList(wRaw, 'w'));
        const name = args.flags.get('name') ?? '未命名序列';
        print(store.importSequence(name, values, weights));
        break;
      }
      case 'list':
        print(store.listSequences());
        break;
      case 'get':
        print({
          sequence: store.getSequence(args.positional[0]),
          observations: store.getObservations(args.positional[0]),
          versions: store.listVersions(args.positional[0]),
        });
        break;
      case 'point': {
        const [seqId, indexRaw] = args.positional;
        const index = Number(indexRaw);
        if (!Number.isInteger(index)) throw new Error('index 必须为整数');
        print(store.getPoint(seqId, index));
        break;
      }
      case 'add-version': {
        const seqId = args.positional[0];
        const meta = store.getSequence(seqId);
        const { weights } = validateSeries(new Array(meta.n).fill(0), parseNumberList(args.flags.get('w'), 'w'));
        print(store.addWeightVersion(seqId, weights, args.flags.get('note') ?? ''));
        break;
      }
      case 'fit': {
        const [versionId, dir] = args.positional;
        const maxEvents = args.flags.get('max-events');
        print(store.fitVersion(versionId, validateDirection(dir), {
          maxEvents: maxEvents === undefined ? undefined : Number(maxEvents),
        }));
        break;
      }
      case 'blocks': {
        const [versionId, dir] = args.positional;
        print(store.getFit(versionId, validateDirection(dir)).result.blocks);
        break;
      }
      case 'events': {
        const [versionId, dir] = args.positional;
        const r = store.getFit(versionId, validateDirection(dir)).result;
        print({ totalMerges: r.totalMerges, eventsTruncated: r.eventsTruncated, mergeEvents: r.mergeEvents });
        break;
      }
      case 'point-fit': {
        const [versionId, dir, indexRaw] = args.positional;
        const direction = validateDirection(dir);
        const rec = store.getFit(versionId, direction);
        const index = Number(indexRaw);
        if (!Number.isInteger(index) || index < 0 || index >= rec.result.n) throw new Error('index 越界');
        let blockIndex = -1;
        rec.result.blocks.forEach((b, bi) => {
          if (index >= b.start && index <= b.end) blockIndex = bi;
        });
        print({ index, fit: rec.result.fit[index], residual: rec.result.residuals[index], blockIndex });
        break;
      }
      case 'compare': {
        const [seqId, v1, v2, dir] = args.positional;
        print(store.compareVersions(seqId, v1, v2, validateDirection(dir)));
        break;
      }
      case 'export': {
        const [versionId, dir, fmtRaw] = args.positional;
        const rec = store.getFit(versionId, validateDirection(dir));
        const version = store.getVersion(versionId);
        const observations = store.getObservations(version.sequenceId).map((o) => o.y);
        const fmt = fmtRaw === 'csv' ? 'csv' : 'json';
        const content = fmt === 'csv' ? toCSVExport(rec, observations, version.weights) : toJSONExport(rec);
        const out = args.flags.get('out');
        if (out) {
          writeFileSync(resolve(out), content, 'utf8');
          console.log(`已导出到 ${out}`);
        } else {
          console.log(content);
        }
        break;
      }
      default:
        throw new Error(`未知命令: ${command}`);
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  const code = 'code' in err ? String(err.code) : 'ERROR';
  console.error(`[${code}] ${err.message}`);
  process.exit(1);
});
