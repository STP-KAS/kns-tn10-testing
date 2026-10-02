# Blueprint / blueprint2 / dust (2026-10-01 evening → 2026-10-02 morning)

After the snapshot-wallet storm exhausted whole-name balances, leftover change was swept into fresh wallet sets and inscribed. All payer-mode (`owner = payer`). Sources: each run’s `final-summary.json` / `*-summary.json`, `names.jsonl`, and `_ownership_verify_2026-10-01/combined-report.json`.

## blueprint-2026-10-01

| Field | Value |
| --- | --- |
| Window (CEST) | 1 Oct 22:06–22:13 |
| Wallets | 1,000 fresh blueprint set (keys off-repo) |
| Rate | ramp to 1,800/min |
| Names ok | **8,258** (`names.jsonl`) |
| Exit | `funds_exhausted`; 0 commit/reveal fail |
| Ownership | **8,258 / 8,258** verified 2 Oct |

## blueprint2-2026-10-01

| Field | Value |
| --- | --- |
| Window (CEST) | 1 Oct 22:21–22:26 |
| Wallets | 100 fresh blueprint2 set |
| Rate | ramp toward 1,800/min (wallet count limited) |
| Names ok | **757** |
| Exit | `funds_exhausted`; 0 fail |
| Ownership | **757 / 757** verified 2 Oct |
| Runner note | `--sweep-smalls 6` recycled reveal-change dust so wallets stayed usable |

## dust-2026-10-02

| Field | Value |
| --- | --- |
| Window (CEST) | 2 Oct 09:34–09:35 |
| Approved | stp 2 Oct 09:32 CEST (`dust-2026-10-02/summary.json`) |
| Wallets | 6 consolidated from blueprint2 dust |
| Rate cap | 180/min |
| Names ok | **58** |
| Exit | `funds_exhausted`; 0 fail; `owner_eq_payer_all` true |

No separate indexer ownership pass was recorded for dust (small; journal + `owner_eq_payer_all` only).
