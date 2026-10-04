# 加权保序回归（PAVA 相邻块合并）后端

使用 TypeScript + Node.js + SQLite 实现的**本地**加权保序回归服务，只提供 HTTP API 与 CLI，无任何前端、Docker、WSL 或在线服务依赖。SQLite 使用 Node.js 内置的 `node:sqlite`（Node ≥ 22.5，开发实测版本 v25.5）。

## 问题定义

给定按外部先后位置排列的一维观测序列 `y[0..n-1]` 与严格正权重 `w[0..n-1]`，求非递减拟合 `f`：

```
minimize  Σ w[i] · (y[i] − f[i])²
s.t.      f[0] ≤ f[1] ≤ … ≤ f[n−1]      (nondecreasing)
          或 f[0] ≥ f[1] ≥ … ≥ f[n−1]   (nonincreasing)
```

顺序是外部给定的位置关系，**不会**按观测值大小重排后再拟合；本服务只处理一维序列，不做分类、直线拟合、变点数量选择，也不输出因果或预测置信结论。

## 算法：PAVA 相邻违规块合并

实现在 `src/pava.ts`，要点：

1. 每个位置初始化为一个单点块，块保存 `start/end`（位置范围）、`weightSum = Σw`、`weightedSum = Σw·y`，块拟合值 `value = weightedSum / weightSum`。
2. 从左到右把新块压入栈；若**前块均值 > 后块均值**（违反非递减），则合并两块。合并后继续向栈顶方向检查，直到不再违规——这就是“向前合并/回退合并”。
3. 合并统计严格按权重累计：`weightSum = w1 + w2`、`weightedSum = s1 + s2`，再相除得新均值。**不是**对两个块均值做简单平均，也**不是**只把后一个值抬高。
4. 非递增方向通过对观测取负号（`z = −y`）复用同一套非递减核心，输出与事件中的均值再乘 `−1` 映射回原方向。
5. 展示规则：算法扫描结束后，相邻拟合值相同的块（浮点容差 `1e-12`）按公开规则合并为“常值块”，同样按权重累计统计并记录解释事件（`kind: "equal-coalesce"`；违规合并为 `kind: "violation"`）。最终常值块恰好覆盖整个序列、互不重叠，每个块都能用其原始观测与权重重新核算 `Σwy / Σw`。

输出包含：完整拟合序列 `fit`、最终常值块 `blocks`、逐点残差 `residuals[i] = y[i] − fit[i]`、总加权平方误差 `weightedSSE`，以及每次合并的解释记录（合并前两块、合并后块、受影响下标、触发位置、方向、算法版本）。解释记录可通过 `maxEvents` 限量（默认 10000），限量只影响返回的记录数并以 `eventsTruncated: true` 标记，**不影响计算**，拟合始终完整完成，未处理后缀不会被当成已拟合。

### 手算示例

- `y=[3,1,2]`，等权，非递减：先合并 `{3},{1} → 均值 2`；新块均值 2 与后点 2 相等，展示合并为一块，最终 `[2,2,2]`，SSE = 1 + 1 + 0 = **2**。
- 改首点权重 `w=[3,1,1]`：加权均值 `(3·3+1·1+1·2)/(3+1+1) = 12/5 = 2.4`，SSE = 3·0.36 + 1.96 + 0.16 = **3.2**。
- `y=[4,1], w=[1,3]`：均值 `7/4=1.75`，SSE = 1·2.25² + 3·(−0.75)² = 5.0625 + 1.6875 = **6.75**。
- 非递增 `y=[3,1,2]`：`[3, 1.5, 1.5]`（后两点合并，首点保持 3），与非递增结果不同。

测试中还枚举了小序列的全部连续分块（切分掩码枚举），取所有合法（块均值满足单调性）分块中 SSE 最小者与 PAVA 结果逐项对照。

## 权重口径

- 权重表示对应观测在加权平方误差中的相对重要程度：`w` 越大，拟合越靠近该点。
- 缺省权重统一为 `1`（普通等权保序回归）。
- 显式权重必须是与观测**等长**的数组，每个元素是严格为正的有限数（`w > 0`）；零、负数、`NaN`、`Infinity` 一律拒绝。
- 所有权重同乘一个正数只改变目标函数尺度，不改变最优解（测试覆盖）；观测整体加常数，拟合同步平移（测试覆盖）。

## 常值块含义

常值块（pooled block / level block）是最终拟合值相同的一段连续位置：它表示这组观测在单调性约束下“共享同一个最优水平”，该水平是块内按权重加权的均值。它不是变点检测选出的固定数量分段，也不是回归直线；分块完全由加权 PAVA 的合并结果决定。

## 输入限制

| 项目 | 限制 |
 | --- | --- |
| 序列长度 `n` | `0 ≤ n ≤ 100000` |
| 观测绝对值 | `≤ 1e12` |
| 单个权重 | `0 < w ≤ 1e9` |
| 累计量 | 权重和、加权和、块均值、SSE 必须有限；非有限时报 `NUMERIC_OVERFLOW` |

空序列返回空拟合、空块、零误差；单点原样返回。JSON 中 `null`、字符串数字、`NaN`、`Infinity` 均按非法值拒绝（不会隐式转数）；非法方向返回 `VALIDATION_ERROR`。

