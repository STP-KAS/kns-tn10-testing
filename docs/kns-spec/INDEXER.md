# Indexers (official)

Two different machines. Do not mix them.

| Job | URL | What it is |
| --- | --- | --- |
| **KNS name resolver** | https://api.knsdomains.org/mainnet · TN10 `/tn10` | Official KNS indexer API: owner, check, profile, primary name. OpenAPI: https://apidoc.knsdomains.org/mainnet/ |
| **L1 block/tx indexer** | https://github.com/supertypo/simply-kaspa-indexer | Rust PostgreSQL indexer. KNS docs: “The KNS Resolver utilizes Supertypo’s Simply-Kaspa-Indexer.” |
| **Docs** | https://kns-2.gitbook.io/kns-docs-1/kns-indexer-api | Asset, detail, domain, check, profile, primary. |
| **Integration rules** | https://kns-2.gitbook.io/kns-docs-1/kns-indexer-api/integration-important-note | URL-encode names. Graphemer for fees. `@adraffy/ens-normalize`. Resolve warning. |

simply-kaspa-indexer is **not** the KNS name API. It is the L1 feed (blocks, txs, optional `tx_in_covenant_id` / `tx_out_covenant_id`). KNS maps `kns` envelopes on top of that class of indexer.

Must:

```
GET  /api/v1/{url-encoded-domain}/owner
POST /api/v1/domains/check   { "domainNames": ["example.kas"], "address": "<payer>" }
```

Check **before** every create. A losing reveal still pays the protocol fee (FCFS; refund form if unverified — official FAQ).
