#!/usr/bin/env node
/**
 * R1: one random KNS name per wallet 20700-25699 (TN10). Length uniform in 3..10 (seeded RNG).
 * Charset: a-z 0-9, hyphen only at interior positions and never "--" (matches kns-spec envelope asciiLabel regex).
 * All names unique within the set and checked "available && !isReservedDomain" on the TN10 indexer; collisions regenerated
 * (same length) from the same seeded stream. Output: snapshot-wallets/r1-names.csv (index,address,name,length,fee).
 * Usage: node gen-r1-names.mjs [--seed r1-2026-09-24] [--from 20700] [--to 25699]
 */
import fs from "node:fs";
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : d; };
const OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets";
const API = "https://api.knsdomains.org/tn10/api/v1/domains/check";
const SEED = arg("--seed", "r1-2026-09-24"), FROM = +arg("--from", "20700"), TO = +arg("--to", "25699");
// xmur3 + sfc32 seeded PRNG
function xmur3(s) { let h = 1779033703 ^ s.length; for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); } return () => { h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); return (h ^= h >>> 16) >>> 0; }; }
function sfc32(a, b, c, d) { return () => { a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0; let t = (a + b) | 0; a = b ^ (b >>> 9); b = (c + (c << 3)) | 0; c = (c << 21) | (c >>> 11); d = (d + 1) | 0; t = (t + d) | 0; c = (c + t) | 0; return (t >>> 0) / 4294967296; }; }
const sd = xmur3(SEED); const rnd = sfc32(sd(), sd(), sd(), sd()); for (let i = 0; i < 20; i++) rnd();
const END = "abcdefghijklmnopqrstuvwxyz0123456789", MID = END + "-";
const pick = (s) => s[Math.floor(rnd() * s.length)];
export const feeFor = (n) => (n <= 2 ? 4200 : n === 3 ? 2100 : n === 4 ? 525 : 35);
function randName(len) {
  for (;;) {
    let s = pick(END); for (let i = 1; i < len - 1; i++) s += pick(MID); if (len > 1) s += pick(END);
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s) || s.includes("--") || s.startsWith("stp-")) continue;
    return s;
  }
}
const rows = fs.readFileSync(`${OUT}/addresses.csv`, "utf8").trim().split("\n").slice(1).map((l) => l.split(",")).filter((r) => +r[0] >= FROM && +r[0] <= TO);
if (rows.length !== TO - FROM + 1) throw new Error("address rows missing");
const probe = rows[0][1];
async function check(names) {
  for (let a = 0; a < 6; a++) {
    try {
      const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ domainNames: names.map((n) => n + ".kas"), address: probe }) });
      const j = await r.json(); if (!j?.success) throw new Error(j?.error || "check failed");
      const m = new Map(); for (const d of j.data.domains) m.set(d.domain.replace(/\.kas$/, ""), d.available === true && d.isReservedDomain === false); return m;
    } catch (e) { await new Promise((r) => setTimeout(r, 2000 * (a + 1))); }
  }
  throw new Error("indexer check failed repeatedly");
}
const plan = rows.map(([i, a]) => ({ index: +i, address: a, length: 3 + Math.floor(rnd() * 8), name: null }));
const used = new Set(); let collisionsIndexer = 0, collisionsLocal = 0, rounds = 0, checks = 0;
let pending = plan;
while (pending.length) {
  rounds++;
  for (const p of pending) { let n; do { n = randName(p.length); if (used.has(n)) collisionsLocal++; } while (used.has(n)); p.name = n; used.add(n); }
  const next = [];
  for (let k = 0; k < pending.length; k += 100) {
    const chunk = pending.slice(k, k + 100); const m = await check(chunk.map((p) => p.name)); checks++;
    for (const p of chunk) if (m.get(p.name) !== true) { collisionsIndexer++; next.push(p); }   // taken/reserved/unknown -> regenerate (keep name in `used` so it is never reused)
    await new Promise((r) => setTimeout(r, 150));
  }
  pending = next;
  if (rounds > 50) throw new Error("too many rounds");
}
const lines = ["index,address,name,length,fee"]; for (const p of plan) lines.push(`${p.index},${p.address},${p.name},${p.length},${feeFor(p.length)}`);
const out = `${OUT}/r1-names.csv`;
if (fs.existsSync(out)) fs.copyFileSync(out, `${out}.bak-${Date.now()}`);
fs.writeFileSync(out, lines.join("\n") + "\n");
const dist = {}; let total = 0; for (const p of plan) { dist[p.length] = (dist[p.length] || 0) + 1; total += feeFor(p.length); }
const names = new Set(plan.map((p) => p.name));
const res = { seed: SEED, count: plan.length, unique: names.size, length_distribution: dist, total_kns_fees_tkas: total, collisions_indexer: collisionsIndexer, collisions_local: collisionsLocal, rounds, check_calls: checks, hyphenated: plan.filter((p) => p.name.includes("-")).length, at: new Date().toISOString() };
fs.writeFileSync(`${OUT}/r1-names-meta.json`, JSON.stringify(res, null, 2) + "\n");
console.log(JSON.stringify(res));
