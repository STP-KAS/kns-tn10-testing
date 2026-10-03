# Updates

Newest first. Times Europe/Brussels.

## 3 Oct 2026 ~20:20 CEST

- Nightly refresh: [results/inscriptions.csv](results/inscriptions.csv) still **154,568** creates with reveal tx (no new creates since funded run ended 12:52 CEST 2 Oct). Newest unchanged: `eukjsfzxl.kas`. Sources: CSV `run` column; `api/smoke-result-*.json` count 154568; digest `api/inscriptions-digest-compact.txt` (`count` 154568, generated 20:59 CEST 2 Oct).
- **Trickle transfer run finished** overnight (2 Oct 21:58 – 3 Oct 01:06 CEST): **26,230** accepted domain transfers across **11,134** unique names from the funded-2026-10-02 100-wallet set (final session 17,118 ops). Exit `storm_stop_file`; 8 commit fails / 0 reveal fails. Fees 602.996 tKAS. Sources: `trickle-2026-10-02/summary.json`, `transfers.jsonl` (26230 lines). Creates not affected. Run notes: [docs/runs/TRICKLE-2026-10-02.md](docs/runs/TRICKLE-2026-10-02.md).
- Added sanitized transfer scripts: `scripts/kns-trickle.mjs`, `kns-trickle-start.sh`, `kns-trickle-watchdog.py`, `kns-trickle-derive-dust-view.mjs`, `kns-trickle-topup-lookup.mjs`.

## 2 Oct 2026 ~20:16 CEST

- Nightly refresh after the 1–2 Oct storm chain: [results/inscriptions.csv](results/inscriptions.csv) now **154,568** creates with reveal tx (prior 124,586 + storm 9,509 + blueprint 8,258 + blueprint2 757 + dust 58 + funded 11,400). Newest: `eukjsfzxl.kas` 12:52:59 CEST 2 Oct. Sources: CSV `run` column; `storm-2026-10-01/final-summary.json` (`names_ok_this_run` 9509); `blueprint-2026-10-01/final-summary.json` (8258); `blueprint2-2026-10-01/final-summary.json` (757); `dust-2026-10-02/final-summary.json` (58); `funded-2026-10-02/final-summary.json` (11400). Export allows public `owner` / `run_id` fields from the storm runner.
- Storm **ran** 1 Oct 21:46–21:54 CEST (after the 20:21 prep note): payer-mode on snapshot leftovers, rate ramped 30→3600/min, exit `funds_exhausted`, 0 fails. Then blueprint (8,258) and blueprint2 (757) the same evening; dust (58) and funded (11,400 at 180/min) on 2 Oct. Ownership verify 2 Oct midday: storm/blueprint/blueprint2 **all expected / 0 missing / 0 wrong** (`_ownership_verify_2026-10-01/combined-report.json`). Run notes: [docs/runs/STORM-2026-10-01.md](docs/runs/STORM-2026-10-01.md), [BLUEPRINT-2026-10-01.md](docs/runs/BLUEPRINT-2026-10-01.md), [FUNDED-2026-10-02.md](docs/runs/FUNDED-2026-10-02.md).
- Updated sanitized `scripts/kns-storm-runner.mjs` (run-dir / run-id / wallet-meta / live feerate / control.json / `--sweep-smalls` / HARD_CAP 6000) and `scripts/export-results-csv.py` (`owner`/`run_id` allowed; storm runs classified by `run_id` or via).

## 1 Oct 2026 ~20:21 CEST

