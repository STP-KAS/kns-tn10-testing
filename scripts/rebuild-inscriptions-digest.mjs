#!/usr/bin/env node
/**
 * Rebuild KNS TN10 inscriptions digest from smoke-result-*.json (+ bulk-log failures).
 * Never prints seeds/keys/mnemonics.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const API = '/workspace/artifacts/kns-tn10/api';
const TARGET = 3000;
const DEFAULT_PAYER =
  'kaspatest:qz46xwjp2stquq20xjzguqg4wyqz0g08d3clr26tlkzcrvfv0j3nxmkaknsdd';
const FEE_NOTE = '35 TKAS per 5+ char name to KNS TN10 sink';

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listSmokeResults() {
  return fs
    .readdirSync(API)
    .filter((f) => f.startsWith('smoke-result-') && f.endsWith('.json'))
    .map((f) => path.join(API, f));
}

function parseBulkN(domain) {
  const m = String(domain).match(/^stp-bulk-(\d+)\.kas$/i);
  return m ? parseInt(m[1], 10) : null;
}

function shortPayer(p) {
  if (!p || p.length < 28) return p || '';
  return p.slice(0, 28) + '…';
}

// --- load + dedupe by domain (prefer latest at / prefer file with revealId) ---
const byDomain = new Map();
for (const file of listSmokeResults()) {
  let o;
  try {
    o = readJson(file);
  } catch {
    continue;
  }
  if (!o?.domain || !o?.revealId) continue;
  const prev = byDomain.get(o.domain);
  if (!prev) {
    byDomain.set(o.domain, o);
    continue;
  }
  const prevAt = Date.parse(prev.at || 0) || 0;
  const curAt = Date.parse(o.at || 0) || 0;
  if (curAt >= prevAt) byDomain.set(o.domain, o);
}

const items = [...byDomain.values()].sort((a, b) => {
  const na = parseBulkN(a.domain);
  const nb = parseBulkN(b.domain);
  if (na != null && nb != null) return na - nb;
  if (na != null) return -1;
  if (nb != null) return 1;
  return String(a.domain).localeCompare(String(b.domain));
});

const bulkNums = new Set();
for (const it of items) {
  const n = parseBulkN(it.domain);
  if (n != null) bulkNums.add(n);
}

const highestAny = bulkNums.size ? Math.max(...bulkNums) : 0;
let highestContig = 0;
for (let i = 1; i <= highestAny; i++) {
  if (bulkNums.has(i)) highestContig = i;
  else break;
}
const gaps = [];
for (let i = 1; i <= highestAny; i++) {
  if (!bulkNums.has(i)) gaps.push(i);
}

const smokeOnlyDomains = items
  .filter((it) => !/^stp-bulk-\d+\.kas$/i.test(it.domain))
  .map((it) => it.domain)
  .sort();
const snapDomains = smokeOnlyDomains.filter((d) =>
  /^stp-snap-/i.test(d.replace(/\.kas$/i, ''))
);
const otherSmoke = smokeOnlyDomains.filter(
  (d) => !/^stp-snap-/i.test(d.replace(/\.kas$/i, ''))
);

// failures: labels whose final successful attempt never landed in smoke-results
// Prefer: for each label in bulk logs, if max attempt ended code!=0 AND no smoke-result → failure
const finalByLabel = new Map(); // label -> best record
for (const f of fs.readdirSync(API).filter((x) => x.startsWith('bulk-log-') && x.endsWith('.jsonl'))) {
  const text = fs.readFileSync(path.join(API, f), 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o.label) continue;
    const prev = finalByLabel.get(o.label);
    const att = o.attempt ?? 0;
    if (!prev || att >= (prev.attempt ?? 0)) finalByLabel.set(o.label, o);
  }
}

const failuresFromParse = [];
for (const [label, o] of finalByLabel) {
  const domain = `${label}.kas`;
  const hasSuccess = byDomain.has(domain) && byDomain.get(domain).revealId;
  if (hasSuccess) continue;
  if (o.code !== 0) {
    failuresFromParse.push({
      label,
      code: o.code,
      attempt: o.attempt ?? null,
      note: 'non-zero code and no successful smoke-result',
    });
  } else if (!o.last?.revealId) {
    failuresFromParse.push({
      label,
      code: o.code ?? null,
      attempt: o.attempt ?? null,
      note: 'missing reveal in final log line and no smoke-result',
    });
  }
}

// in-progress batch from live processes
let inProgressBatch = null;
try {
  const ps = execSync("pgrep -af 'kns-bulk-create|kns-bulk-chain-resume' || true", {
    encoding: 'utf8',
  });
  const createLine = ps
    .split('\n')
    .find((l) => /kns-bulk-create\.mjs/.test(l) && /--from/.test(l));
  const chainLine = ps.split('\n').find((l) => /kns-bulk-chain-resume/.test(l));
  if (createLine) {
    const from = (createLine.match(/--from\s+(\d+)/) || [])[1];
    const to = (createLine.match(/--to\s+(\d+)/) || [])[1];
    const delay = (createLine.match(/--delay-ms\s+(\d+)/) || [])[1];
    inProgressBatch = `chain resume 751→3000; current kns-bulk-create --from ${from} --to ${to} --delay-ms ${delay || '?'} (running)`;
  } else if (chainLine) {
    inProgressBatch = `kns-bulk-chain-resume running: ${chainLine.trim().slice(0, 120)}`;
  }
} catch {
  /* ignore */
}

