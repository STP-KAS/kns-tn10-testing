# Inscription protocol

Source of truth (official):

- Inscriptions: https://kns-2.gitbook.io/kns-docs-1/inscriptions/overview
- Ops: https://kns-2.gitbook.io/kns-docs-1/inscriptions/operations
- Indexer API: https://kns-2.gitbook.io/kns-docs-1/kns-indexer-api
- Integration: https://kns-2.gitbook.io/kns-docs-1/kns-indexer-api/integration-important-note
- Wallets: https://kns-2.gitbook.io/kns-docs-1/supporting-wallet
- L1 indexer used by the resolver: https://github.com/supertypo/simply-kaspa-indexer

This file is the copy a wallet can implement without hunting. Wallets: [`WALLETS.md`](WALLETS.md). Indexers: [`INDEXER.md`](INDEXER.md). Overlay (`kns://`): [`OVERLAY.md`](OVERLAY.md).

## Envelope

Protocol id: `kns`. Commit-reveal P2SH. Same family as KRC-20.

```
<xonly_pubkey> OP_CHECKSIG OP_FALSE OP_IF <kns> <0> <payload> OP_ENDIF
```

KasWare builds this with `buildScript({ type: "KNS", data })`. Hardware (Tangem) uses ECDSA instead of Schnorr; the envelope is the same.

Mime / file inscriptions use a different inner layout (`OP_1 OP_1 <mime> <0> <hex>`). Domain ops below are JSON.

Max envelope 520 bytes. Label max 255 chars. ENS-normalize (`@adraffy/ens-normalize`). Visual length for price is grapheme length (`graphemer`). Emoji domains cannot be priced with UTF-16 `length`.

## Ops

| op | payload | When |
| --- | --- | --- |
| create | `{"op":"create","p":"domain","v":"<label>"}` | Register. `s` optional TLD, default `kas`. |
| transfer | `{"op":"transfer","p":"domain","id":"<inscriptionId>","to":"<kaspa addr>"}` | Owner change. `p` may be omitted for non-domain assets. |
| list | `{"op":"list","p":"domain","id":"<inscriptionId>"}` | Marketplace listing. |
| send | `{"op":"send","id":"<inscriptionId>"}` | Fill a listing. Previous outpoint must be a valid list. |

`p` is `"domain"`. `v` is the label **without** `.kas`. Compact JSON (`JSON.stringify(obj, null, 0)`).

Create of `example.kas`:

```json
{"op":"create","p":"domain","v":"example"}
```

Proven on mainnet: `kns.kas` used exactly `{"op":"create","p":"domain","v":"kns"}` in reveal `223233acf8e5abea9291627a5edd859439c4553100c71309b86599f02414a532`.

## Fees (reveal output 0)

Pay the protocol address **as output 0 of the reveal**.

| Network | Address |
| --- | --- |
| mainnet | `kaspa:qyp4nvaq3pdq7609z09fvdgwtc9c7rg07fuw5zgeee7xpr085de59eseqfcmynn` |
| tn10 | `kaspatest:qq9h47etjv6x8jgcla0ecnp8mgrkfxm70ch3k60es5a50ypsf4h6sak3g0lru` |

| Visual length | KAS |
| --- | ---: |
| 1–2 | 4200 |
| 3 | 2100 |
| 4 | 525 |
| 5+ | 35 |
| text inscription | 1 |

No renewal. First-come, first-served. Check availability **before** inscribing.

Wallet must hold extra KAS or inscribe fails “insufficient funds”: **domain × 1.05**, **text × 2** (unused extra is refunded).

Numeric clubs (official): 99 = `0.kas`–`99.kas` (leading zeros excluded except `0.kas`); 999 = `100`–`999`; 10k = `1000`–`9999`.

Reserved list (launch merkle root `09f78e4cc57ef2837e2d364b359f88da58c19b64cd79cdb1655b996ef14afcf7`): https://kns-2.gitbook.io/kns-docs-1/others/reserved-list

KNS does **not** support ECDSA addresses.

`POST https://api.knsdomains.org/mainnet/api/v1/domains/check` `{ "domainNames": ["example.kas"], "address": "<payer>" }`

## Resolve

URL-encode the name.

```
GET  /api/v1/{domain}/owner
GET  /api/v1/assets?owner=&asset=&type=domain
GET  /api/v1/asset/{assetId}/detail
GET  /api/v1/domain/{assetId}/profile?keys=redirectUrl,bio,avatarUrl,website,x,github,telegram,discord,email,banner
GET  /api/v1/primary-name/{owner}
POST /api/v1/domain/primary-name
```

Bases: `https://api.knsdomains.org/mainnet` and `/tn10`. OpenAPI: `https://apidoc.knsdomains.org/mainnet/`.

Before sending KAS to a resolved name, show: the address is indexer-derived, not consensus. Verify it. Transfers cannot be reversed.

## Profile

Each field is a **separate text inscription** (1 KAS), not a domain JSON op. Fields: avatar, website, banner, x, github, telegram, discord, email, redirectUrl, bio. They follow the domain on transfer. Same envelope, payload is the raw field text (or the value the indexer documents for that key).

## What inscription KNS cannot do

- Hierarchical subnames. L1 **will** inscribe multi-dot strings (`abc.def.kas`) as a **flat** asset. Official FAQ: that is not a parent-child subdomain. Only a later contract registrar can issue real subnames from `def.kas`.
- Consensus uniqueness. A second valid reveal for the same label is ignored by the indexer, not rejected by nodes.
- Store records in a UTXO. That is the covenant layer (`KasName.sil`).

## Covenant name UTXO (optional)

`KasName.sil` is **Silverscript v1.0.0**, one contract (not Argent). Constructor: owner pubkey + `sha256("kns/v1/" || label)`. Continuation **keeps the same sompi**; pay miner fees from a sibling P2PK input. `validateOutputState` does not lock amount by itself (official v1 tutorial).
