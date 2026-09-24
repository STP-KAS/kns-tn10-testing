#!/usr/bin/env node
/**
 * Pace KNS TN10 creates: stp-bulk-NNNN labels with retries.
 * Usage: node kns-bulk-create.mjs --from 1 --to 10 --delay-ms 10000 --broadcast 1 --retries 3
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const smoke = path.join(__dirname, "kns-smoke-create.mjs");
const apiDir = path.join(root, "api");

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}

const from = Number(arg("--from", "1"));
const to = Number(arg("--to", "10"));
const delayMs = Number(arg("--delay-ms", "10000"));
const broadcast = arg("--broadcast", "0");
const retries = Number(arg("--retries", "3"));
const logPath = path.join(apiDir, `bulk-log-${from}-${to}.jsonl`);
fs.mkdirSync(apiDir, { recursive: true });

function artifactPath(label) {
  return path.join(apiDir, `smoke-result-${label}.json`);
}

function readArtifact(label) {
  try {
    return JSON.parse(fs.readFileSync(artifactPath(label), "utf8"));
  } catch {
    return null;
  }
}

function runOne(label, attempt) {
  return new Promise((resolve) => {
    const childLog = path.join(apiDir, `child-${label}-a${attempt}.log`);
    const out = fs.createWriteStream(childLog);
    const child = spawn(
      process.execPath,
      [smoke, "--label", label, "--broadcast", broadcast],
      { cwd: root, env: process.env }
    );
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      out.write(d);
    });
    child.stderr.on("data", (d) => {
      buf += d;
      out.write(d);
    });
    child.on("close", (code) => {
      out.end();
      resolve({ code, buf, childLog });
    });
  });
}

function parseLast(buf) {
  const lines = buf.trim().split("\n").filter(Boolean);
  let last = {};
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const j = JSON.parse(lines[i]);
      if (j.phase === "done" || j.revealId || j.phase === "reveal") {
        last = j;
        if (j.phase === "done") break;
      }
    } catch {}
  }
  return last;
}

const summary = [];
for (let i = from; i <= to; i++) {
  const label = `stp-bulk-${String(i).padStart(4, "0")}`;
  const started = new Date().toISOString();
  let art = readArtifact(label);
  if (art?.revealId) {
    console.log(JSON.stringify({ phase: "skip_exists", label, revealId: art.revealId }));
    summary.push({ label, code: 0, skipped: true, last: art });
    continue;
  }
  let final = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    console.log(JSON.stringify({ phase: "start", label, attempt, started }));
    const { code, buf, childLog } = await runOne(label, attempt);
    const last = parseLast(buf);
    art = readArtifact(label);
    const ok = !!(art?.revealId || last.revealId || last.phase === "done");
    final = { label, code: ok ? 0 : code, attempt, childLog, last: art || last };
    fs.appendFileSync(logPath, JSON.stringify({ ...final, started, finished: new Date().toISOString() }) + "\n");
    console.log(JSON.stringify({ phase: "attempt_done", label, attempt, ok, code, revealId: (art || last).revealId, childLog }));
    if (ok) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  summary.push(final);
  if (i < to) await new Promise((r) => setTimeout(r, delayMs));
}

const ok = summary.filter((s) => s && (s.skipped || s.last?.revealId || s.code === 0)).length;
console.log(JSON.stringify({ phase: "batch_complete", from, to, ok, fail: summary.length - ok, logPath }, null, 2));
process.exit(ok === summary.length ? 0 : 1);
