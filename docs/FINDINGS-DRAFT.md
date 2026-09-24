> Working log from the test box, kept as written (19 Sep to 24 Sep 2026, CEST). Addresses are public `kaspatest:` addresses. 64-hex values are commit/reveal transaction ids, labelled inline.

# kns / KasWare TN10 test findings (draft)

Date: 2026-09-19 (Europe/Brussels / CEST)

Scope: **testnet-10 only**. Do not touch mainnet. Do not stop miner farm on `:16211` or `/tmp/kaspa-data-tn10`.

## Endpoints that work (probed live)

Base: `https://api.knsdomains.org/tn10`

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/v1/domains/check` | Body `{ "domainNames": ["label.kas"], "address": "kaspatest:…" }` — **both fields required** |
| GET | `/api/v1/{domain}/owner` | e.g. `kaspa.kas` → owner + assetId |
| GET | `/api/v1/assets` | Query `owner`, `type=domain`, `page`, `pageSize` |
| GET | `/api/v1/primary-name/{owner}` | 404 if none |
| GET | `/api/v1/asset/{assetId}/detail` | OpenAPI documented |

OpenAPI: extracted from `https://apidoc.knsdomains.org/tn10/swagger-ui-init.js` → saved as `openapi-tn10-real.json` / `api/openapi-v0.1.4.json` (title KNS API 0.1.4).

Public TN10 balance/UTXO: `https://api-tn10.kaspa.org/addresses/<kaspatest:…>/balance` and `…/utxos`.

Local kaspad TN10 still running (`:16211` P2P, `:16210` gRPC, `:18210` JSON wRPC). HTTP JSON curl to `:18210` returned empty reply; prefer public API or wasm RpcClient for balances.

## Protocol (from STP-KAS/kns-spec PROTOCOL.md + KasWare HTML)

- Envelope: `<xonly_pubkey> OP_CHECKSIG OP_FALSE OP_IF <kns> <0> <payload> OP_ENDIF` (commit–reveal P2SH).
- Create payload (compact JSON): `{"op":"create","p":"domain","v":"<label>"}` — `v` is label **without** `.kas`.
- Reveal **output 0** must pay KNS protocol fee address.
- TN10 fee sink (docs): `kaspatest:qq9h47etjv6x8jgcla0ecnp8mgrkfxm70ch3k60es5a50ypsf4h6sak3g0lru` (also in `KNS-TN10-PAYMENT-ADDRESS.txt`).
- Fee table (visual/grapheme length): 1–2 → 4200 KAS; 3 → 2100; 4 → 525; **5+ → 35**; text inscription → 1. Hold ~**1.05×** domain fee extra (refunded unused).
- Indexer FCFS — losing reveal still pays fee. Check before create.
- KNS does **not** support ECDSA addresses.

## KasWare notes (STP-KAS + vendor)

- STP-KAS `wallet-integration` and kns-spec `KASWARE.md` / `WALLETS.md` are **withdrawn** (17 Sep 2026 desk disclaimer). Do not treat that GitHub as a wallet kit.
- Working reference still in kns-spec HTML: `docs/kasware.html`, `docs/kasware-create.html` (mainnet-oriented copy).
- Vendor: `window.kasware.buildScript({ type: "KNS", data })` → `{ script, p2shAddress }` (no popup).
- Then `submitCommitReveal(commit, reveal, script, networkId)` with amounts in **KAS** (not sompi). Reveal requires approval.
- Network id for TN10: KasWare maps `kaspa_testnet_10` → `"testnet-10"`.
- See `docs/KASWARE-CREATE-TN10.md` for TN10-substituted HTML flow.

## Wallets / balances (public only; no seeds/keys logged)

| Role | Address file | Balance (api-tn10, sompi) | TKAS approx |
|------|----------------|---------------------------|-------------|
| File labeled “primary” / `wallet-address.txt` | `kaspatest:qplk…pv7sn` | **0** | 0 |
| Seed-derived receive0 (`seed-derived-receive-0.txt`, BIP44 via kaspa-wasm XPrivateKey) | `kaspatest:qrw0…dwrt` | 43523466024 | ~435.23 |
| Backup fund (`backup-fund-address.txt`) — **smoke payer per steering** | `kaspatest:qz46…knsdd` | 11444927204715 | ~114449 |

Parent steering: primary has 0 TKAS → use **backup funded** address for smoke. Seed-derived receive0 also holds ~435 TKAS if a later path prefers that wallet; do not print seed.

