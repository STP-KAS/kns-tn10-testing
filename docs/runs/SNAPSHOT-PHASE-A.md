> Run notes copied from the test box on 24 Sep 2026 (Europe/Brussels). Paths refer to the box layout. Logs, wallet files and secrets mentioned here are not in this repo. Secret paths are redacted.

# KNS TN10 snapshot wallets (Phase A)

## Purpose
200 distinct Testnet-10 addresses for KNS snapshot testing.
Naming for domains: `stp-snap-w###-d###` (wallet index + domain index).
Does **not** collide with the running `stp-bulk-*` chain.

## Artifacts (shareable)
| File | Contents |
|------|----------|
| `addresses.csv` | index, address, derivation_path — **safe to share with KNS team** |
| `wallets.jsonl` | index, address, paths to secrets (no raw keys) |
| `meta.json` | generation metadata |
| `faucet-fund-*.json*` | faucet claim log/status |
| `redistribute-log.jsonl` | internal top-ups from faucet haul |
| `snap-smoke-w###.json` | smoke results |
| `phase-a-*.json*` | Phase A progress |

## Secrets (never share / never paste in chat)
- Directory: `$KNS_TN10_SNAPSHOT_SECRETS_DIR` on the test box, outside any repo (chmod 700). Path redacted in this copy.
- Master BIP39 mnemonic + per-index privkeys JSONL (chmod 600)
- Derivation: BIP44 `m/44'/111111'/0'/0/{i}` on **testnet-10** (`kaspatest:` only)

## Faucet (`https://sixpack.wtf/faucet.html`)
- **HTTP API** (no captcha): `POST {FAUCET_API}/api/faucet` with JSON `{address, amount}`
- API base (from page): Cloudflare tunnel URL in `window.FAUCET_API`
- Headers: `content-type: application/json`, `Bypass-Tunnel-Reminder: true`
- Async jobs: poll `GET /api/faucet?job=...`
- **Drip / cap:** 30,000 tKAS per submit; **30,000 tKAS per IP and per address per 24h**
- `amount` in POST appears ignored for drip size (requested 150, received full 30,000)
- Faucet pay-from: `kaspatest:qzffl5xy9np46gkttyuftqnv2w04pr8g3wsp7c3vv8se3txtelx6q7c0v0ldx`
- Balance is large (~5M tKAS) but **public API IP cap** gates how much one desk IP can claim/day

## TKAS math (Phase A)
- KNS fee for labels ≥5 graphemes: **35 tKAS** / domain
- Phase A: 200 wallets × 100 domains × 35 ≈ **700,000 tKAS** (plus ~0.03 fee dust / domain)
- Per wallet budget used here: **~4,000 tKAS** (covers 100×35 + margin)

## Funding status (this run)
See `faucet-fund-status.json` and balances: one faucet claim funded wallet 0 with 30k;
redistributed 4,000 to wallets 1–6. Remaining 193 wallets await further faucet claims
(after IP window reset) or desk-side faucet coordination.

## Smoke
`stp-snap-w000-d000/001` and `stp-snap-w001-d000/001` — see `snap-smoke-w000.json`, `snap-smoke-w001.json`.

## Phase A runner
```bash
node /workspace/artifacts/kns-tn10/scripts/kns-snap-phase-a.mjs \
  --wallet-from 0 --wallet-to 6 --domain-from 0 --domain-to 99 \
  --delay-ms 12000 --broadcast 1
```
Leaves `stp-bulk-*` chain alone. Skips domains that already revealed.

## Regenerating wallets
```bash
node /workspace/artifacts/kns-tn10/scripts/gen-snapshot-wallets.mjs --count 200
```

## Phase B
- Phase B appends 500 new wallets, indices **200–699**, from the same master mnemonic and BIP44 derivation path.
- The Phase B set is Testnet-10 only; no funding is performed by wallet generation.
