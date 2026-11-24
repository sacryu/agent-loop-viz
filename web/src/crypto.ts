// 浏览器里的密码学：从邀请链接的 K 派生口令和内容密钥，解开附件。
// 默认用浏览器自带的 WebCrypto。它只在 HTTPS 或 localhost 下可用；用 http://<IP> 打开内网的服务器时没有它，
// 退回下面这份纯 JS 的实现（SHA-256、HMAC、HKDF、AES-256-GCM 解密），页面上提示「连接没有加密传输」。
// 两条路的结果完全一样（test/crypto.test.ts 用固定的密钥和数据比对 Node 加密的结果）。

import { ID_HEX, KEY43_RE } from "@agent-loop/shared/browser";

const enc = new TextEncoder();

export function b64uDecode(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
export function b64uEncode(u: Uint8Array): string {
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const hex = (u: Uint8Array) => Array.from(u, x => x.toString(16).padStart(2, "0")).join("");

// ------------------------------------------------------------------ 纯 JS 的实现

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = data.length, total = ((len + 9 + 63) >> 6) << 6, m = new Uint8Array(total);
  m.set(data); m[len] = 0x80;
  const dv = new DataView(m.buffer);
  dv.setUint32(total - 8, Math.floor(len / 0x20000000)); dv.setUint32(total - 4, (len << 3) >>> 0);
  const w = new Uint32Array(64);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32), ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]);
  return out;
}

function hmac(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? sha256(key) : key);
  const ip = new Uint8Array(64 + msg.length), op = new Uint8Array(64 + 32);
  for (let i = 0; i < 64; i++) { ip[i] = k[i] ^ 0x36; op[i] = k[i] ^ 0x5c; }
  ip.set(msg, 64);
  op.set(sha256(ip), 64);
  return sha256(op);
}

/** HKDF-SHA256，盐为空，输出 32 字节 */
export function hkdf32(ikm: Uint8Array, info: string): Uint8Array {
  const prk = hmac(new Uint8Array(32), ikm);
  const inf = enc.encode(info), t = new Uint8Array(inf.length + 1);
  t.set(inf); t[inf.length] = 1;
  return hmac(prk, t);
}

// AES-256 只要加密方向（GCM 的计数器模式和 GHASH 都只用到它）
const SBOX = (() => {
  const s = new Uint8Array(256);
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    s[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  s[0] = 0x63;
  return s;
})();
const xt = (b: number) => ((b << 1) ^ (b & 0x80 ? 0x1b : 0)) & 0xff;

function expandKey(key: Uint8Array): Uint8Array {
  const w = new Uint8Array(240);
  w.set(key);
  let rcon = 1;
  for (let i = 32; i < 240; i += 4) {
    let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
    if (i % 32 === 0) {
      const u = t0; t0 = SBOX[t1] ^ rcon; t1 = SBOX[t2]; t2 = SBOX[t3]; t3 = SBOX[u];
      rcon = xt(rcon);
    } else if (i % 32 === 16) { t0 = SBOX[t0]; t1 = SBOX[t1]; t2 = SBOX[t2]; t3 = SBOX[t3]; }
    w[i] = w[i - 32] ^ t0; w[i + 1] = w[i - 31] ^ t1; w[i + 2] = w[i - 30] ^ t2; w[i + 3] = w[i - 29] ^ t3;
  }
  return w;
}

// aesBlock 的两块暂存：每轮不再新建数组。结果写进调用方给的 out，不会被下一次调用改掉
const aesS = new Uint8Array(16), aesT = new Uint8Array(16);

function aesBlock(w: Uint8Array, inp: Uint8Array, out: Uint8Array = new Uint8Array(16)): Uint8Array {
  const s = aesS, t = aesT;
  for (let i = 0; i < 16; i++) s[i] = inp[i] ^ w[i];
  for (let r = 1; r <= 14; r++) {
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) t[c * 4 + row] = SBOX[s[((c + row) % 4) * 4 + row]];   // 字节代换 + 行移位
    if (r < 14) for (let c = 0; c < 4; c++) {   // 列混合
      const a0 = t[c * 4], a1 = t[c * 4 + 1], a2 = t[c * 4 + 2], a3 = t[c * 4 + 3], x = a0 ^ a1 ^ a2 ^ a3;
      t[c * 4] ^= x ^ xt(a0 ^ a1); t[c * 4 + 1] ^= x ^ xt(a1 ^ a2); t[c * 4 + 2] ^= x ^ xt(a2 ^ a3); t[c * 4 + 3] ^= x ^ xt(a3 ^ a0);
    }
    const d = r < 14 ? s : out;
    for (let i = 0; i < 16; i++) d[i] = t[i] ^ w[r * 16 + i];
  }
  return out;
}

