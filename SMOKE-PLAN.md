# Smoke plan — one KNS domain create on TN10

**Network:** testnet-10 only. **Broadcast:** gated; default dry-run.

**Payer (steering):** backup funded address in `backup-fund-address.txt` (~114k TKAS). Do not use empty `wallet-address.txt` (0 TKAS). Optional alternate: `seed-derived-receive-0.txt` (~435 TKAS).

**Fee sink:** `kaspatest:qq9h47etjv6x8jgcla0ecnp8mgrkfxm70ch3k60es5a50ypsf4h6sak3g0lru`

**Suggested label:** `stp-smoke-<unix>.kas` (5+ graphemes → **35 tKAS** fee; hold ≥ ~36.75 tKAS).

## Exact steps

1. **Balance**  
   `curl -sS "https://api-tn10.kaspa.org/addresses/<PAYER>/balance"`  
   Require balance ≫ 35e8 sompi + fees.

2. **Availability**  
   ```bash
   curl -sS -X POST 'https://api.knsdomains.org/tn10/api/v1/domains/check' \
     -H 'content-type: application/json' \
     -d '{"domainNames":["stp-smoke-XXXX.kas"],"address":"<PAYER>"}'
   ```  
   Proceed only if `available: true` and `isReservedDomain: false`.

3. **Dry-run plan (no broadcast)**  
   ```bash
   node scripts/kns-create-dryrun.mjs --label stp-smoke-XXXX --payer <PAYER>
   ```  
   Writes `api/dryrun-<label>.json` with payload, fees, commit/reveal skeleton. Exit if check fails.

4. **Inscribe (pick one)**  
   - **A. KasWare UI:** open `docs/kasware-create-tn10.html` in a browser with KasWare on testnet-10, payer account selected. Check → Inscribe. Approve reveal popup.  
   - **B. Programmatic:** only after a working ScriptBuilder/commit–reveal signer exists; still require explicit `BROADCAST=1`.

5. **Wait / verify**  
   - Note `revealIds[0]` (inscription id typically `${revealId}i0`).  
   - `GET https://api.knsdomains.org/tn10/api/v1/<name>/owner` → must equal payer.  
   - `GET .../api/v1/assets?owner=<PAYER>&type=domain`.

6. **Log** txids, errors, indexer lag into `FINDINGS-DRAFT.md`.

7. **Stop** after one success. Do not scale until smoke green.

## Non-goals

- No mainnet. No stopping `:16211` / `/tmp/kaspa-data-tn10`. No seed/key logging.
