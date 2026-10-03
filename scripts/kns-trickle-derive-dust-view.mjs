// Offline: funded-2026-10-02 utxo-snapshot.json + events.jsonl => remaining UTXOs of the 100 funded wallets -> dust-view.json (this folder).
import fs from "node:fs";
const B = "/workspace/artifacts/kns-tn10/funded-2026-10-02", O = "/workspace/artifacts/kns-tn10/trickle-2026-10-02";
const snap = JSON.parse(fs.readFileSync(`${B}/utxo-snapshot.json`, "utf8"));
const by = {}; for (const [a, l] of Object.entries(snap.byAddress)) by[a] = new Map(l.map((u) => [`${u.transactionId}:${u.index}`, u]));
for (const line of fs.readFileSync(`${B}/events.jsonl`, "utf8").split("\n")) { if (!line) continue; const e = JSON.parse(line);
  if (e.phase === "commit_accepted") { for (const s of e.spent) by[s.addr]?.delete(`${s.txid}:${s.index}`); for (const x of e.created) (by[x.addr] ||= new Map()).set(`${x.utxo.transactionId}:${x.utxo.index}`, x.utxo); }
  if (e.phase === "reveal_accepted") for (const x of e.created) (by[x.addr] ||= new Map()).set(`${x.utxo.transactionId}:${x.utxo.index}`, x.utxo); }
const out = {}; let n = 0, t = 0n; for (const [a, m] of Object.entries(by)) if (m.size) { out[a] = [...m.values()]; n += m.size; for (const u of m.values()) t += BigInt(u.amount); }
fs.writeFileSync(`${O}/dust-view.json`, JSON.stringify({ at: new Date().toISOString(), derived_from: [`${B}/utxo-snapshot.json`, `${B}/events.jsonl`], wallets: Object.keys(out).length, utxos: n, byAddress: out }) + "\n");
console.log(JSON.stringify({ wallets: Object.keys(out).length, utxos: n, tkas: Number(t) / 1e8 }));
