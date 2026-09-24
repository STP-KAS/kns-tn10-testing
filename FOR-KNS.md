> **Experimental only. Not a product.** Not an audit. Not Kaspa core. Not official KNS. Not SuperTypo.
>
> Read 24 Sep 2026. This desk did not re-broadcast the TN10 creates and did not run the DOTK test suite. Counts below are this repo's own export.

# For KNS

Tested [STP-KAS/kns-tn10-testing](https://github.com/STP-KAS/kns-tn10-testing) at `9083b6b` against the mix sketch [STP-KAS/kns-dotk](https://github.com/STP-KAS/kns-dotk) at `71ba80a`, then against the DOTK news of 15–23 Sep 2026.

The mix sketch is the scoring sheet: keep `.kas`, keep the inscription as history, put uniqueness in a new gap lineage, bind an inscription to a deed on purpose. [NEWS.md](https://github.com/STP-KAS/kns-dotk/blob/main/NEWS.md) records what 21–23 Sep changed in that sheet.

## What

This repo is an inscription load lab on Testnet-10. A create is a `kns` commit–reveal. Output 0 pays the TN10 fee sink. The indexer decides who owns the name. A second valid reveal still pays.

That matches what is live for `.kas` today. It does not test the covenant registration the KNS account said it had tried on TN10 (UI about 80%, claim/airdrop still in progress, Kaspire on TN10 and mainnet soon). Those posts are linked from the README.

DOTK, launched 15 Sep by @supertypo_kas, is a different product on `.k`. Uniqueness there is a gap UTXO over `blake3(name)`: a duplicate register is a double-spend inside one lineage. On 21 Sep the read and write SDKs were published at version 2.0.0, with subnames. On 23 Sep a `url` record became reachable at `https://<name>.kaspa.name`.

## Why this lab is still the right inscription test

Copy these. They already match the mix sheet and the KNS docs.

| Copy this | Why |
| --- | --- |
| Check `POST /domains/check` before every create, and require `available` plus `isReservedDomain: false` | The check is in `kns-smoke-create.mjs`, `kns-s3-create.mjs`, `kns-snap-create.mjs`, `kns-snap-pool.mjs`, and `kns-snap-r1.mjs`. A create that skips it pays a losing reveal. |
| Price with `Intl.Segmenter` graphemes: 1–2 → 4200, 3 → 2100, 4 → 525, 5+ → 35 tKAS | `kns-smoke-create.mjs` `visualLen` does this. KNS already prices graphemes. DOTK prices UTF-8 bytes of an ASCII name and will misprice an emoji `.kas`. |
| Sign with `kaspa-wasm32-sdk` v2.0.1. Leave npm `kaspa-wasm@0.13.0` out | The lab hit a null pointer in that 0.13.0 `ScriptBuilder`. `@dotk/sdk` refuses the same package and asks for a rusty-kaspa wasm from v2.0.0 up. |
| Smoke one name, then scale. Stop between names, never mid commit/reveal | `SMOKE-PLAN.md`. The bulk races (51–150, 151–350) were real until retries became artifact-aware. |
| On a lagging node, reuse the stranded commit and build the reveal from that commit's change | `kns-s3-create.mjs`. DOTK 2.0 `planActivate` is the same lesson on a deed: finish the reveal, do not post a second commit. `register` there takes both signatures before the commit so a refused popup leaves the name free. |
| Keep the stricter label rule when the indexer is looser | The TN10 indexer accepts a leading or trailing hyphen. R1 does not. DOTK's covenant also refuses those hyphens. A covenant should keep the strict rule. |
| Keys stay in env vars, outside the repo | This tree has no seed. Keep it that way when the covenant UI is tested. |
| Share holder addresses with the claim work, without the keys | `kns-spec/snapshot-tn10`: 25,700 addresses, 1,048 of them holding 7,614 names at the 23:20 CEST export. That set is the installed base a bind has to respect. |

## Why the lab must not be copied as the covenant

| Do not copy | Do this |
| --- | --- |
| The 8,758 reveal rows as a covenant result | They are indexer-FCFS inscriptions. The export at 24 Sep 2026 23:20 CEST is a floor (smoke 1, bulk 1,143, Phase A 6,207, S3 791, R1 616), and the runs were still going. One covenant register on TN10, proved by `covenant_id` on a node with `--utxoindex`, comes before any scale. |
| `kns-snap-pool.mjs` `priceKas` and `kns-snap-r1.mjs` `feeFor([...label].length)` | Those count UTF-16 code units. The current labels are ASCII, so the tKAS figure matches. An emoji label will not. The covenant pricer uses the Segmenter, as `visualLen` already does. |
| `SMOKE-PLAN.md` saying "35 KAS" | The README prices 35 tKAS. The sompi count `35e8` is the testnet figure. The plan's unit word is corrected in this commit. |
| A local kaspad without `--utxoindex` as a prover | The README already says creates use the public resolver because that node has no UTXO index. `@dotk/sdk` proves only against a node that has one. A card proof also needs the outpoint. |
| The KasWare click-path | The box had no KasWare inject, so `tn10.knsdomains.org` was unverified. `docs/kasware-create-tn10.html` is named in the smoke plan and is not in the tree. The covenant UI needs its own smoke in a real wallet, with the address and the amount on screen before the signature. |
| One payer, or 25,700 derived payers, as a uniqueness proof | Many payers are right for a claim snapshot. They do not stop a second inscription of the same word. Nodes do not reject that second reveal. |

## DOTK news to integrate

Sources read this pass: [@supertypo_kas 15 Sep thread](https://x.com/supertypo_kas/status/2099780606674538685), [21 Sep 2.0.0](https://x.com/supertypo_kas/status/2101940281431970172), [23 Sep kaspa.name](https://x.com/supertypo_kas/status/2102698003140104546), [@dotk/sdk](https://github.com/supertypo/dotk-sdk) and [@dotk/sdk-tx](https://github.com/supertypo/dotk-sdk-tx) at 2.0.0 (pushed 21 Sep 2026), and the public repo list of `supertypo` on 24 Sep. `github.com/supertypo/dotk` still returns 404. No `.sil` is in either SDK. The generated ABI names `sil/DotkGap.sil` and `compiler_version` `0.1.0`. SilverScript v1.0.0 is `3ed9733`. The 21 Sep thread said the indexer/api repo was next. It is not in that public list.

Michael Sutton's reply on the launch thread calls the developers page a partitioned state space. The checkable form of that partition is the gap tree in the SDK, not the web app. This desk's fetch of `https://dotk.name/developers` returned the title only.

The two registries in the SDK are different lineages. Mainnet `registryCovenantId` is `ee2128c03dfac7f6d74734bb3c879bd999434c47a55945b8a6daae2a1e4a21de`. Testnet-10 is `4a4ca31ea28508021b899610bbc8fbcec4ebd6e6bf4f9c37dca0339fbda1442c`. Template hashes differ too. The client keys them by network id, because every `testnet-*` shares one address prefix.

### Copy this. It is good.

**Gap covering of a domain-separated key, on a new `.kas` lineage.** A duplicate register spends the same gap and dies as a double-spend. One `covenant_id` lets an explorer filter the registry. kaspa.stream already does that for DOTK. Completeness is the other half: the gaps that remain are the proof that a name is free, not only that one deed exists.

**Hash-blind commit, then reveal.** `claimOf` is `blake3(name ‖ ownerType ‖ owner)`. The name is not on the deed until activate. Take both signatures before the commit. If the reveal fails after the commit landed, finish that pending deed (`planActivate`). Refuse an owner nothing can spend (zero payload, off-curve key, covenant id) before any bond is posted.

**A manifest compiled into the client.** `DEPLOYMENTS` is a static import. The directory cannot supply the covenant id the client checks it against. `status().sameRegistry` is the test. `https://api.dotk.name` and `https://api-tn10.dotk.name` are different directories. A TN10 answer that carries the mainnet id is refused.

**Prove with a node. The directory is a mirror.** `proven: true` happens only with a node. Without one, say the answer is the API's word. `history` is the call a node cannot answer. If the API is behind, it will say "no such name" for a name it has not reached. `caughtUp` / `behind` exist so a wallet can show that.

**One send-box call, and no guess.** `recipientFor` classifies, then resolves. A name, a subname, and an address are different arms. `addressFor` refuses a subname, so a label cannot be paid to the parent by accident. If resolution fails, stop. Do not pay a similar name, a cache, or the raw string.

**Show the price before the signature.** `quote` returns fee, bond, deposit, and `totalToFund` in sompi. The launch thread says to read the deducted amount in the wallet before signing. `POST /domains/check` on KNS returns `available` and `isReservedDomain` and no price. A covenant check should return the same figures the popup will show.

**One records map, cleared on transfer.** A card is one output beside the deed. `primary` picks the name an address shows. A transfer that mints no card ends every `sub:` entry, and the plan lists them in `subnamesDropped` before the wallet signs. A transfer to a new owner does not carry the old card's subnames. That is the "clear the profile on sale" rule, with the list visible.

**Subnames as the owner's pointer, one way.** `bob.alice.k` is the label `bob` on the card of `alice.k`, stored as `sub:` plus the label. The holder creates it. The chain proves the parent deed and the card. It does not prove the payee. The payee is the parent's claim. Show "set by the owner of alice.kas", and put the proof mark on the parent. `chat.alice` for a hot wallet and `donate.alice` for a second address is the example @supertypo_kas gave on 21 Sep. Unknown fault tags are refusals.

**Lookup before paying a half-finished name.** `lookup` separates active, pending, owner unknown, and free. `addressFor` collapses the middle two. A send box that must not pay into a pending registration asks `lookup`.

**A transfer of the deed is one lineage input.** The directory is not required to move the name. @supertypo_kas said on 22 Sep that listing would land on other marketplaces, not inside dotk itself. Keep the registrar free of an exchange. The inscription marketplace and a future deed marketplace are different objects. If they disagree, show both and stop.

**Narrow UTXO batches.** `PROBE_CHUNK` is 400 addresses, because a wide `getUtxosByAddresses` holds the node's utxoindex lock. The claim UI that walks the 25,700 snapshot should stay in small batches.

**Scheme allowlist before a record is rendered.** `url` and `avatar` are arbitrary strings. `javascript:` and `data:text/html` decode. Allow only the schemes the page means to open.

**Work with the people who already minted `.kas`.** The mix sheet's owner note still holds. A second TLD reads as a raid even when the uniqueness engineering is real.

### Do not copy. Do this.

| Do not copy | Do this |
| --- | --- |
| `.k`, and `blake3` of the bare name | Humans type `.kas`. The v2 key is `blake3("kas/v2/" ‖ ens-normalize(label))`. DOTK's unsalted `blake3(name)` is inside `.k` only. The same bytes must not be a `.kas` gap key, or a grind crosses the two registries. `supertypo.kas` and `supertypo.k` were different owners on 15 Sep. Stripping a letter is a theft bug. |
| The ASCII charset and the 32-byte cap as the `.kas` rule | DOTK names are `a-z`, `0-9`, and hyphen, 1 to 32 bytes, no hyphen at either end. `.kas` already uses ENS-normalize and grapheme fees. Keep those. A covenant that rejects existing `.kas` labels is a second product. |
| Subnames as their own gap, or as a second unique name | The gap key is the parent label. `chat.alice.kas` must not consume a gap. It is a card record. Free to update. Cleared when the deed moves. A missing label pays nobody. |
| `https://<name>.kaspa.name` as the name living on the chain | The 23 Sep post says a `url` record is reachable at that host. The string `kaspa.name` is not in either SDK. It is a directory gateway, the same class of thing as `.kas.limo`. Store `url` if the profile needs it. Say the gateway is a website in front of a record. |
| The closed script and the baked devfund | `quote` has a fee tier paid to a devfund. The redeem script is in the generated genesis. The `.sil` is not. Publish `.sil`, the silverc v1.0.0 pin, the template hashes, and a public `devfund_spk` before a `.kas` covenant takes a mainnet fee. Argue that address in the open. A new lineage is how it changes. Do not ask for `ee2128c0…`. |
| `email` on a public card | DOTK's `RECORD_KEYS.global` includes `email`, `phone`, and `mail`. The KNS implementer note already says not to inscribe email. Leave those keys off the default card. |
| KasWare, Kastle, or Kaspire injected from this GitHub | DOTK's web app, on 15 Sep, spoke to KasWare, Kastle, and Kaspire on desktop, and Kaspire on Android, and found no iOS wallet with the primitives. On 23 Sep Kaspire was named again for the url feature. The GitBook supporting-wallet table is the list. A Connect control is not a row. This desk does not add an inject. Show the `kaspa:` address and the amount. |
| Node 22.12 as a requirement on these inscription scripts | `@dotk/sdk` 2.0.0 declares `node: >=22.12.0`. This lab was run on Node 20.19.2 and that is the right pin for these scripts. A wallet that imports the DOTK packages follows their engines line. |
| "The community asked for a second TLD" | They paid for `.kas`. Offer a bind: the inscription owner may mint the v2 deed to the same payee. Never auto-map. |
| Calling the public REST API a proving node | Do that only when the UTXO it returns carries `covenant_id` and the outpoint. simply-kaspa-indexer (last push 8 Jul 2026) can store `tx_out_covenant_id`. It is the L1 feed. It is not `api.knsdomains.org`. A `.kas` covenant should emit that field so a replica can see the lineage. |

## Conclusion

Keep this lab as the inscription test. It checks the path the indexer accepts today: grapheme fees, a check before the spend, wasm SDK v2.0.1, keys off git, and a snapshot the claim work can use. Fix the two code-unit pricers before any non-ASCII label, and keep the smoke plan in tKAS.

The covenant UI is a separate smoke. One TN10 register, proved on a node with `--utxoindex`, with the address and the sompi total on screen, before any bulk.

From DOTK, take the gap, the bundled manifest, the node proof, the send box that refuses a guess, the quote before the signature, the single card, and subnames as one-way records on that card. Build that under `.kas`, on a new lineage, with ENS-normalize and grapheme fees, a published `.sil`, and silverc v1.0.0. Leave `.k`, the unsalted key, the ASCII-only rule, the closed script, the private devfund, and the kaspa.name gateway on DOTK's side of the line.

Bind an inscription to a deed when the owner signs. If the inscription owner and the deed owner differ, show both and do not send.
