// Read-only: prints the TN10 treasury balance in TKAS (public address only; no keys). Uses the public resolver RPC (local kaspads have no utxoindex).
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);
const ADDR = "kaspatest:qzffl5xy9np46gkttyuftqnv2w04pr8g3wsp7c3vv8se3txtelx6q7c0v0ldx";
const t = setTimeout(() => { console.log("ERR timeout"); process.exit(2); }, 40000);
try {
  const c = new kaspa.RpcClient({ resolver: new kaspa.Resolver(), encoding: kaspa.Encoding.Borsh, networkId: "testnet-10" });
  await c.connect();
  const r = await c.getBalancesByAddresses([ADDR]);
  console.log((Number(BigInt(r.entries[0]?.balance ?? 0)) / 1e8).toFixed(2));
  await c.disconnect();
} catch (e) { console.log("ERR " + String(e?.message || e).slice(0, 100)); clearTimeout(t); process.exit(1); }
clearTimeout(t); process.exit(0);
