# Dispute period — contract work plan

Built on `simplex-namespace-contract` @ `c1cca32` and `ens-contracts` @ `1a11cda` (tag `simplex-mainnet-v1`, deployed), stacked on the upgradeable stack (`ab/upgradeable-stack` @ `c4479381`, plan in [#20](https://github.com/brenzi/simplex-namespace-contract/pull/20)) and on [ens-contracts #49](https://github.com/simplex-network/ens-contracts/pull/49) rebased onto it (`ab/holder-renewal-v2` @ `f5aeb011`). The change is on `ab/dispute-period-v2`; `ab/dispute-period` holds it on #49 at `7ff8c37`, before the rebase. Replaces the reversible-payments plan, `docs/plans/payment-reversal.md` on the branch `ab/payment-reversal`, which is kept aside.

## 1. Problem

A card payment can be disputed or refunded for about 120 days after it settles, and the money is withdrawn from the store; the buyer keeps the name for its whole paid term ([Stripe](https://docs.stripe.com/disputes/how-disputes-work)). A registration made with a compromised store key is final at once.

## 2. Decisions

| # | Decision | Applied | Status |
|---|---|---|---|
| D1 | Term | the whole paid term at registration | the owner, 19 Nov |
| D2 | Dispute period | defined by each sponsored registration; before its end the guardian or the admin unregisters the name | the owner, 19 Nov |
| D3 | Days | card 120; BTC and XMR 14; ETH in the dApp 0 | the owner, 19 Nov |
| D4 | Bounds on the sponsored path | at least 14 days, at most 120, on chain | the owner, 19 Nov |
| D5 | An unregistered name | available to anyone at once; the payment goes back: the store accepts a card dispute, or refunds; no reinstatement | the owner, 19 Nov |
| D6 | Renewals | final; after a disputed renewal the guardian reserves the name, so its next renewal is refused | the owner, 19 Nov |
| D7 | Registrar upgrades | the admin, through the registrar's own ProxyAdmin, until that ProxyAdmin's ownership is renounced; the upgradeable stack removes `controller.freeze()` | the owner, 19 Nov |
| D8 | Transfers during the dispute period | allowed; clients show the dispute end and ask the recipient's acknowledgement | the owner, 18 Nov |
| D9 | What is public | each name's `disputeUntil`, and with it the class of its payment: 0, 14 or 120 days | the owner, 19 Nov |
| D10 | Who unregisters | the guardian or the admin | the owner, 19 Nov |
| D11 | Placement | the registrar stores `disputeUntil`, written at registration and deleted at unregistration, unregisters only before it and only when the caller names it, and renews only from it; the controller's `unregister(label, until)` for the guardian and the admin | decided |
| D12 | Unregistration | the records cleared on the default resolver and on a past default the node points at; then the expiry, the registry node's owner and its resolver set to 0, and the `SubnameRegistrar`'s subnames ended; the next registration burns the token and invalidates the subnames, as for a lapsed name | decided |
| D13 | In-app payments and codes | in-app 120 days; a code takes the days of the payment that bought it, at least 14 | decided |
| D14 | Renewals during the dispute period | refused by the registrar until `disputeUntil` (`DisputePeriodNotOver`), on every controller's path, so a final renewal is never erased by an unregistration; the shortest term is 730 days, so a name cannot lapse meanwhile | the owner, 19 Nov |
| D15 | A registration without a dispute period | stores `disputeUntil` 0 | decided |
| D16 | Storage | `disputeUntil` follows the registrar's last state variable | decided |
| D17 | Terms | the names conditions (simplex-chat `docs/NAMES-CONDITIONS.md`, the general and the community terms on chain) state the dispute period and the end of a registration within it, only if it was made without a valid order, or a payment used for it is disputed, reversed or refunded in full | the owner, 19 Nov |
| D18 | A compromised guardian | can take a name in its dispute period | accepted by the owner, 19 Nov |
| D19 | A payment for the name disputed, reversed or refunded in full, and its registration not ended | the name stays; the guardian reserves it, as after a disputed renewal (D6), and the conditions state that further extensions can be refused | the owner, 19 Nov |

## 3. States

```mermaid
stateDiagram-v2
  [*] --> disputable: registerWithCredit with 14 to 120 days
  [*] --> final: register (ETH), registerReserved
  disputable --> final: dispute period ends
  disputable --> unregistered: guardian or admin, unregister(label, disputeUntil)
  final --> final: renew, renewWithCredit
  disputable --> disputable: a claim
  unregistered --> [*]: available to any registration
  final --> lapsed: expiry + 90 days
  lapsed --> [*]: available to any registration
```

| State | `unregister` | claim | renewal | `available` |
|---|---|---|---|---|
| disputable, before `disputeUntil` | guardian or admin | allowed; clients ask for an acknowledgement | `DisputePeriodNotOver` | false |
| final, `disputeUntil` 0 | `DisputePeriodOver` with `until` 0; `DisputeUntilMismatch` with any other | as #49 | as #49 | false |
| final, dispute period passed | `DisputePeriodOver` with `until` equal to `disputeUntil`; `DisputeUntilMismatch` with any other | as #49 | as #49 | false |
| unregistered | `DisputePeriodOver` with `until` 0; `DisputeUntilMismatch` with any other | refused by `ownerOf` | refused by the registrar's `renew` | true |

```
BaseRegistrarImplementation
  ... as #49, every state variable
  disputeUntil      mapping(uint256 => uint256)   public, written at registration, deleted at unregistration

  registerWithLabel(label, owner, duration, disputePeriod)              controller only
    ... as #49
    disputeUntil[id] = disputePeriod == 0 ? 0 : block.timestamp + disputePeriod

  renew(id, duration)                                                    controller only, live
    block.timestamp >= disputeUntil[id]                                  else DisputePeriodNotOver(id)
    ... as #49

  unregister(id, until)                                                  controller only, live
    disputeUntil[id] == until                                            else DisputeUntilMismatch(until, disputeUntil[id])
    block.timestamp < disputeUntil[id]                                   else DisputePeriodOver(id)
    delete disputeUntil[id]
    expiries[id] = 0
    ens.setSubnodeRecord(baseNode, id, 0, 0, 0)
    subnameHook.onExpiryChanged(node, 0)
    emit NameUnregistered(id)

SimplexController
  register(registration)                                                 payable
    ... as #49, disputePeriod 0
  registerSponsored(registration, disputeDays)                           sponsor only
    MIN_DISPUTE_DAYS <= disputeDays <= MAX_DISPUTE_DAYS                  else DisputeDaysOutOfRange(disputeDays)
    ... as #49, disputePeriod = disputeDays days
  unregister(label, until)                                               owner or beneficiary
    _retireStaleRecords(namehash)                                        the default or a past default the node points at
    defaultResolver != 0 => defaultResolver.clearRecords(namehash)
    base.unregister(uint256(keccak256(label)), until)

SimplexNamePolicy.registerReserved(label, owner, duration)
  ... as #49, disputePeriod 0

SimplexSponsor.registerWithCredit(registration, disputeDays, nonce, deadline, sig)
  RegisterName(string label,address owner,uint256 duration,address resolver,bytes[] data,uint256 disputeDays,uint256 nonce,uint256 deadline)
  ... as #49
  controller.registerSponsored(registration, disputeDays)
```

Example: a two-year card registration on day 0 with 120 days expires on day 730. Disputed on day 30, it is unregistered by the guardian on day 31, available to anyone at once, and the store accepts the dispute. Undisputed, it is final and renewable from day 120.

```mermaid
sequenceDiagram
  participant P as Names page
  participant S as Store service
  participant G as Guardian
  participant Sp as SimplexSponsor
  participant C as SimplexController
  participant R as BaseRegistrar
  participant N as SubnameRegistrar
  S-->>P: disputeDays of the payment
  P->>P: owner signs RegisterName with disputeDays
  S->>Sp: registerWithCredit(registration, disputeDays, nonce, deadline, sig)
  Sp->>C: registerSponsored(registration, disputeDays)
  C->>C: 14 <= disputeDays <= 120
  C->>R: registerWithLabel(label, owner, duration, disputeDays days)
  alt dispute opened or refund made before disputeUntil
    S-->>G: alert with the evidence and disputeUntil
    G->>C: unregister(label, disputeUntil)
    C->>C: clear the records on the default resolver and on a past default the node points at
    C->>R: unregister(id, disputeUntil)
    R->>R: disputeUntil matches and is in the future
    R->>R: expiry 0, registry owner and resolver 0
    R->>N: onExpiryChanged(node, 0)
    S->>N: purge(node, labelhashes of getChildren), per level
    S->>S: accept a card dispute, or refund a payment the store gives back
  else no dispute
    Note over R: final and renewable from disputeUntil
  end
```

## 4. Threat model

| Who or what | Power after the change | Bound |
|---|---|---|
| a buyer who disputes a registration | gets the money back | the name is unregistered and available at once |
| a holder who disputes a renewal | keeps the renewed term | the guardian reserves the name, so it is not renewed again (D6) |
| a compromised store key | registers names to its own address, or with owners' signatures | each is unregistered by the guardian for at least 14 days (D4) |
| the guardian | unregisters any name in its dispute period, up to 120 days after its registration, and can register it to itself at once with a commitment made before; before this change it could mint only available names | one key until GOV8; a dispute period ends on its own; ETH registrations and `registerReserved` take none |
| a holder or recipient during the dispute period | renews only from `disputeUntil` (D14) | the shortest term is 730 days |
| a recipient of a claim during the dispute period | loses the name on an unregistration | clients show the dispute end and ask for an acknowledgement (D8) |
| a registrar controller added by the admin | unregisters a name in its dispute period, leaving the default resolver's records, which resolve again under the next holder who points the name at that resolver | as every controller power, behind the timelock from GOV8; a final name stays final |
| a queued or repeated `unregister` | ends no later registration of the label whose dispute ends at another second: `until` names one registration's `disputeUntil` (`DisputeUntilMismatch`) | once a name is unregistered, the guardian and the admin cancel any other prepared `unregister` of it |
| a registrar controller added by the admin, registering | any dispute period: the 14 to 120 days are bounded in `SimplexController` only, and a renewal is refused until `disputeUntil` | as every controller power, behind the timelock from GOV8 |
| an observer of the chain | learns each name's dispute end, so 0, 14 or 120 days, and with it whether its registration was paid in ETH, in crypto to the store, or by card or in-app | public by D9 |

## 5. Contract changes

```mermaid
flowchart LR
  page["Names page"] -->|"RegisterName with disputeDays"| service["Store service"]
  service -->|"registerWithCredit(..., disputeDays, ...)"| sponsor["SimplexSponsor<br/>new deployment"]
  sponsor -->|"registerSponsored(registration, disputeDays)"| controller["SimplexController"]
  dapp["dApp"] -->|"register, payable"| controller
  guardian["Guardian or admin"] -->|"unregister(label, until)"| controller
  controller -->|"registerWithLabel(..., disputePeriod), unregister(id, until)"| registrar["BaseRegistrar<br/>upgradeable, redeployed"]
  policy["SimplexNamePolicy"] -->|"registerWithLabel(..., 0)"| registrar
  registrar -->|"setSubnodeRecord(baseNode, id, 0, 0, 0)"| registry["ENSRegistry"]
  registrar -->|"onExpiryChanged(node, 0)"| subnames["SubnameRegistrar"]
  service -->|"purge(node, labelhashes)"| subnames
```

`BaseRegistrarImplementation`:

- `disputeUntil`, public, after the last state variable;
- `registerWithLabel` takes `disputePeriod`;
- `renew` refuses a renewal before `disputeUntil`;
- `unregister(uint256 id, uint256 until)`, controller only;
- event `NameUnregistered(uint256 indexed id)`;
- errors `DisputePeriodOver(uint256 id)`, `DisputePeriodNotOver(uint256 id)` and `DisputeUntilMismatch(uint256 named, uint256 current)`.

`SimplexController`:

- `MIN_DISPUTE_DAYS = 14`, `MAX_DISPUTE_DAYS = 120`;
- `registerSponsored(registration, disputeDays)`;
- `_registerCore` takes the dispute period, which `register` passes as 0;
- `unregister(string label, uint256 until)`, owner or beneficiary;
- error `DisputeDaysOutOfRange(uint256)`.

`SimplexNamePolicy`: `registerReserved` registers with 0.

`SimplexSponsor`, a new deployment: `registerWithCredit(registration, disputeDays, nonce, deadline, sig)` and `RegisterName` with `uint256 disputeDays`; `renewWithCredit` as #49.

The registrar's, controller's and policy's implementations and the new sponsor with `setSponsor` land together, before `freeze()`: `registerWithLabel` changes its signature, and `setSponsor` ends at the freeze. The conditions with the dispute period (D17) are set with `setGeneralTerms` and `setCommunityTerms` in the same batch as `setSponsor`, so that every registration with a dispute period is made under them.

If the change lands after the stack's deployment, as an upgrade of the registrar, the controller and the policy through their ProxyAdmins in one batch, `scripts/prepare-upgrade.mjs` names in `INTENDED` the selectors it replaces (`docs/upgrades.md`, invariant 5): `registerWithLabel(string,address,uint256)` on the registrar, and `registerSponsored` with its old argument list on the controller. The new sponsor is a new deployment with `setSponsor` in the same batch.

The rebase onto `ab/upgradeable-stack` @ `c4479381` (done):

- #49's renewal acceptances move to slot 8 of the policy's proxy, its `__gap` to `uint256[41]`;
- the registrar's storage-layout snapshot gains `disputeUntil` at slot 22, its last variable;
- that branch removes `controller.freeze()` and `frozen`, so the test "is made without a default resolver and after the freeze" keeps only its default-resolver half, and the mutant `if (frozen) revert Frozen();` goes;
- the statements on `freeze()` in this plan, `CLAUDE.md`, `docs/security.md` and `docs/deployment.md` follow the wording of that branch's documents when its namespace change (#20) merges.

Sizes in bytes, limit 24,576:

| Contract | #49 on the stack | This change |
|---|---|---|
| BaseRegistrarImplementation | 20,166 | 21,248 |
| SimplexController | 18,109 | 18,934 |
| SimplexNamePolicy | 18,164 | 18,177 |
| SimplexSponsor | 5,840 | 5,856 |

## 6. Effects outside this repository

- simplex-chat, store service: `disputeDays` per payment by D3 and D13, in the `RegisterName` digest and calldata, with a reveal refused when signed over another value; before `disputeUntil`, the guardian's `unregister(label, disputeUntil)` and `purge` of the name's subnames, then, per trigger: on `charge.dispute.created`, the store accepts the dispute (a disputed charge cannot be refunded); for a payment the store gives back, the refund; on `charge.refunded` for a full refund made outside the service, nothing more; when a payment for the name is disputed, reversed or refunded in full and its registration is not ended, the guardian's `addReservedNames`; a renewal offered only from `disputeUntil`.
- simplex.domains: `RegisterName` with `disputeDays`; the dispute end on the order page.
- The app's claim flow and the dApp's claim review: the dispute end before a claim, with the recipient's acknowledgement (D8). The app and the dApp offer a renewal only from `disputeUntil`.
- The names resolver: a name with expiry 0, and every node under it, answers as unregistered: `purge` deletes the `SubnameRegistrar`'s subnames, while subnodes the holder created directly in the registry keep their owner, resolver and records, also after the next registration, until the next holder replaces them.
- `docs/plans/names-v2-launch-to-freeze-plan.md`: `unregister` in the guardian's and the admin's powers, and its routine operation.
- Indexers: `unregister` emits `NameUnregistered(id)` and no ERC-721 `Transfer`. The subgraph (`ens-subgraph` at `a80c67b`) sets a name's expiry only from `NameRegistered` and `NameRenewed`, so it gains a `NameUnregistered` handler that sets the expiry to 0; filtering by expiry holds only with on-chain `nameExpires` until then.
- This repository: `CLAUDE.md` and `docs/security.md` state `unregister` and the narrower freeze guarantee; the deployment scripts for the redeployed registrar come with the registrar's upgradability change.
- simplex-chat `docs/NAMES-CONDITIONS.md`, linked on chain at `d94981224` (#8135): a version with the dispute period (branch `ab/names-conditions-dispute`). It follows the version for the upgradeable stack, which states upgradeability and no dispute period; the change merged second merges master. Its links go into `terms.simplex.json` and on chain as above.

## 7. Tests

`ens-contracts/test/simplex/TestDisputePeriod.test.ts`:

- a sponsored registration stores `disputeUntil` as its time plus the days; 14 and 120 days register, 13 and 121 revert `DisputeDaysOutOfRange`;
- the payable `register` and `registerReserved` store a dispute end of 0, so `unregister` reverts `DisputePeriodOver` at once;
- `RegisterName` with other `disputeDays` reverts `InvalidSignature`; the type hash is pinned;
- `unregister` by the guardian and the admin before `disputeUntil`; by the registrar key, the holder and anyone else it reverts; at `disputeUntil` it reverts `DisputePeriodOver`;
- after `unregister`: `nameExpires` 0, `available` true, `ownerOf` reverts, the registry node's owner and resolver 0, the default resolver's records empty, the subnames without owner, `expiryOf` 0 on the subname registrar, `purge` deletes the subnames, a claim, a renewal and a record write by the old holder revert, and a second `unregister` reverts;
- a registration after `unregister`, by anyone: the old token burned, the subnames of the old holder without owner, the records cleared;
- a claim during the dispute period moves the name, and an `unregister` then takes it from the recipient;
- a renewal on each path reverts `DisputePeriodNotOver` one second before `disputeUntil` and succeeds at it;
- the default resolver's records are cleared although the holder pointed the node at 0, and a past default's records although the default was rotated;
- `unregister` without a default resolver, and after `freeze()`;
- a re-registration writes a new dispute end, and an `unregister` naming the earlier one reverts `DisputeUntilMismatch`;
- the registrar's `unregister` reverts for every caller but a controller;
- `test/ethregistrar/TestBaseRegistrar.test.ts` passes the new argument and runs in the fork's CI;
- each new guard, removed, fails at least one test.
