import { pathToFileURL } from "node:url"; import { createRequire } from "node:module";
const require = createRequire("/workspace/artifacts/kns-tn10/npm-kaspa/package.json");
globalThis.WebSocket = require("websocket").w3cwebsocket;
const kaspa = await import(pathToFileURL("/workspace/artifacts/kns-tn10/wasm-sdk/kaspa-wasm32-sdk/nodejs/kaspa/kaspa.js").href);
const T="kaspatest:qzffl5xy9np46gkttyuftqnv2w04pr8g3wsp7c3vv8se3txtelx6q7c0v0ldx";
const rpc=new kaspa.RpcClient({resolver:new kaspa.Resolver(),encoding:kaspa.Encoding.Borsh,networkId:"testnet-10"}); await rpc.connect();
const r=await rpc.getBalancesByAddresses([T]); const i=await rpc.getServerInfo();
console.log(JSON.stringify({url:rpc.url,synced:i.isSynced,daa:String(i.virtualDaaScore),treasury_tkas:Number(BigInt(r.entries[0].balance))/1e8}));
await rpc.disconnect();
