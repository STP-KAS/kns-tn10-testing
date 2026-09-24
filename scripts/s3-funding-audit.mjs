// Read-only audit of s3 wallet funding (no keys): balances + names created -> implied funding, over/under-funded wallets.
import fs from "node:fs"; import { pathToFileURL } from "node:url"; import { createRequire } from "node:module";
try { fs.writeFileSync("/proc/self/oom_score_adj", "1000"); } catch {}
const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);
const OUT="/workspace/artifacts/kns-tn10/snapshot-wallets", API="/workspace/artifacts/kns-tn10/api";
const rows=new Map(fs.readFileSync(`${OUT}/addresses.csv`,"utf8").trim().split("\n").slice(1).map(l=>{const [i,a]=l.split(",");return [+i,a];}));
const names=new Map(); const started=new Set();
for(const f of fs.readdirSync(API)){ let m=f.match(/^smoke-result-stp-s3-w(\d{5})-d\d\.json$/); if(m){ names.set(+m[1],(names.get(+m[1])||0)+1); continue; } m=f.match(/^snap-child-stp-s3-w(\d{5})-d\d\.log$/); if(m) started.add(+m[1]); }
const rpc=new kaspa.RpcClient({resolver:new kaspa.Resolver(),encoding:kaspa.Encoding.Borsh,networkId:"testnet-10"}); await rpc.connect();
const per=35.0352; let held=0, implied=0, zero=[], over=[], under=[], t1=0,t2=0;
const idx=[...Array(20000).keys()].map(k=>k+700);
for(let k=0;k<idx.length;k+=100){ const part=idx.slice(k,k+100); const r=await rpc.getBalancesByAddresses(part.map(i=>rows.get(i)));
  r.entries.forEach((e,j)=>{ const i=part[j]; const b=Number(BigInt(e.balance??0))/1e8; const n=names.get(i)||0; const tgt=i>=10700?85:120; held+=b; const imp=b+n*per; implied+=imp; if(i>=10700) t2+=imp; else t1+=imp;
    if(b===0&&n===0) zero.push(i); if(imp>tgt+2) over.push([i,+imp.toFixed(2)]); if(imp<tgt-12 && !started.has(i)) under.push([i,+imp.toFixed(2)]); }); }
const res={at:new Date().toISOString(),wallets:20000,held_tkas:+held.toFixed(2),implied_funding_tkas:+implied.toFixed(2),tier1_implied:+t1.toFixed(2),tier2_implied:+t2.toFixed(2),names_created:[...names.values()].reduce((a,b)=>a+b,0),zero_balance_unfunded:zero.length,zero_first:zero.slice(0,10),overfunded:over.length,over_first:over.slice(0,10),underfunded_not_started:under.length,under_first:under.slice(0,10)};
fs.writeFileSync(`${OUT}/s3-funding-audit.json`,JSON.stringify(res,null,2)+"\n"); console.log(JSON.stringify(res));
await rpc.disconnect(); process.exit(0);