- Nightly refresh: [results/inscriptions.csv](results/inscriptions.csv) still **124,586** creates with reveal tx (smoke 1, bulk 1,518, Phase A 69,856, S3 50,000, R1 3,211). Newest create unchanged: `stp-bulk-1518` 26 Sep 09:51 CEST. Sources: CSV run column; digest `api/inscriptions-digest-compact.txt` (`count` 124586); R1 `r1-done/` 3,211. No new creates since the 26 Sep stress stop.
- Storm runner **prepared, not started** (broadcast off). Offline dry-runs finished under `storm-2026-10-01/` (leftover snapshot-wallet funds only; treasury address hard-blocked as input). Payer-mode exhaustion dry-run: **9,511** built / 0 build failures / all signed (`dryrun-exhaustion-payer-mode-status.json`, `used_labels_loaded` 124586, `broadcast` false). Split-mode exhaustion (opt-in, attribution unproven): 17,816 built (`dryrun-exhaustion-split-mode-status.json`). Funds snapshot 1 Oct 18:42 CEST: **652,695.45** tKAS across 23,931 wallets with balance (`funds-summary.json`). Run notes: [docs/runs/STORM-2026-10-01.md](docs/runs/STORM-2026-10-01.md).
- Added/updated sanitized scripts: `kns-storm-runner.mjs`, `kns-storm-start.sh`, `kns-storm-stop.sh`, `kns-storm-summary.mjs`, `kns-storm-funds-inventory.mjs`; minor `rebuild-inscriptions-digest.mjs` fix (ignore own pgrep shell when detecting chain-resume).

## 26 Sep 2026 ~20:12 CEST

- Nightly refresh: [results/inscriptions.csv](results/inscriptions.csv) and README results now **124,586** creates with reveal tx (smoke 1, bulk 1,518, Phase A 69,856, S3 50,000, R1 3,211). Newest create 09:51 CEST (`stp-bulk-1518`). Sources: CSV run column; S3 pool `s3-status-pool-700-20699.json`; Phase A `phase-a-status*.json`; R1 `desk-fund-r1-status.json` / `r1-done/` (3,211).
- ~07:43–09:51 CEST: fast stress relaunch (user instruction) superseded the 25 Sep slow-pace cap. Fee multiplier 7× (`KNS_FEE_MULT=7`), indexer pre-check skipped during the window (`KNS_SKIP_INDEXER=1`), pools scaled up then backed off. S3 **hit its 50,000 target**; Phase A reached 69,856 across 699 wallets. Marker: `snapshot-wallets/FAST-RELAUNCH-ACTIVE`.
- Ownership verify (read-only, post-window): **79,764 / 79,764** storm-day names owned by expected payer, 0 missing / 0 other (`ownership-verify-summary-2026-09-26.json`).
- Added/updated sanitized scripts from the stress window: `kns-s3-pool.mjs`, `kns-snap-pool.mjs`, `kns-snap-r1.mjs`, `kns-smoke-create.mjs` (fee mult + stranded P2SH reuse), `kns-slow-runner.sh` / `kns-stop-fast.sh` (FAST-RELAUNCH guard), `r1-fund-loop.mjs`, plus helpers `scale-relaunch.sh`, `treasury-balance.mjs`, `treasury-halt-watch.sh`, `indexer-lag-sampler.sh`, `explorer-snap.sh`, `cdp.py`, `ownership_verify_storm_2026_09_26.py`.

## 25 Sep 2026 ~20:13

- Nightly refresh: [results/inscriptions.csv](results/inscriptions.csv) and README results now **44,812** creates with reveal tx (smoke 1, bulk 1,341, Phase A 28,837, S3 13,723, R1 910). Newest create 20:07 CEST (`stp-s3-w01013-d2`). Slow S3 runner still going (≤2 creates / 10 min).
- Added sanitized scripts from the slow-pace switch: `kns-slow-runner.sh`, `kns-stop-fast.sh`, `kns-s3-pool.mjs`, `kns-stranded-check.mjs`, `kns-all-monitor.mjs`, `s3-ramp-after-phase-a.sh`.

## 25 Sep 2026