// GHASH 用 4 位查表（Shoup）：每个密钥预先算 H 的 16 个倍数，每块 32 次查表。
// 128 位的数存成 4 个 32 位字（大端，第 0 个字是第 0–3 字节）；GCM 的位序里「乘 x」是右移
/** 右移 4 位时移出去的那 4 位折回来要异或到最高的字上的值（约化多项式 x^128 + x^7 + x^2 + x + 1） */
const LAST4 = new Uint32Array([0x0000, 0x1c20, 0x3840, 0x2460, 0x7080, 0x6ca0, 0x48c0, 0x54e0, 0xe100, 0xfd20, 0xd940, 0xc560, 0x9180, 0x8da0, 0xa9c0, 0xb5e0].map(v => v << 16));

/** 表的第 n 项（4 个字）= n·H，n 的 4 位按 GCM 的位序：8 是 H 本身，4 是 H·x，2 是 H·x²，1 是 H·x³ */
function ghashTable(h: Uint8Array): Uint32Array {
  const T = new Uint32Array(64), dv = new DataView(h.buffer, h.byteOffset, 16);
  let v0 = dv.getUint32(0), v1 = dv.getUint32(4), v2 = dv.getUint32(8), v3 = dv.getUint32(12);
  T[32] = v0; T[33] = v1; T[34] = v2; T[35] = v3;
  for (let i = 4; i > 0; i >>= 1) {
    const lsb = v3 & 1;
    v3 = (v3 >>> 1) | (v2 << 31); v2 = (v2 >>> 1) | (v1 << 31); v1 = (v1 >>> 1) | (v0 << 31); v0 = (v0 >>> 1) ^ (lsb ? 0xe1000000 : 0);
    T[i * 4] = v0; T[i * 4 + 1] = v1; T[i * 4 + 2] = v2; T[i * 4 + 3] = v3;
  }
  for (let i = 2; i < 16; i <<= 1) for (let j = 1; j < i; j++) for (let k = 0; k < 4; k++) T[(i + j) * 4 + k] = T[i * 4 + k] ^ T[j * 4 + k];
  return T;
}

const ghBlk = new Uint8Array(16), ghBlkDv = new DataView(ghBlk.buffer);

/** y = (y ⊕ 每一块)·H，依次吸收 data（最后不满 16 字节的补零） */
function ghash(T: Uint32Array, y: Uint32Array, data: Uint8Array) {
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  for (let i = 0; i < data.length; i += 16) {
    let src = dv, at = i;
    if (i + 16 > data.length) { ghBlk.fill(0); ghBlk.set(data.subarray(i)); src = ghBlkDv; at = 0; }
    y[0] ^= src.getUint32(at); y[1] ^= src.getUint32(at + 4); y[2] ^= src.getUint32(at + 8); y[3] ^= src.getUint32(at + 12);
    // 从最低的 4 位（第 15 字节的低 4 位）往高处走：每次先乘 x⁴（右移 4 位并约化），再加上这 4 位乘 H
    let z0 = 0, z1 = 0, z2 = 0, z3 = 0;
    for (let k = 3; k >= 0; k--) {
      let w = y[k];
      for (let j = 0; j < 8; j++) {
        const r = z3 & 0xf;
        z3 = (z3 >>> 4) | (z2 << 28); z2 = (z2 >>> 4) | (z1 << 28); z1 = (z1 >>> 4) | (z0 << 28); z0 = (z0 >>> 4) ^ LAST4[r];
        const t = (w & 0xf) << 2;
        z0 ^= T[t]; z1 ^= T[t + 1]; z2 ^= T[t + 2]; z3 ^= T[t + 3];
        w >>>= 4;
      }
    }
    y[0] = z0; y[1] = z1; y[2] = z2; y[3] = z3;
  }
}

/** AES-256-GCM 解密，12 字节随机数。校验不过就抛异常 */
export function gcmOpen(key: Uint8Array, iv: Uint8Array, ctTag: Uint8Array, aad: Uint8Array): Uint8Array {
  return gcmOpener(key)(iv, ctTag, aad);
}