Note: BIP44 from backup **mnemonic** did not match backup fund address in an earlier desk pass; hex key matched. Prefer KasWare’s own account or verified hex for that address.

## Domain check sample (live)

`smoke-kns-tn10-001.kas` / `smoke-kns-tn10-001.kas` style names returned `available: true` via POST domains/check (with a payer address). Prefer unique labels per run (timestamp suffix).

## Blockers for smoke

1. **Payer choice**: wallet-address.txt empty; smoke must use backup (or seed-derived receive0). KasWare extension must be unlocked on that account if using UI path.
2. **No headless KasWare** on this box — browser extension required for `buildScript` / `submitCommitReveal`, **or** a custom commit–reveal builder.
3. **kaspa-wasm 0.13.0 `ScriptBuilder`** on Node returned rust null-pointer on `addData`/`addOp` in this environment — programmatic envelope build not yet reliable here; dry-run script plans txs without broadcasting.
4. kns-spec KasWare HTML examples hardcode **mainnet** fee address + `mainnet` network string — must swap for TN10 (see TN10 HTML doc).
5. Local `:18210` JSON RPC not curl-friendly; use public explorer API or wasm RPC.

## Safety

- Mainnet not used. Miner/`/tmp/kaspa-data-tn10` left running.
- Seed/private keys never written to artifacts stdout files (only addresses + public JSON).

## Next

1. Run KasWare TN10 create HTML (or dry-run script then manual broadcast gate) for one available 5+ char label using **backup** payer.
2. Confirm indexer owner via GET `/api/v1/<name>/owner`.
3. Only then consider batch creates.

## Update 2026-09-19 19:40 CEST
- computerUse first pass: Chromium failed to start on agent display (`ECONNREFUSED 127.0.0.1:9240`); no KasWare UI inspection yet.
- `box-doctor` SUMMARY: 11 checks, 0 failed; later Chrome listening on `:9240`.
- Dry-run OK: `stp-smoke-1789839537.kas` available; fee 35 TKAS; payer backup `kaspatest:qz46…knsdd` balance ~114449 TKAS. Artifact: `api/dryrun-stp-smoke-1789839537.json`.
- GitHub: https://github.com/STP-KAS/kns-kasware-tn10-test/issues/1

## Smoke result (SUCCESS) — 2026-09-19 ~19:45 CEST

Domain: `stp-smoke-1789839537.kas`
Payer: `kaspatest:qz46xwjp2stquq20xjzguqg4wyqz0g08d3clr26tlkzcrvfv0j3nxmkaknsdd`
Commit: `8f7653815d0791dd0184161a1b909d6fa4b01760880c9b750bf99fb5170f04b7`
Reveal: `04daabc03fd4ce60fcad91967a7b033539e48b1aeb1d60b02dacca4f2334bf75`
Inscription id: `04daabc03fd4ce60fcad91967a7b033539e48b1aeb1d60b02dacca4f2334bf75i0`
Indexer owner match: yes (GET `/api/v1/.../owner` returned success within poll window).

Path: scripted via kaspa-wasm32-sdk **v2.0.1** + public Resolver wRPC (`wss://vector-10.kaspa.green/...`). npm `kaspa-wasm@0.13.0` ScriptBuilder is broken (null pointer).
KasWare browser UI: still not verified (Chrome/CDP flaky on agent display).

## KasWare on box browser (2026-09-19)

- https://tn10.knsdomains.org/ loads.
- Connect Wallet → Kasware: **“Connection failed — Kasware not found.”**
- Local `docs/kasware-create-tn10.html`: Inscribe → **“KasWare not injected.”**
- Extension not installed in box Chromium. Bulk/smoke use scripted wasm path instead.

## Bulk result 1–10 — 2026-09-19 19:55 CEST

