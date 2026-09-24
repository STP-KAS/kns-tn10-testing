#!/usr/bin/env node
/**
 * KNS TN10 domain-create dry-run.
 * Builds payload + fee plan + commit/reveal skeleton. Does NOT sign or broadcast.
 * Usage:
 *   node kns-create-dryrun.mjs --label mylabel [--payer kaspatest:...] [--broadcast 0]
 * Env BROADCAST must not be 1 unless you later wire a signer (still refused here).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const API = "https://api.knsdomains.org/tn10/api/v1";
const FEE_ADDR =
  "kaspatest:qq9h47etjv6x8jgcla0ecnp8mgrkfxm70ch3k60es5a50ypsf4h6sak3g0lru";
const BAL_API = "https://api-tn10.kaspa.org/addresses";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return def;
}

function visualLen(s) {
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    return [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(s)].length || s.length;
  }
  return [...s].filter((c) => c !== "\u200d" && c !== "\ufe0f").length || s.length;
}

function priceKas(label) {
  const n = visualLen(label);
  if (n <= 2) return 4200;
  if (n === 3) return 2100;
  if (n === 4) return 525;
  return 35;
}

function readAddr(file) {
  try {
    return fs.readFileSync(path.join(ROOT, file), "utf8").trim();
  } catch {
    return null;
  }
}

const labelRaw = arg("--label", `stp-smoke-${Math.floor(Date.now() / 1000)}`);
const label = labelRaw.replace(/\.kas$/i, "").trim().toLowerCase();
const domain = `${label}.kas`;
const payer =
  arg("--payer", null) ||
  readAddr("backup-fund-address.txt") ||
  readAddr("seed-derived-receive-0.txt");
const wantBroadcast = arg("--broadcast", process.env.BROADCAST || "0") === "1";

if (!payer || !payer.startsWith("kaspatest:")) {
  console.error("Need --payer kaspatest:… or backup-fund-address.txt");
  process.exit(2);
}

const payloadObj = { op: "create", p: "domain", v: label };
const payload = JSON.stringify(payloadObj);
const feeKas = priceKas(label);
const needKas = feeKas * 1.05 + 1 + 0.01 + 0.02; // fee buffer + commit lock + priority fees

const out = {
  network: "testnet-10",
  broadcast: false,
  domain,
  label,
  payer,
  knsPaymentAddress: FEE_ADDR,
  payload,
  payloadBytes: Buffer.byteLength(payload, "utf8"),
  visualLength: visualLen(label),
  feeKas,
  recommendedHoldKas: needKas,
  envelope:
    "<xonly_pubkey> OP_CHECKSIG OP_FALSE OP_IF <kns> <0> <payload> OP_ENDIF",
  commitPlan: {
    outputs: [{ address: "<p2shAddress from buildScript>", amountKas: 1 }],
    changeAddress: payer,
    priorityFeeKas: 0.01,
    note: "p2shAddress comes from kasware.buildScript({type:'KNS', data: payload})",
  },
  revealPlan: {
    outputs: [{ address: FEE_ADDR, amountKas: feeKas, role: "protocol_fee_out0" }],
    changeAddress: payer,
    priorityFeeKas: 0.02,
    networkId: "testnet-10",
  },
  kaswareSnippet: {
    buildScript: { type: "KNS", data: payload },
    submitCommitRevealNetworkId: "testnet-10",
  },
  checks: {},
};

async function main() {
  if (wantBroadcast) {
    console.error(
      "Refusing broadcast: this script is dry-run only. Use KasWare HTML or a signed builder with explicit ops review."
    );
    process.exit(3);
  }

  const balRes = await fetch(`${BAL_API}/${payer}/balance`, {
    headers: { "user-agent": "kns-tn10-dryrun/1.0" },
  });
  const balJson = await balRes.json();
  const sompi = Number(balJson.balance || 0);
  out.checks.balanceSompi = sompi;
  out.checks.balanceKas = sompi / 1e8;
  out.checks.balanceOk = sompi / 1e8 >= needKas;

  const checkRes = await fetch(`${API}/domains/check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ domainNames: [domain], address: payer }),
  });
  const checkJson = await checkRes.json();
  out.checks.domainsCheckHttp = checkRes.status;
  out.checks.domainsCheck = checkJson;
  const row = checkJson?.data?.domains?.[0];
  out.checks.available = row?.available === true && row?.isReservedDomain === false;

  const stamp = label.replace(/[^a-z0-9-]/g, "").slice(0, 48) || "domain";
  const outPath = path.join(ROOT, "api", `dryrun-${stamp}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  console.log(JSON.stringify({
    ok: out.checks.balanceOk && out.checks.available,
    domain,
    payer,
    feeKas,
    balanceKas: out.checks.balanceKas,
    available: out.checks.available,
    wrote: outPath,
    broadcast: false,
  }, null, 2));

  if (!out.checks.available) process.exit(4);
  if (!out.checks.balanceOk) process.exit(5);
}

main().catch((e) => {
  console.error(String(e));
  process.exit(1);
});
