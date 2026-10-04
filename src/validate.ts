import { Direction, IsoError, LIMITS } from "./pava.js";

export function parseDirection(v: unknown): Direction {
  if (v === "increasing" || v === "decreasing") return v;
  throw new IsoError("BAD_DIRECTION", `非法方向: ${JSON.stringify(v)}, 仅支持 "increasing" | "decreasing"`);
}

export function parseSequence(v: unknown, name: string): number[] {
  if (!Array.isArray(v)) throw new IsoError("INVALID_INPUT", `${name} 必须是数组`);
  if (v.length > LIMITS.MAX_N) throw new IsoError("LIMIT_EXCEEDED", `${name} 长度 ${v.length} 超过上限 ${LIMITS.MAX_N}`);
  return v.map((x, i) => {
    if (typeof x !== "number" || x === null) {
      throw new IsoError("INVALID_INPUT", `${name}[${i}] 必须是数字, 不允许字符串隐式转换或 null`);
    }
    if (!Number.isFinite(x)) throw new IsoError("NON_FINITE", `${name}[${i}] 不是有限数`);
    if (Math.abs(x) > LIMITS.MAX_ABS_VALUE) throw new IsoError("LIMIT_EXCEEDED", `${name}[${i}] 超出数值范围 ±${LIMITS.MAX_ABS_VALUE}`);
    return x;
  });
}

export function parseWeights(v: unknown, n: number): number[] {
  if (v === undefined || v === null) return new Array<number>(n).fill(1);
  const w = parseSequence(v, "w");
  if (w.length !== n) throw new IsoError("LENGTH_MISMATCH", `权重长度 ${w.length} 与观测长度 ${n} 不一致`);
  for (let i = 0; i < n; i++) {
    if (!(w[i] > 0)) throw new IsoError("NON_POSITIVE_WEIGHT", `w[${i}] 必须严格为正`);
    if (w[i] > LIMITS.MAX_WEIGHT) throw new IsoError("LIMIT_EXCEEDED", `w[${i}] 超出权重上限 ${LIMITS.MAX_WEIGHT}`);
  }
  return w;
}