## 错误码

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `EMPTY_BODY` / `INVALID_JSON` | 请求体为空 / JSON 无法解析或顶层不是对象 |
| 400 | `VALIDATION_ERROR` | 参数校验失败（长度、正数、方向、下标越界等；含具体 `details.field`） |
| 404 | `NOT_FOUND` | 序列 / 版本 / 报告不存在 |
| 409 | `CONFLICT` | 比较对象结构冲突 |
| 422 | `NUMERIC_OVERFLOW` | 累计量溢出或结果非有限 |
| 500 | `INTERNAL_ERROR` | 服务内部错误 |

CLI 以非零退出码退出，并打印 `[错误码] 消息`。

## SQLite 持久化语义

数据默认存于项目内 `data/app.sqlite`（可 `--db` 覆盖）。表结构：

- `sequences`：序列头；`observations(seq_id, pos, y)`：**按原始位置冻结的观测**。
- `weight_versions` + `weights(version_id, pos, w)`：权重版本。改变一个权重即新建版本（版本号递增），旧版本及其报告原样冻结，**不会被悄悄重算**。
- `fits(version_id, direction)`：冻结算法版本（`pava-1.0.0`）、完整结果 JSON、SSE、合并次数、解释截断标记与时间戳。

拟合落盘在单个 `BEGIN IMMEDIATE` 事务中完成：算法抛错（校验失败、溢出）时事务回滚，不会留下“显示成功但没有完整拟合值”的记录。重启后可逐点查询并导出与之前完全相同的内容（有专门测试）。重复请求同一版本+方向返回冻结报告（幂等）。

不提供在线无限流、删点增量更新和额外上下界约束（非本项目范围）。

## 快速开始

需要 Node.js ≥ 22.5（`node:sqlite` 内置；可用 `node --version` 确认）。

```powershell
npm install
npm run build      # 编译到 dist/
npm test           # 构建并运行 node:test（22 个测试）
npm run demo       # 终端演示：原值/权重/拟合/块编号表格
npm start          # 启动 HTTP API，默认自动选择空闲端口（可 --port 8080）
```

## CLI 示例

`--db` 默认为 `data/app.sqlite`；数值参数支持逗号列表或 JSON 数组。

```powershell
node dist/src/cli.js import --y "3,1,2" --w "1,1,1" --name demo
node dist/src/cli.js list
node dist/src/cli.js get <seqId>
node dist/src/cli.js point <seqId> 1
node dist/src/cli.js add-version <seqId> --w "3,1,1" --note "首点加权"
node dist/src/cli.js fit <versionId> nondecreasing
node dist/src/cli.js fit <versionId> nonincreasing
node dist/src/cli.js blocks <versionId> nondecreasing
node dist/src/cli.js events <versionId> nondecreasing
node dist/src/cli.js point-fit <versionId> nondecreasing 1
node dist/src/cli.js compare <seqId> <v1> <v2> nondecreasing
node dist/src/cli.js export <versionId> nondecreasing json --out report.json
node dist/src/cli.js export <versionId> nondecreasing csv  --out report.csv
node dist/src/cli.js serve --port 8080
```

## HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/health` | 健康检查与公开限制 |
| `POST /api/sequences` | 导入序列，body：`{name?, y:number[], w?:number[]}` |
| `GET /api/sequences` | 列出序列 |
| `GET /api/sequences/:seqId` | 序列头 + 冻结观测 + 权重版本列表 |
| `GET /api/sequences/:seqId/points/:index` | 查询单点原始观测 |
| `POST /api/sequences/:seqId/versions` | 新建权重版本：`{weights:number[], note?}` |
| `GET /api/sequences/:seqId/versions` | 版本列表 |
| `POST /api/versions/:versionId/fit/:direction` | 执行/获取冻结拟合；body 可含 `{maxEvents?}` |
| `GET .../fit/:direction` | 取完整报告（拟合、块、残差、SSE） |
| `GET .../fit/:direction/blocks` | 常值块 |
| `GET .../fit/:direction/events` | 合并解释记录（含截断标记） |
| `GET .../fit/:direction/point?index=k` | 单点拟合（原值、权重、拟合、残差、所属块） |
| `GET .../fit/:direction/export?format=json\|csv` | 导出 JSON / CSV |
| `GET /api/sequences/:seqId/compare?direction=..&a=<v1>&b=<v2>` | 比较两个权重版本（逐点拟合差、SSE 差） |

```powershell
$base = 'http://127.0.0.1:8080'
Invoke-RestMethod "$base/api/sequences" -Method Post -ContentType 'application/json' `
  -Body '{"name":"demo","y":[3,1,2],"w":[1,1,1]}'
```

## 项目结构

```
src/
  pava.ts        # PAVA 核心（违规合并 + 等均值展示合并 + 解释记录）
  validation.ts  # 输入校验（有限数、严格正权重、长度一致、方向/下标）
  db.ts          # SQLite 存储、权重版本、原子拟合落盘、版本比较
  server.ts      # 仅 127.0.0.1 监听的 HTTP API
  cli.ts         # 命令行入口
  demo.ts        # 终端演示
  exporters.ts   # JSON / CSV 导出
test/            # node:test：算法性质、枚举对照、手算 SSE、回滚、重启、API 端到端
scripts/smoke.ps1
```

## 范围与限制

- 仅后端（API + CLI）；仅监听本机回环地址；无鉴权与多用户设计。
- 仅一维、两个方向；无上下界约束、无在线流、无删点增量更新。
- 使用 IEEE 754 双精度；超大规模/极端数值在累计阶段会明确报溢出而非产生 `Infinity`/`null`。
- `node:sqlite` 在当前 Node 版本带实验性警告，启动命令已加 `--no-warnings`。