// refine with latest completed in current batch log
let latestInBatch = null;
const batchLog = path.join(API, 'bulk-log-751-1000.jsonl');
if (fs.existsSync(batchLog)) {
  const lines = fs.readFileSync(batchLog, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length) {
    try {
      latestInBatch = JSON.parse(lines[lines.length - 1]);
    } catch {
      /* ignore */
    }
  }
}
if (inProgressBatch && latestInBatch?.label) {
  inProgressBatch += `; last completed in batch log: ${latestInBatch.label} (code ${latestInBatch.code})`;
}

const payer =
  items.find((i) => i.payer)?.payer ||
  DEFAULT_PAYER;

const generatedAt = new Date().toISOString();
const stpBulkCompleted = bulkNums.size;

const digest = {
  generatedAt,
  count: items.length,
  stpBulkCompleted,
  stpBulkTarget: TARGET,
  highestContiguousCompleted: highestContig,
  highestAnyCompleted: highestAny,
  gapsBelowHighest: gaps,
  gapCount: gaps.length,
  smokeOnlyCount: smokeOnlyDomains.length,
  smokeOnlyDomains,
  snapOnlyCount: snapDomains.length,
  snapOnlyDomains: snapDomains,
  otherSmokeCount: otherSmoke.length,
  payer,
  feeKasNote: FEE_NOTE,
  inProgressBatch,
  failuresFromParse,
  items: items.map((it) => ({
    domain: it.domain,
    payer: it.payer || payer,
    commitId: it.commitId || null,
    revealId: it.revealId,
    inscriptionId: it.inscriptionId || (it.revealId ? `${it.revealId}i0` : null),
    feeKas: it.feeKas ?? 35,
    p2shAddress: it.p2shAddress || null,
    at: it.at || null,
  })),
};

// write JSON
fs.writeFileSync(path.join(API, 'inscriptions-digest.json'), JSON.stringify(digest, null, 2) + '\n');

// write CSV
const csvHeader = 'domain,revealId,inscriptionId,commitId,payer,feeKas,at\n';
const csvBody = digest.items
  .map((it) =>
    [
      it.domain,
      it.revealId,
      it.inscriptionId,
      it.commitId || '',
      it.payer,
      it.feeKas ?? '',
      it.at || '',
    ].join(',')
  )
  .join('\n');
fs.writeFileSync(path.join(API, 'inscriptions-digest.csv'), csvHeader + csvBody + '\n');

// write MD
const pad4 = (n) => String(n).padStart(4, '0');
const mdLines = [
  '# KNS TN10 inscriptions digest',
  '',
  `Generated: ${generatedAt}`,
  '',
  `Total inscribed: **${digest.count}**`,
  `stp-bulk progress: **${stpBulkCompleted}/${TARGET}** (highest contiguous completed: **${pad4(highestContig)}**; highest any: **${pad4(highestAny)}**)`,
  `Gaps below highest: **${gaps.length}**`,
  `Payer: \`${payer}\``,
  'Fee: 35 TKAS for 5+ char names',
  `In-progress batch: ${inProgressBatch || 'none'}`,
  '',
];
if (snapDomains.length) {
  mdLines.push(`stp-snap inscribed (separate): **${snapDomains.length}**`);
  mdLines.push('');
}
mdLines.push('| Domain | Reveal tx | Inscription id | Payer |');
mdLines.push('|--------|-----------|----------------|-------|');
for (const it of digest.items) {
  mdLines.push(
    `| \`${it.domain}\` | \`${it.revealId}\` | \`${it.inscriptionId}\` | \`${shortPayer(it.payer)}\` |`
  );
}
mdLines.push('');
fs.writeFileSync(path.join(API, 'inscriptions-digest.md'), mdLines.join('\n'));

// compact
const compact = {
  generatedAt,
  count: digest.count,
  stpBulkCompleted,
  highestContiguousCompleted: highestContig,
  highestAnyCompleted: highestAny,
  gapCount: gaps.length,
  gaps: gaps.slice(0, 50),
  snapOnlyCount: snapDomains.length,
  payer,
  inProgressBatch,
  failuresFromParseCount: failuresFromParse.length,
  first10: digest.items.slice(0, 10).map((i) => ({ domain: i.domain, revealId: i.revealId })),
  last10: digest.items.slice(-10).map((i) => ({ domain: i.domain, revealId: i.revealId })),
};
fs.writeFileSync(
  path.join(API, 'inscriptions-digest-compact.txt'),
  JSON.stringify(compact, null, 2) + '\n'
);

console.log(
  JSON.stringify(
    {
      ok: true,
      generatedAt,
      count: digest.count,
      stpBulkCompleted,
      highestContig,
      highestAny,
      gapCount: gaps.length,
      snapOnlyCount: snapDomains.length,
      otherSmokeCount: otherSmoke.length,
      failuresFromParseCount: failuresFromParse.length,
      failuresFromParse,
      inProgressBatch,
      payer,
      first10: compact.first10,
      last10: compact.last10,
    },
    null,
    2
  )
);
