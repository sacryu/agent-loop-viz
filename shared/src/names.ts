// 由编号自动生成名字：同一个编号永远得到同一个名字。不出现任何用户写的文字。
// 星系像星表编号（「ALC 1342+27」），项目像星座里的星（「κ Orbis 318」）。

function h32(s: string, seed = 0): number {
  // FNV-1a 加一个种子，只用来挑名字，不是安全哈希
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return h >>> 0;
}

/**
 * 星表编号：ALC HHMM±DD，和真实星表一样用天球坐标命名。赤经 HH 是 00–23 时、MM 是 00–59 分；
 * 赤纬 DD 是 0–90 度，按天球上的面积均匀取（sin 赤纬均匀），所以靠近天赤道的多、靠近天极的少。
 */
export function galaxyName(id: string): string {
  const a = h32(id, 1), b = h32(id, 2);
  const ra = String(a % 24).padStart(2, "0") + String((a >>> 8) % 60).padStart(2, "0");
  const dec = Math.round(Math.asin(2 * (b % 1000003) / 1000002 - 1) * 180 / Math.PI);
  return `ALC ${ra}${dec >= 0 ? "+" : "−"}${String(Math.abs(dec)).padStart(2, "0")}`;
}

const GREEK = ["α", "β", "γ", "δ", "ε", "ζ", "η", "θ", "ι", "κ", "λ", "μ", "ν", "ξ", "ο", "π", "ρ", "σ", "τ", "υ", "φ", "χ", "ψ", "ω"];
const CONST = ["Orbis", "Lyrae", "Draconis", "Cygni", "Aquilae", "Velorum", "Carinae", "Pavonis", "Tucanae", "Columbae",
  "Fornacis", "Hydrae", "Lupi", "Normae", "Octantis", "Pictoris", "Reticuli", "Sculptoris", "Volantis", "Mensae"];

export function projectName(id: string): string {
  const a = h32(id, 3), b = h32(id, 4);
  return `${GREEK[a % GREEK.length]} ${CONST[b % CONST.length]} ${100 + (a >>> 8) % 900}`;
}

/** 档位 2 时项目名用真实目录名 */
export function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
