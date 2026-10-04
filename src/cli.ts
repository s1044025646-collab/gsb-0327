import { fitIsotonic, Direction } from "./pava.js";
import { parseDirection, parseSequence, parseWeights } from "./validate.js";
import { Store, RunRow } from "./store.js";
import { startServer } from "./server.js";

const DB_PATH = process.env.ISO_DB ?? "data/isotonic.db";

function parseNums(s: string): number[] {
  if (!s.trim()) return [];
  return s.split(",").map((t) => {
    const v = Number(t);
    if (!Number.isFinite(v)) throw new Error(`无法解析数值: "${t}"`);
    return v;
  });
}

function blockOf(blocks: RunRow["blocks"], n: number): number[] {
  const b = new Array<number>(n);
  blocks.forEach((blk, k) => { for (let i = blk.start; i < blk.end; i++) b[i] = k; });
  return b;
}

function printTable(y: number[], w: number[], fitted: number[], blocks: RunRow["blocks"]): void {
  const bid = blockOf(blocks, y.length);
  console.log("index\ty\tw\tfitted\tblock");
  for (let i = 0; i < y.length; i++) {
    console.log(`${i}\t${y[i]}\t${w[i]}\t${fitted[i]}\t${bid[i]}`);
  }
}

function printBlocks(blocks: RunRow["blocks"]): void {
  console.log("block\trange\t\tweightSum\tvalueSum\tmean");
  blocks.forEach((b, k) => {
    console.log(`${k}\t[${b.start}, ${b.end})\t\t${b.weightSum}\t\t${b.valueSum}\t\t${b.mean}`);
  });
}

function printMerges(row: RunRow): void {
  console.log(`合并次数: ${row.mergeCount}${row.traceTruncated ? " (解释记录已限量截断)" : ""}`);
  for (const m of row.merges) {
    console.log(`step ${m.step}: [${m.leftBlock.start},${m.leftBlock.end}) mean=${m.leftBlock.mean} 与 [${m.rightBlock.start},${m.rightBlock.end}) mean=${m.rightBlock.mean} -> [${m.merged.start},${m.merged.end}) mean=${m.merged.mean} 受影响下标=[${m.affectedIndices.join(",")}]`);
  }
}