/** 同一个密钥解很多段时用：轮密钥和 GHASH 的表只算一次 */
function gcmOpener(key: Uint8Array): (iv: Uint8Array, ctTag: Uint8Array, aad: Uint8Array) => Uint8Array {
  if (key.length !== 32) throw new Error("bad input");
  const w = expandKey(key), T = ghashTable(aesBlock(w, new Uint8Array(16)));
  return (iv, ctTag, aad) => {
    // 太短的输入里没有完整的校验值：直接拒绝（否则下面的 subarray 会用负下标取到别的字节）
    if (iv.length !== 12 || ctTag.length < 16) throw new Error("bad input");
    const ct = ctTag.subarray(0, ctTag.length - 16), tag = ctTag.subarray(ctTag.length - 16);
    const y = new Uint32Array(4);
    ghash(T, y, aad); ghash(T, y, ct);
    const lens = new Uint8Array(16), dv = new DataView(lens.buffer);
    dv.setUint32(4, aad.length * 8); dv.setUint32(12, ct.length * 8);
    ghash(T, y, lens);
    const j0 = new Uint8Array(16); j0.set(iv); j0[15] = 1;
    const ek = aesBlock(w, j0);
    let diff = 0;
    for (let i = 0; i < 16; i++) diff |= ((y[i >> 2] >>> (24 - (i & 3) * 8)) & 0xff) ^ ek[i] ^ tag[i];
    if (diff) throw new Error("bad tag");
    const out = new Uint8Array(ct.length), ctr = j0.slice(), ks = new Uint8Array(16);
    for (let i = 0; i < ct.length; i += 16) {
      for (let j = 15; j >= 12; j--) { ctr[j] = (ctr[j] + 1) & 0xff; if (ctr[j]) break; }
      aesBlock(w, ctr, ks);
      for (let j = 0; j < 16 && i + j < ct.length; j++) out[i + j] = ct[i + j] ^ ks[j];
    }
    return out;
  };
}

// 纯 JS 解密是同步的，一个会话的全部附件一起来时会在同一帧里解完、卡住画面。
// 排进队列：每次最多连着解 PURE_SLICE_MS 毫秒，剩下的让出主线程（setTimeout）以后接着解
const PURE_SLICE_MS = 4;
const pureQueue: (() => void)[] = [];
let pureHead = 0, pureScheduled = false;

function drainPure() {
  pureScheduled = false;
  const end = performance.now() + PURE_SLICE_MS;
  while (pureHead < pureQueue.length) {
    pureQueue[pureHead++]();
    if (performance.now() >= end) break;
  }
  if (pureHead < pureQueue.length) { pureScheduled = true; setTimeout(drainPure, 0); }
  else { pureQueue.length = 0; pureHead = 0; }
}

function queuePure<T>(job: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pureQueue.push(() => { try { resolve(job()); } catch (e) { reject(e); } });
    if (!pureScheduled) { pureScheduled = true; setTimeout(drainPure, 0); }
  });
}

// ------------------------------------------------------------------ 对外

export interface GroupKeys {
  k: string;
  access: string;      // 口令：发给服务器
  group: string;       // 星系群编号 = sha256(口令) 的前 32 个十六进制字符
  open: (sealed: string, aad: string) => Promise<unknown>;   // 解开一段密文（JSON）
  native: boolean;     // 用的是不是浏览器自带的 WebCrypto
}

/** 浏览器自带的 WebCrypto 能不能用（只在 HTTPS 或 localhost 下有） */
export const hasSubtle = () => typeof crypto !== "undefined" && !!crypto.subtle && (typeof isSecureContext === "undefined" || isSecureContext);

export async function deriveKeys(k: string, forcePure = false): Promise<GroupKeys | null> {
  if (!KEY43_RE.test(k)) return null;
  const K = b64uDecode(k);
  if (K.length !== 32) return null;
  const dec = new TextDecoder();
  if (!forcePure && hasSubtle()) {
    const s = crypto.subtle;
    const base = await s.importKey("raw", K as BufferSource, "HKDF", false, ["deriveBits"]);
    const bits = async (info: string) => new Uint8Array(await s.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) }, base, 256));
    const access = b64uEncode(await bits("agent-loop/access/v1"));
    const group = hex(new Uint8Array(await s.digest("SHA-256", enc.encode(access)))).slice(0, ID_HEX);
    const ck = await s.importKey("raw", (await bits("agent-loop/content/v1")) as BufferSource, "AES-GCM", false, ["decrypt"]);
    return {
      k, access, group, native: true,
      open: async (sealed, aad) => {
        const b = b64uDecode(sealed);
        const pt = await s.decrypt({ name: "AES-GCM", iv: b.subarray(0, 12) as BufferSource, additionalData: enc.encode(aad) }, ck, b.subarray(12) as BufferSource);
        return JSON.parse(dec.decode(pt));
      },
    };
  }
  const access = b64uEncode(hkdf32(K, "agent-loop/access/v1"));
  const group = hex(sha256(enc.encode(access))).slice(0, ID_HEX);
  const openCt = gcmOpener(hkdf32(K, "agent-loop/content/v1"));
  return {
    k, access, group, native: false,
    open: (sealed, aad) => queuePure(() => {
      const b = b64uDecode(sealed);
      return JSON.parse(dec.decode(openCt(b.subarray(0, 12), b.subarray(12), enc.encode(aad)))) as unknown;
    }),
  };
}