- ~02:00: switched to a slow pace. The fast runners (bulk, Phase A, S3, R1 pools) were stopped gracefully (all stopped by 02:16), and one slow runner continues the S3 queue at **at most 2 creates per 10 minutes** across all runners (5 min pause after every name, reveal must be accepted before the next). Miners untouched.
- 06:01: [kns-spec/snapshot-tn10/holders-with-names.csv](https://github.com/STP-KAS/kns-spec/blob/main/snapshot-tn10/holders-with-names.csv) refreshed, straight from the per-create result records: **6,693** of 25,700 snapshot addresses hold at least one name, **43,303** names in total (Phase A `stp-snap-*` 28,837, S3 `stp-s3-*` 13,556, R1 random 910). Wallet number in every Phase A / S3 name matches the address index (0 mismatches). Read-only owner sample on the TN10 indexer: 45/45 match. Bulk (1,341) and smoke (1) names sit on a separate, non-snapshot address. Counts are a minimum while the slow runner continues.
- New: [kns-spec/snapshot-tn10/TESTING-SNAPSHOT.md](https://github.com/STP-KAS/kns-spec/blob/main/snapshot-tn10/TESTING-SNAPSHOT.md), our recommendation to the KNS team on how a snapshot works best for testing (freeze point + file hash, what to include, test categories incl. 0-name controls, claim/edge/scale/reorg tests, and what we can do on our side). Keys stay with us.

## 24 Sep 2026

- Report for KNS: [FOR-KNS.md](FOR-KNS.md). This lab against [kns-dotk](https://github.com/STP-KAS/kns-dotk), plus DOTK news through 23 Sep (SDK 2.0.0, subnames as card records, `url` → `<name>.kaspa.name`). Smoke plan unit corrected to tKAS.
- 23:20: snapshot `addresses.csv` (25,700 `kaspatest:` addresses, BIP44 `m/44'/111111'/0'/0/{i}`) shared with the KNS team at [STP-KAS/kns-spec/snapshot-tn10](https://github.com/STP-KAS/kns-spec/tree/main/snapshot-tn10), with `holders-with-names.csv`: 1,048 addresses hold at least one name, 7,614 names in total (joined on payer address from `results/inscriptions.csv`). Keys and mnemonic not published.
- 23:20: `results/inscriptions.csv` refreshed: 8,758 creates with reveal tx (bulk 1,143, Phase A 6,207, S3 791, R1 616, smoke 1). README results updated.
- Repo published. README (what, why, how, results), sanitized scripts, kns-spec copies, run notes, TN10 OpenAPI, results CSV.
- Added "Why now: KNS team status" with the @knsdomain posts ([1](https://x.com/knsdomain/status/2101290557821899234), [2](https://x.com/knsdomain/status/2098591421825794299)): covenant `.kas` registration tested on TN10, UI/UX redesign ~80%, airdrop/claim WIP, Kaspire wallet on TN10/mainnet soon.
- State at 23:07 CEST, from `results/inscriptions.csv` (6,485 creates with reveal tx):
  - Bulk: `stp-bulk-0001`–`1126`, no gaps. Chain resume 751→3000 restarted 18:04 after the weekly pause; batch 751–1000 finished 21:30; 1001–1250 running.
  - Snapshot Phase A (`stp-snap-*`): 4,580 names over 129 wallets. Started ~20:14.
  - S3 (`stp-s3-*`): 693 names over 234 wallets. Target 50,000. Started ~21:39.
  - R1 (random names, 3–10 chars): 85 names, first ~23:05. 380 of 5,000 wallets funded.
- 25,700 snapshot addresses generated (BIP44 TN10, keys kept off-repo).

## 20–23 Sep 2026

- Paused 20 Sep for the weekly Grok Bot pool reset. 23 Sep recheck: `stp-bulk-0001`–`0750` all indexed (750/750). See [STP-KAS/kns-kasware-tn10-test](https://github.com/STP-KAS/kns-kasware-tn10-test).

## 19 Sep 2026

- Smoke `stp-smoke-1789839537.kas` created and indexed (~19:45).
- Bulk 1–10, 11–50 ok. 51–150 exposed race failures; bulk script hardened and gaps backfilled. Through 20 Sep: 1–550 complete, 551–750 started.