- Ran `node scripts/kns-bulk-create.mjs --from 1 --to 10 --delay-ms 8000 --broadcast 1` on TN10 only; 10/10 child result artifacts contain completed creates with `revealId`; 0 failed and 0 already-taken.
- The bulk wrapper summary printed `ok: 0, fail: 10` because it parses the final line of the smoke script’s pretty-printed JSON; the per-create artifacts are authoritative for completion.
- Domains and reveal txids:
  - `stp-bulk-0001.kas` — `fec7433ee68d191d5a3f0df65365c20f3bcb678da5a0b048465784085d04fed0`
  - `stp-bulk-0002.kas` — `199476b313b7a4f2aa8ca16ba860384a5f218581f2b59fbfb4a19bdc3dc67a59`
  - `stp-bulk-0003.kas` — `c93ddc64d06fd83abff1674d3ada5536e23148dd419615787c6eb34a1d042cfd`
  - `stp-bulk-0004.kas` — `df9556b7ad7d42caf1e35f03720c7257d83865274c09c2abd41fe321f7c7dce6`
  - `stp-bulk-0005.kas` — `d0dc0344eea263ea0dd09f5b971a30b2f8c1658a9a86759bb2bb1759990fff9b`
  - `stp-bulk-0006.kas` — `59e168b183646324042e076f6a3a2ee0008b9b8c8dd96c141f96bc0f232b9a50`
  - `stp-bulk-0007.kas` — `df05a5aaad5b2e899f6ee6a40be1c362562a9d3c302c6fe0ca13534ff092ec8a`
  - `stp-bulk-0008.kas` — `69d26564e74cde7541b659845aaa12da42509f871a9be0bc4f94e0da4f981036`
  - `stp-bulk-0009.kas` — `03fb7c53ec53397864b27e78fbb54010c0598f7ef0d6cb63a317a4b785c4dd0b`
  - `stp-bulk-0010.kas` — `3557b325cdc594ac12349c2196996ce32f4223399665b8d0f2afa4397494814f`

## Bulk progress 11–50 — 2026-09-19 20:40 CEST

- TN10-only batch `stp-bulk-0011.kas` through `stp-bulk-0050.kas` completed: **40/40 ok, 0 failed**; all 40 per-create smoke result artifacts and reveal entries completed.
- Started next TN10-only batch 51–150 with `--delay-ms 8000 --broadcast 1`; stdout: `api/bulk-51-150-stdout.txt`.
- Miner on `:16211` remained running; no mainnet activity.

## Bulk progress 51–150 — 2026-09-19 22:00 CEST

- TN10-only batch `stp-bulk-0051.kas` through `stp-bulk-0150.kas` completed: **51/100 ok, 49 failed** (51 smoke result/reveal artifacts; 49 without revealId). Threshold not met; batch 151–350 was not started.

## Bulk race/backfill fix — 2026-09-19

- Batch 51–150 exposed intermittent bulk race failures: many creates had no result artifact or indexer 404 despite the TN10 node/miner remaining healthy.
- Hardened `scripts/kns-bulk-create.mjs` with per-attempt child logs, artifact/reveal-aware completion checks, and up to three attempts with a five-second retry gap; paced creates remain separated by the configured delay.
- Backfill of the missing labels is being run sequentially with the same broadcast-safe smoke path and a ten-second inter-domain gap.
- Backfill outcome: 46/48 recovered; 0134 and 0139 remained missing after three attempts because the remote wRPC disconnected.

## Bulk progress 151–350 — 2026-09-20 04:20 CEST

- Hardened TN10 batch `stp-bulk-0151.kas` through `stp-bulk-0350.kas` completed: **141/200 ok, 59 failed/missing**. Verified 0134 is present/OK; 0139 was missing and queued for retry. Sequential backfill for 0139 and the 151–350 gaps is running; 351–550 was held below the 180/200 threshold.

- Backfill completed: **200/200 ok** for 151–350 (including recovered gaps), 0139 now present/OK; started TN10 batch 351–550 with `--delay-ms 12000 --retries 3 --broadcast 1`.
KNS TN10 bulk 351-550: 200/200 ok, 0 fail after backfill; 551-750 started pid=294905; total bulk results 550/3000.

## Resume after Weekly Grok Bot reset — 2026-09-24 ~18:04 CEST

- Verified **750/3000** local smoke-result artifacts for `stp-bulk-0001`–`0750` (no gaps; all with `revealId`).
- First missing index: **751**. Backup funder balance ~88122 TKAS (public api-tn10).
- Reinstalled `npm-kaspa` deps (`websocket` missing after box reset); wasm smoke path OK (TN10 only).
- Started chained resume: `scripts/kns-bulk-chain-resume.sh 751 3000 250 12000` → batches of 250 with `--delay-ms 12000 --retries 3 --broadcast 1`.
- First creates OK: `stp-bulk-0751.kas` reveal `86c3b56d265f973359316d65aa12631aa820bc95d3a027127a4f25f17344d234`; 0752/0753 also OK; chain continuing through 3000.
- Miner farm on `:16211` / `kaspa-data-tn10` left running; no mainnet activity.
- Log: `api/bulk-chain-resume-0751-3000.log`; first batch stdout: `api/bulk-751-1000-stdout.txt`.
