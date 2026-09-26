#!/usr/bin/env node
/**
 * R1 funding loop (TN10): runs treasury-fund-r1.mjs passes until all 5,000 r1 wallets are funded.
 * - Checks every 10 min (every 2 min while waiting for another spender to go idle).
 * - Never runs a pass while any other treasury-fund* process or the tn10-million-test funder is alive.
 * - Pauses while snapshot-wallets/r1-STOP or r1-FUND-STOP exists.
 * This process holds no key (the pass loads it in-process) and its command line does not contain "treasury-fund",
 * so it never trips the tn10-million-test funder's lock check while idle.
 */
import fs from "node:fs"; import { spawn } from "node:child_process"; import { otherSpenders } from "./r1-spenders.mjs";
try { fs.writeFileSync("/proc/self/oom_score_adj", "500"); } catch {}
const OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets", SCRIPTS = "/workspace/artifacts/kns-tn10/scripts";
const STATUS = `${OUT}/desk-fund-r1-status.json`, LOOP = `${OUT}/desk-fund-r1-loop-state.json`, LOG = `${OUT}/desk-fund-r1.log`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJ = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const st = { pid: process.pid, started_at: new Date().toISOString(), passes: 0 };
const save = (o) => { Object.assign(st, o, { updated_at: new Date().toISOString() }); fs.writeFileSync(LOOP, JSON.stringify(st, null, 2) + "\n"); };
const others = () => otherSpenders(process.pid);
fs.writeFileSync(`${OUT}/desk-fund-r1-loop.pid`, `${process.pid}\n`);
fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), phase: "loop_start", pid: process.pid }) + "\n");
for (;;) {
  if (readJ(STATUS, {}).all_funded) { save({ state: "all_funded" }); break; }
  if (fs.existsSync(`${OUT}/r1-STOP`) || fs.existsSync(`${OUT}/r1-FUND-STOP`)) { save({ state: "paused_stopfile" }); await sleep(120000); continue; }
  const avail = (() => { try { return Number(fs.readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/)[1]) / 1024; } catch { return 1e9; } })();
  if (avail < 1000) { save({ state: "waiting_memory", avail_mb: Math.round(avail) }); await sleep(120000); continue; }
  // grace: if the tn10-million-test funder was sending recently (status 'running', updated < 10 min ago), give its owner time to restart it first
  { let m = null, age = 1e12; try { const P = "/workspace/artifacts/tn10-million-test/fund-status.json"; m = JSON.parse(fs.readFileSync(P, "utf8")); age = Date.now() - fs.statSync(P).mtimeMs; } catch {}
    if (m && m.state === "running" && age < 10 * 60000) { save({ state: "grace_million_test_recently_active", million_next_index: m.next_index, million_status_age_s: Math.round(age / 1000) }); await sleep(120000); continue; } }
  const o = others();
  if (o.length) { save({ state: "waiting_other_spender", waiting_for: o, next_check_in_s: 120 }); await sleep(120000); continue; }
  save({ state: "pass_running", waiting_for: [] });
  const code = await new Promise((res) => {
    const fd = fs.openSync(LOG, "a");
    const c = spawn(process.execPath, [`${SCRIPTS}/treasury-fund-r1.mjs`, "--floor-tkas", String(process.env.R1_FLOOR_TKAS || "20000")], { cwd: SCRIPTS, stdio: ["ignore", fd, fd] });
    const kill = setTimeout(() => { try { c.kill("SIGTERM"); } catch {} }, 90 * 60000);
    c.on("close", (code) => { clearTimeout(kill); fs.closeSync(fd); res(code); });
  });
  st.passes++;
  const last = (readJ(STATUS, {}).runs || []).at(-1) || {};
  save({ state: "sleeping", last_pass_exit: code, last_pass_state: last.state, last_pass_at: new Date().toISOString(), next_check_in_s: code === 9 ? 120 : 600 });
  if (readJ(STATUS, {}).all_funded) { save({ state: "all_funded" }); break; }
  await sleep(code === 9 ? 120000 : 600000);
}
