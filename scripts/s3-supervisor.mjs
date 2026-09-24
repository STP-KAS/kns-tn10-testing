#!/usr/bin/env node
/**
 * Names per wallet: 3 for 700-10699 (d0-d2), 2 for 10700-20699 (d0-d1).
 * S3 supervisor: keeps up to MAX kns-snap-s3.mjs workers running over disjoint 500-wallet ranges (700-20699), in index order.
 * - MAX read each tick from snapshot-wallets/s3-max-workers (default 10) -> scale without restarting anything.
 * - A range is launched once its first wallet appears funded in desk-fund-700-20699-status.json (workers also wait per wallet).
 * - Dead worker without finished_at -> relaunched (resume; existing names are skipped), max 5 times per range.
 * - Finished worker with failures -> one retry pass later.
 * - If snapshot-wallets/s3-STOP exists: launches nothing new (never kills anything).
 * Uses no private keys itself.
 */
import fs from "node:fs"; import { spawn } from "node:child_process";
try { fs.writeFileSync("/proc/self/oom_score_adj", "500"); } catch {}
const OUT = "/workspace/artifacts/kns-tn10/snapshot-wallets", SCRIPTS = "/workspace/artifacts/kns-tn10/scripts";
const FROM = 700, TO = 20699, SIZE = 500;
const STATE = `${OUT}/s3-supervisor-state.json`, FUND = `${OUT}/desk-fund-700-20699-status.json`;
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const memAvailMb = () => { try { return Number(fs.readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/)[1]) / 1024; } catch { return 0; } };
const MIN_LAUNCH_AVAIL_MB = Number(process.env.S3_MIN_LAUNCH_AVAIL_MB || 1200); // only add a worker when the box has real headroom
const readJ = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const ranges = []; for (let f = FROM; f <= TO; f += SIZE) ranges.push({ from: f, to: Math.min(f + SIZE - 1, TO) });
const state = readJ(STATE, { ranges: {} });
for (const r of ranges) { const k = `${r.from}-${r.to}`; state.ranges[k] ||= { state: "pending", launches: 0, retry_pass: false, pid: null }; }
const save = () => { state.updated_at = new Date().toISOString(); fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n"); };
function launch(k) {
  const [f, t] = k.split("-");
  const fd = fs.openSync(`${OUT}/s3-stdout-${k}.log`, "a");
  const c = spawn(process.execPath, [`${SCRIPTS}/kns-snap-s3.mjs`, "--wallet-from", f, "--wallet-to", t, "--names", Number(f) >= 10700 ? "2" : "3", "--delay-ms", "12000", "--retries", "3"], { cwd: SCRIPTS, detached: true, stdio: ["ignore", fd, fd] });
  c.unref(); fs.closeSync(fd);
  fs.writeFileSync(`${OUT}/s3-${k}.pid`, `${c.pid}\n`);
  const s = state.ranges[k]; s.pid = c.pid; s.state = "running"; s.launches++; s.last_launch = new Date().toISOString();
  log({ phase: "launched", range: k, pid: c.pid, launches: s.launches });
}
fs.writeFileSync(`${OUT}/s3-supervisor.pid`, `${process.pid}\n`);
log({ phase: "supervisor_start", pid: process.pid, ranges: ranges.length });
for (;;) {
  const max = Math.max(0, Math.min(40, Number((() => { try { return fs.readFileSync(`${OUT}/s3-max-workers`, "utf8").trim(); } catch { return "10"; } })()) || 10));
  let running = 0;
  for (const [k, s] of Object.entries(state.ranges)) {
    if (s.state !== "running") continue;
    if (s.pid && alive(s.pid)) { running++; continue; }
    const st = readJ(`${OUT}/s3-status-${k}.json`, {});
    if (st.finished_at) {
      if (st.failed > 0 && !s.retry_pass) { s.state = "retry_pending"; s.retry_pass = true; log({ phase: "finished_with_failures", range: k, failed: st.failed }); }
      else { s.state = "done"; log({ phase: "range_done", range: k, ok: st.ok, failed: st.failed, taken: st.taken }); }
    } else { s.state = "crashed"; s.crashes = (s.crashes || 0) + 1; log({ phase: "worker_died", range: k, pid: s.pid, crashes: s.crashes, avail_mb: Math.round(memAvailMb()) }); }
  }
  const stop = fs.existsSync(`${OUT}/s3-STOP`);
  if (!stop && running < max && memAvailMb() >= MIN_LAUNCH_AVAIL_MB) {
    const funded = new Set(readJ(FUND, {}).funded_indices || []);
    // priority: crashed relaunch, then pending in index order, then retry passes
    const order = [...Object.entries(state.ranges).filter(([, s]) => s.state === "crashed"), ...Object.entries(state.ranges).filter(([, s]) => s.state === "pending"), ...Object.entries(state.ranges).filter(([, s]) => s.state === "retry_pending")];
    for (const [k] of order) {
      if (running >= max) break;
      const f = Number(k.split("-")[0]);
      if (state.ranges[k].state === "pending" && !funded.has(f)) break; // fund-order gate
      if (memAvailMb() < MIN_LAUNCH_AVAIL_MB) break;
      launch(k); running++; await sleep(20000);
    }
  }
  state.max_workers = max; state.running = running; state.stop_file = stop; save();
  if (Object.values(state.ranges).every((s) => s.state === "done" || s.state === "gave_up")) { log({ phase: "all_done" }); break; }
  await sleep(30000);
}
