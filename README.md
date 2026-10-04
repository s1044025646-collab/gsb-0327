# 加权保序回归后端 (Weighted Isotonic Regression)

纯本地运行的加权保序回归服务: TypeScript + Node.js + SQLite(`node:sqlite`, 零原生依赖), 仅提供 HTTP API 与 CLI, 无前端。

## 功能范围

- 输入: 按位置排列的有限数值序列 `y` 与对应正权重 `w`(缺省全为 1)。
- 输出: 非递减(或非递增)拟合值, 使加权平方误差 `Σ wᵢ(yᵢ - fᵢ)²` 最小。
- 顺序是外部给定的先后关系, **不会**先按观测值排序再拟合。
- 只做一维序列拟合; 不训练分类模型、不拟合直线、不做变点数量选择, 不输出因果或预测置信结论。

## 算法

自行实现 PAVA(相邻违规块合并):

1. 从单点块开始, 每块保存起止位置 `[start, end)`、权重和 `weightSum`、加权观测和 `valueSum`, 块拟合值 = `valueSum / weightSum`。
2. 顺序扫描; 当前块均值大于后块均值时合并两块(加权合并, 不是块均值的简单平均), 并继续向前检查直到恢复单调。
3. 非递增模式通过对 `y` 取负复用同一核心, 结果再映射回原方向。
4. 展示规则: 相邻拟合值相等的块公开合并为一个常值块; 块范围恰好覆盖整个序列且互不重叠, 每个块的均值可用原始 `y`、`w` 重新核算。
5. 每次违规合并都记录: 合并前后两块统计、合并后统计、受影响下标。解释记录上限 1000 条(`MAX_TRACE_RECORDS`), 超出后仅截断记录、**不会**提前结束计算。

## 快速开始

```powershell
npm install
npm run build     # tsc 编译到 dist/
npm test          # 编译并运行全部测试
npm run demo      # 终端演示: 3,1,2 等权合并 / 改首点权重 / 已单调序列 / 两方向对比
npm start         # 启动 HTTP 服务(默认自动选择空闲端口, 可用 PORT 环境变量指定)
```

CLI(先 `npm run build`):

```powershell
node dist/src/cli.js fit --y 3,1,2 --w 1,1,1 --dir increasing
node dist/src/cli.js list
node dist/src/cli.js show 1
node dist/src/cli.js point 1 0
node dist/src/cli.js blocks 1
node dist/src/cli.js merges 1
node dist/src/cli.js compare --y 3,1,2 --wA 1,1,1 --wB 5,1,1
node dist/src/cli.js export 1 --format csv
node dist/src/cli.js serve --port 8080
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查与算法版本 |
| GET | `/limits` | 输入规模与数值范围限制 |
| POST | `/runs` | `{y, w?, direction?}` 拟合并原子保存, 返回完整报告 |
| GET | `/runs` | 列出所有运行 |
| GET | `/runs/:id` | 完整报告(y/w/fitted/残差/SSE/块) |
| GET | `/runs/:id/points/:i` | 查询单点 |
| GET | `/runs/:id/blocks` `/runs/:id/blocks/:k` | 查询常值块 |
| GET | `/runs/:id/merges` | 查看合并过程(可能截断, 见 `traceTruncated`) |
| GET | `/runs/:id/export?format=json\|csv` | 导出 |
| POST | `/compare` | `{y, wA, wB, direction?}` 比较两个权重版本(不落库) |

错误响应统一为 `{"error": {"code", "message"}}`, 错误码: `INVALID_INPUT`(含字符串隐式转数、null)、`NON_FINITE`、`NON_POSITIVE_WEIGHT`、`LENGTH_MISMATCH`、`BAD_DIRECTION`、`LIMIT_EXCEEDED`、`OVERFLOW`(累计量溢出)、`NOT_FOUND`、`INTERNAL`。

## 权重口径与常值块

- 权重 `wᵢ` 是点 `i` 在平方误差中的相对重要度: 块拟合值为加权平均 `Σwy / Σw`。权重统一乘任意正数, 拟合结果不变。
- 缺省权重全为 1; 显式权重必须严格为正、长度与 `y` 一致。
- 常值块是最终拟合值相同的一段连续下标; 块内所有点取同一拟合值(块均值), 块均值可由该范围内原始 `y`、`w` 重新核算。

## 持久化与版本

- SQLite 数据库默认在项目内 `data/isotonic.db`(可用环境变量 `ISO_DB` 覆盖)。
- 每次拟合冻结保存: 原始顺序、观测、权重、方向、算法版本(`pava-1.0.0`)、结果与解释摘要, 同一事务原子写入, 失败整体回滚, 不会留下"显示成功但没有完整拟合值"的记录。
- 改变一个权重后再次拟合会创建**新**运行记录, 旧报告不被重算或覆盖; 重启后可按 id 逐点查询并导出相同内容。

## 限制与假设

- `MAX_N = 100000`, `|y| ≤ 1e15`, `0 < w ≤ 1e15`, 超限返回 `LIMIT_EXCEEDED`。
- 空序列返回空结果与零误差; 单点原样返回。
- 不提供在线无限流、删点增量更新、额外上下界约束。
- `node:sqlite` 在 Node 25 中仍为实验特性(启动时有 ExperimentalWarning), 如需消除可换 `better-sqlite3`。
- 需要 Node.js ≥ 22(建议 25), Windows 本地运行, 不依赖 Docker/WSL/外部服务。
