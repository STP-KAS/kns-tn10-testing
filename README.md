> **Experimental only. Not a product.** Testnet-10 only. tKAS is worthless testnet coin.
>
> Do not use wallet integrations on this GitHub. STP remains a clown. [DISCLAIMER.md](DISCLAIMER.md)

# kns-tn10-testing

KNS (Kaspa Name Service) `.kas` domain inscriptions, tested on Kaspa Testnet-10 (TN10). What, why, how, and a running log.

Experimental. Not advice. Not Kaspa core. Not official KNS. Not mainnet. Keys never in this repo.

Log: [UPDATES.md](UPDATES.md). Older lab repo (19–23 Sep, first 750 names): [STP-KAS/kns-kasware-tn10-test](https://github.com/STP-KAS/kns-kasware-tn10-test).

## What

KNS names are inscriptions. A domain create is a commit–reveal pair on Kaspa L1:

- Envelope: `<xonly_pubkey> OP_CHECKSIG OP_FALSE OP_IF <kns> <0> <payload> OP_ENDIF` in a P2SH ([docs/kns-spec/PROTOCOL.md](docs/kns-spec/PROTOCOL.md)).
- Payload: `{"op":"create","p":"domain","v":"<label>"}` (label without `.kas`).
- Commit locks 1 tKAS in the P2SH. Reveal spends it; **output 0 pays the KNS fee** to the TN10 sink `kaspatest:qq9h47etjv6x8jgcla0ecnp8mgrkfxm70ch3k60es5a50ypsf4h6sak3g0lru`.
- Fee by grapheme length: 1–2 → 4200, 3 → 2100, 4 → 525, 5+ → 35 tKAS. Text inscription → 1.
- Uniqueness is the KNS indexer, first valid reveal wins. A losing reveal still pays.

What was tested on TN10 (all scripted, no wallet UI):

| Run | Names | Payer | Scripts |
| --- | --- | --- | --- |
| Smoke | `stp-smoke-1789839537.kas` | one funded test address | `kns-create-dryrun.mjs`, `kns-smoke-create.mjs` |
| Bulk | `stp-bulk-0001` … `stp-bulk-3000` (target) | same single address, paced | `kns-bulk-create.mjs`, `kns-bulk-chain-resume.sh` |
| Snapshot Phase A | `stp-snap-w###-d###`, wallets 0–699, up to 100 names each | many distinct derived addresses | `kns-snap-smoke.mjs`, `kns-snap-phase-a.mjs`, `kns-snap-pool.mjs`, `phase-a-*.sh` |
| S3 | `stp-s3-w#####-d#`, wallets 700–20699, 3 or 2 names each (50,000 target) | one name per child process | `kns-snap-s3.mjs`, `kns-s3-create.mjs`, `s3-supervisor.mjs` |
| R1 | one random name, length 3–10, per wallet 20700–25699 (5,000 target) | includes 3- and 4-char fee tiers | `gen-r1-names.mjs`, `kns-snap-r1.mjs`, `r1-supervisor.sh` |

APIs used:

- KNS indexer TN10: `https://api.knsdomains.org/tn10/api/v1` (`POST /domains/check`, `GET /{domain}/owner`, `GET /assets`, `GET /primary-name/{owner}`). OpenAPI 0.1.4 extracted from `https://apidoc.knsdomains.org/tn10/`: [api/openapi-tn10.json](api/openapi-tn10.json).
- Balances/UTXOs: `https://api-tn10.kaspa.org/addresses/<addr>/balance`.
- Signing and submit: `kaspa-wasm32-sdk` **v2.0.1** (Node) over the public TN10 Resolver wRPC. npm `kaspa-wasm@0.13.0` `ScriptBuilder` hit a null-pointer on this box, so it is not used for the envelope.

## Why

From the run notes, not a mission statement:

- **Conformance.** Check that a script built only from [kns-spec](https://github.com/STP-KAS/kns-spec) (`PROTOCOL.md`, `CONFORMANCE.md`) and the KNS docs produces creates the official TN10 indexer accepts: fee output 0, grapheme pricing, `domains/check` before every create.
- **Wallet behaviour.** The KasWare path (`buildScript` → `submitCommitReveal`) was the intended reference. On the box, KasWare was not injected, so the wallet UI stayed unverified and the scripted path was used ([docs/KASWARE-CREATE-TN10.md](docs/KASWARE-CREATE-TN10.md)).
- **Load and bulk behaviour.** Pace thousands of creates from one payer and from many payers, and see where the public node, the indexer and the create code break.
- **Snapshot testing.** Thousands of distinct holder addresses with names. The snapshot `addresses.csv` is marked shareable with the KNS team; it is not published here.
- **Find bugs before mainnet.** Several were found (see Results). Smoke first, then scale: "Do not scale until smoke green" ([SMOKE-PLAN.md](SMOKE-PLAN.md)).

### Why now: KNS team status

Official [@knsdomain](https://x.com/knsdomain) posts ([post 1](https://x.com/knsdomain/status/2101290557821899234), [post 2](https://x.com/knsdomain/status/2098591421825794299)):

> We just successfully tested .kas registration on Covenant TN10 today~
>
> KNS Covenant UI/UX Redesign, around 80% completed. A teaser will come out soon!
>
> Airdrop/ Claim mechanism WIP
>
> Kaspire Wallet on TN10/ MN soon
>
> — @knsdomain

KNS is moving `.kas` registration onto covenants on Testnet-10, with a redesigned UI, a claim/airdrop mechanism, and the Kaspire wallet coming to TN10 and mainnet. Independent testing on TN10 now helps catch problems before mainnet. The runs here use the current inscription path, not the covenant path.

## How

Nothing here is needed to use KNS. It is how this desk ran the tests. Scripts assume the box layout `/workspace/artifacts/kns-tn10/` (`scripts/`, `api/`, `snapshot-wallets/`, `npm-kaspa/`, `wasm-sdk/`). Adjust paths if you copy them.

### 1. Prerequisites

- Node 20 (tested v20.19.2), `websocket` npm package (in `npm-kaspa/`), `kaspa-wasm32-sdk-v2.0.1` unzipped to `wasm-sdk/kaspa-wasm32-sdk/`.
- A TN10 node is optional. The box runs local TN10 kaspad + miners, but they run without `--utxoindex`, so creates use the public Resolver wRPC and `api-tn10.kaspa.org`.
- A TN10 (`kaspatest:`) Schnorr address. KNS does not support ECDSA addresses.

### 2. Keys (env only)

Published scripts contain no keys. Secret paths were replaced by env vars:

| Env var | Used by | Holds |
| --- | --- | --- |
| `BACKUP_PRIVKEY_FILE` | `kns-smoke-create.mjs`, `kns-snap-create.mjs`, `kns-s3-create.mjs` | path to a file with one TN10 hex key. Required, no default |
| `KNS_TN10_SNAPSHOT_SECRETS_DIR` | `gen-snapshot-wallets.mjs`, `kns-snap-*.mjs` | dir for the snapshot mnemonic + per-index key JSONL (chmod 700, outside any repo) |
| `KNS_TN10_TREASURY_KEY` | `treasury-fund-desk/s3/r1.mjs` | treasury hex key or mnemonic |
| `KNS_TN10_TREASURY_MNEMONIC_FILE` | `treasury-fund-snapshot.mjs` | path to treasury mnemonic file |
| `FAUCET_API` | `faucet-fund-snapshot.mjs` | faucet API origin (see `window.FAUCET_API` on the faucet page) |

Never paste keys in chat, logs or commits. `.gitignore` blocks the usual key and wallet files.

### 3. Fund with tKAS

- Faucet: [sixpack.wtf/faucet.html](https://sixpack.wtf/faucet.html). JSON API, 30,000 tKAS drip, cap 30,000 tKAS per IP and per address per 24 h ([docs/runs/FAUCET-FINDINGS.md](docs/runs/FAUCET-FINDINGS.md)). `faucet-fund-snapshot.mjs` claims for a range of snapshot addresses.
- `faucet-tn10.kaspanet.io` returned a Cloudflare challenge (HTTP 403) from the box.
- Large runs were funded from a treasury address with `treasury-fund-*.mjs` (batched outputs, balance re-checks, floor, dry-run flag).
- Hold about 1.05× the fee per name. Measured network cost is about 0.035 tKAS per name on top of the KNS fee.

### 4. Smoke test

Follow [SMOKE-PLAN.md](SMOKE-PLAN.md):

```bash
curl -sS "https://api-tn10.kaspa.org/addresses/<PAYER>/balance"
curl -sS -X POST https://api.knsdomains.org/tn10/api/v1/domains/check \
  -H 'content-type: application/json' \
  -d '{"domainNames":["stp-smoke-XXXX.kas"],"address":"<PAYER>"}'
node scripts/kns-create-dryrun.mjs --label stp-smoke-XXXX --payer <PAYER>      # dry run, no signing
BACKUP_PRIVKEY_FILE=/path/outside/repo/key.hex \
  node scripts/kns-smoke-create.mjs --label stp-smoke-XXXX --broadcast 0         # plan only
# --broadcast 1 submits commit + reveal (TN10 only)
curl -sS https://api.knsdomains.org/tn10/api/v1/stp-smoke-XXXX.kas/owner
```

Each create writes `api/smoke-result-<label>.json` (domain, payer, commit/reveal tx ids, inscription id `<revealId>i0`, fee, time).

### 5. Bulk

```bash
node scripts/kns-bulk-create.mjs --from 1 --to 10 --delay-ms 12000 --retries 3 --broadcast 1
scripts/kns-bulk-chain-resume.sh 751 3000 250 12000   # batches of 250, no idle gaps
```

### 6. Snapshot runs

```bash
node scripts/gen-snapshot-wallets.mjs --count 200 --secrets "$KNS_TN10_SNAPSHOT_SECRETS_DIR"   # BIP44 m/44'/111111'/0'/0/i
node scripts/kns-snap-smoke.mjs --wallet 0 --domain-from 0 --domain-to 1 --broadcast 0
node scripts/kns-snap-pool.mjs --wallet-from 7 --wallet-to 249 --lanes 10 --domain-from 0 --domain-to 99 --delay-ms 12000 --broadcast 1 --retries 3
node scripts/s3-supervisor.mjs          # S3 workers over 500-wallet ranges
node scripts/gen-r1-names.mjs && scripts/r1-supervisor.sh   # R1
```

Run notes: [Phase A](docs/runs/SNAPSHOT-PHASE-A.md), [S3](docs/runs/S3.md), [R1](docs/runs/R1.md). Stop files (`s3-STOP`, `r1-STOP`) stop new work between names, never mid commit/reveal.

### 7. Monitor

- `node scripts/phase-a-monitor.mjs --window-min 5`, `scripts/s3-progress.sh`, `scripts/r1-progress.sh` (read-only, no secrets).
- `node scripts/rebuild-inscriptions-digest.mjs` rebuilds the digest from `api/smoke-result-*.json`.
- `python3 scripts/export-results-csv.py` writes [results/inscriptions.csv](results/inscriptions.csv) (public fields only; refuses files with unexpected fields).

## Results so far

Counts below come from [results/inscriptions.csv](results/inscriptions.csv), exported from the box's `api/smoke-result-*.json` at **24 Sep 2026 23:07 CEST**. Each row has a commit tx id and a reveal tx id recorded by the create script. Runs were still going at export time, so these numbers are a floor.

| Run | Creates with reveal tx | Notes |
| --- | --- | --- |
| Smoke | 1 | `stp-smoke-1789839537.kas`, 19 Sep ~19:45 CEST, indexer owner matched |
| Bulk | 1,126 | `stp-bulk-0001`–`1126`, no gaps. Target 3,000. Batch 1001–1250 running since 21:30 CEST |
| Snapshot Phase A | 4,580 | across 129 wallets; 9 wallets have all 100 |
| S3 | 693 | across 234 wallets; target 50,000. All 60,000 candidate names pre-checked available (`s3-name-precheck.json`, 21:40 CEST) |
| R1 | 85 | incl. 16 three-char (2,100 tKAS) and 10 four-char (525 tKAS). 380 of 5,000 wallets funded at 23:07 CEST |
| **Total** | **6,485** | |

Indexer check: 23 Sep, `stp-bulk-0001`–`0750` all returned an owner from the TN10 indexer (750/750, [older repo](https://github.com/STP-KAS/kns-kasware-tn10-test)). Names after that were not re-checked for this publication.

Findings ([docs/FINDINGS-DRAFT.md](docs/FINDINGS-DRAFT.md), run notes):

1. `POST /domains/check` needs both `domainNames` and `address`. It has no price field; only `available` and `isReservedDomain`.
2. npm `kaspa-wasm@0.13.0` `ScriptBuilder` null-pointers on `addData`/`addOp` in Node here. `kaspa-wasm32-sdk` v2.0.1 works.
3. KasWare extension not installed in the box browser: `tn10.knsdomains.org` said "Kasware not found". Wallet UI path unverified.
4. kns-spec KasWare HTML examples hardcode mainnet fee address and network string; TN10 needs substitution.
5. Bulk 51–150 first pass: 51/100 ok. Race failures (no artifact, indexer 404). Fixed with per-attempt logs, artifact-aware completion and up to 3 retries; gaps backfilled. 151–350: 141/200 first pass, 200/200 after backfill. 351–550: 200/200 after backfill.
6. The first bulk wrapper printed `ok: 0, fail: 10` while all 10 creates succeeded (it parsed the last line of pretty-printed JSON).
7. Retrying against a lagging public node caused "already spent" reveals and stranded commits. `kns-s3-create.mjs` reuses a stranded P2SH commit and builds the reveal from the commit's own change output on the same RPC node.
8. The TN10 indexer is more lenient than the kns-spec label regex (accepts leading/trailing hyphens). R1 uses the stricter set.
9. Faucet caps (30,000 tKAS / IP / 24 h) gate large runs; the box also hit the OOM killer, so workers pause on low memory.

## Safety

- Testnet-10 only. No mainnet transactions. tKAS is worthless.
- No private keys, seeds, mnemonics, xprv, wallet files, key CSVs, `.env` or tokens in this repo. Scripts read keys from env vars at runtime and never print them.
- 64-hex strings in this repo are transaction ids (commit/reveal) or inscription ids, labelled as such.
- `kaspatest:` addresses shown are public.
- Scripts with `--broadcast 1` spend tKAS. Default is plan-only where supported.

## Links

- KNS TN10 site: https://tn10.knsdomains.org/
- KNS TN10 indexer: https://api.knsdomains.org/tn10 · API docs: https://apidoc.knsdomains.org/tn10/
- KNS docs: https://kns-2.gitbook.io/kns-docs-1/
- Protocol reference: [STP-KAS/kns-spec](https://github.com/STP-KAS/kns-spec) (copies in [docs/kns-spec/](docs/kns-spec/))
- Older lab: [STP-KAS/kns-kasware-tn10-test](https://github.com/STP-KAS/kns-kasware-tn10-test)
- Front door: [STP-KAS/kaspa-dapps](https://github.com/STP-KAS/kaspa-dapps) · pins: [STP-KAS/kaspa-master-file](https://github.com/STP-KAS/kaspa-master-file)
- TN10 faucet: https://sixpack.wtf/faucet.html

---

> Intentions are good; thought process is questionable. STP remains delusional.
>
> X: https://x.com/StppStp · GitHub: https://github.com/STP-KAS
