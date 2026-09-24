# Updates

Newest first. Times Europe/Brussels.

## 24 Sep 2026

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
