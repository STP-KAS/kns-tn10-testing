#!/usr/bin/env node
// Watches balances of wallet ranges; when every wallet in a 100-block is >= 3900 TKAS, launches Phase A workers
// (2 x 50 wallets) detached with their own stdout log + pid (status/jsonl files are range-derived by kns-snap-phase-a.mjs).
// Uses no private keys.
import fs from "node:fs"; import { spawn } from "node:child_process"; import { pathToFileURL } from "node:url"; import { createRequire } from "node:module";
const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);
const OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets", SCRIPTS = "/workspace/artifacts/kns-tn10/scripts";
const MIN = kaspa.kaspaToSompi("3900");
const blocks = [200, 300, 400, 500, 600].map((a) => ({ from: a, to: a + 99, launched: false }));
const rows = new Map(fs.readFileSync(`${OUT}/addresses.csv`, "utf8").trim().split("\n").slice(1).map((l) => { const [i, a] = l.split(","); return [+i, a]; }));
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
const rpc = new kaspa.RpcClient({ resolver: new kaspa.Resolver(), encoding: kaspa.Encoding.Borsh, networkId: "testnet-10" });
await rpc.connect();
const deadline = Date.now() + 120 * 60000;
while (blocks.some((b) => !b.launched) && Date.now() < deadline) {
  for (const b of blocks.filter((x) => !x.launched)) {
    const addrs = []; for (let i = b.from; i <= b.to; i++) addrs.push(rows.get(i));
    let funded = 0;
    for (let k = 0; k < addrs.length; k += 50) { const r = await rpc.getBalancesByAddresses(addrs.slice(k, k + 50)); for (const e of r.entries) if (BigInt(e.balance ?? 0) >= MIN) funded++; }
    if (funded < addrs.length) { log({ phase: "waiting", block: `${b.from}-${b.to}`, funded }); break; } // blocks fund in order
    for (const [f, t] of [[b.from, b.from + 49], [b.from + 50, b.to]]) {
      const tag = `${f}-${t}`;
      const fd = fs.openSync(`${OUT}/phase-a-stdout-${tag}.log`, "a");
      const c = spawn(process.execPath, [`${SCRIPTS}/kns-snap-phase-a.mjs`, "--wallet-from", String(f), "--wallet-to", String(t), "--domain-from", "0", "--domain-to", "99", "--delay-ms", "12000", "--broadcast", "1", "--retries", "3"], { cwd: SCRIPTS, detached: true, stdio: ["ignore", fd, fd] });
      c.unref(); fs.writeFileSync(`${OUT}/phase-a-${tag}.pid`, `${c.pid}\n`);
      log({ phase: "launched", range: tag, pid: c.pid });
      await new Promise((r) => setTimeout(r, 2000));
    }
    b.launched = true;
  }
  if (blocks.some((b) => !b.launched)) await new Promise((r) => setTimeout(r, 30000));
}
log({ phase: "watcher_done", launched: blocks.filter((b) => b.launched).map((b) => `${b.from}-${b.to}`) });
await rpc.disconnect(); process.exit(0);