function help(): void {
  console.log(`用法: node dist/src/cli.js <命令> [参数]
命令:
  fit --y 3,1,2 [--w 1,1,1] [--dir increasing|decreasing]   拟合并保存为新版本
  list                                                     列出所有运行
  show <id>                                                显示完整报告
  point <id> <i>                                           查询单点
  blocks <id>                                              查询常值块
  merges <id>                                              查看合并过程
  compare --y 3,1,2 --wA 1,1,1 --wB 5,1,1 [--dir ...]      比较两个权重版本
  export <id> [--format json|csv]                          导出报告
  demo                                                     运行演示
  serve [--port N]                                         启动 HTTP 服务`);
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const store = new Store(DB_PATH);
  try {
    switch (cmd) {
      case "fit": {
        const y = parseSequence(parseNums(argValue(rest, "--y") ?? ""), "y");
        const wRaw = argValue(rest, "--w");
        const w = parseWeights(wRaw === undefined ? undefined : parseNums(wRaw), y.length);
        const direction = parseDirection(argValue(rest, "--dir") ?? "increasing");
        const r = fitIsotonic(y, w, direction);
        const id = store.saveRun(y, w, direction, r);
        console.log(`运行 ${id} 已保存 (方向=${direction}, SSE=${r.sse}, 合并=${r.mergeCount} 次)`);
        printTable(y, w, r.fitted, r.blocks);
        printBlocks(r.blocks);
        break;
      }
      case "list": {
        for (const r of store.listRuns()) console.log(`#${r.id} dir=${r.direction} n=${r.n} sse=${r.sse} algo=${r.algorithmVersion} at=${r.createdAt}`);
        break;
      }
      case "show": {
        const row = mustGet(store, Number(rest[0]));
        printTable(row.y, row.w, row.fitted, row.blocks);
        console.log(`SSE=${row.sse} 方向=${row.direction} 算法版本=${row.algorithmVersion}`);
        printBlocks(row.blocks);
        break;
      }
      case "point": {
        const row = mustGet(store, Number(rest[0]));
        const i = Number(rest[1]);
        if (!(i >= 0 && i < row.y.length)) throw new Error(`下标 ${rest[1]} 越界`);
        console.log(`index=${i} y=${row.y[i]} w=${row.w[i]} fitted=${row.fitted[i]} residual=${row.residuals[i]}`);
        break;
      }
      case "blocks": {
        printBlocks(mustGet(store, Number(rest[0])).blocks);
        break;
      }
      case "merges": {
        printMerges(mustGet(store, Number(rest[0])));
        break;
      }
      case "compare": {
        const y = parseSequence(parseNums(argValue(rest, "--y") ?? ""), "y");
        const direction = parseDirection(argValue(rest, "--dir") ?? "increasing");
        const wA = parseWeights(parseNums(argValue(rest, "--wA") ?? ""), y.length);
        const wB = parseWeights(parseNums(argValue(rest, "--wB") ?? ""), y.length);
        const a = fitIsotonic(y, wA, direction);
        const b = fitIsotonic(y, wB, direction);
        console.log("版本A:"); printTable(y, wA, a.fitted, a.blocks); console.log(`SSE_A=${a.sse}`);
        console.log("版本B:"); printTable(y, wB, b.fitted, b.blocks); console.log(`SSE_B=${b.sse}`);
        break;
      }
      case "export": {
        const row = mustGet(store, Number(rest[0]));
        const format = argValue(rest, "--format") ?? "json";
        if (format === "json") {
          console.log(JSON.stringify(row, null, 2));
        } else if (format === "csv") {
          const bid = blockOf(row.blocks, row.y.length);
          console.log("index,y,w,fitted,residual,block");
          for (let i = 0; i < row.y.length; i++) console.log(`${i},${row.y[i]},${row.w[i]},${row.fitted[i]},${row.residuals[i]},${bid[i]}`);
        } else {
          throw new Error(`不支持的导出格式: ${format}`);
        }
        break;
      }
      case "demo": {
        runDemo(store);
        break;
      }
      case "serve": {
        const portArg = argValue(rest, "--port");
        const { port } = await startServer(DB_PATH, portArg ? Number(portArg) : undefined);
        console.log(`保序回归服务已启动: http://localhost:${port}`);
        return; // 不关闭 store
      }
      default:
        help();
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

function mustGet(store: Store, id: number): RunRow {
  const row = store.getRun(id);
  if (!row) throw new Error(`运行 ${id} 不存在`);
  return row;
}

function runDemo(store: Store): void {
  console.log("== 演示 1: y=3,1,2 等权, 非递减方向 (向前合并) ==");
  const y = [3, 1, 2];
  const w = [1, 1, 1];
  const r1 = fitIsotonic(y, w, "increasing");
  const id1 = store.saveRun(y, w, "increasing", r1);
  printTable(y, w, r1.fitted, r1.blocks);
  printBlocks(r1.blocks);
  printMerges(mustGet(store, id1));
  console.log(`SSE=${r1.sse} (运行 #${id1})`);

  console.log("\n== 演示 2: 首点权重改为 5, 观察块均值变化 ==");
  const w2 = [5, 1, 1];
  const r2 = fitIsotonic(y, w2, "increasing");
  const id2 = store.saveRun(y, w2, "increasing", r2);
  printTable(y, w2, r2.fitted, r2.blocks);
  printBlocks(r2.blocks);
  console.log(`SSE=${r2.sse} (运行 #${id2}, 与 #${id1} 为不同版本, 旧报告不受影响)`);

  console.log("\n== 演示 3: 已单调序列 y=1,2,3 保持不变 ==");
  const y3 = [1, 2, 3];
  const r3 = fitIsotonic(y3, [1, 1, 1], "increasing");
  printTable(y3, [1, 1, 1], r3.fitted, r3.blocks);
  console.log(`SSE=${r3.sse} 合并次数=${r3.mergeCount}`);

  console.log("\n== 演示 4: 两种方向产生不同结果 (y=3,1,2) ==");
  const rInc = fitIsotonic(y, [1, 1, 1], "increasing");
  const rDec = fitIsotonic(y, [1, 1, 1], "decreasing");
  console.log(`非递减 fitted=[${rInc.fitted.join(",")}] SSE=${rInc.sse}`);
  console.log(`非递增 fitted=[${rDec.fitted.join(",")}] SSE=${rDec.sse}`);
}

main().catch((e) => { console.error(`错误: ${e.message}`); process.exit(1); });
