# Names v2 — contract work plan

Built on `simplex-namespace-contract` @ `66ec89f` / `ens-contracts` @ `0905c7d`.
Target: `.simplex` deployed on mainnet 30 Oct 2026, governance handover 2 Nov, all live
4 Nov, investor window 12 Nov, public registration 12 Dec. Custody and the freeze are in
[`names-v2-launch-to-freeze-plan.md`](./names-v2-launch-to-freeze-plan.md).

## 1. Table of contents

1. Table of contents
2. Executive summary
3. The baseline this built on
4. Work items
5. Design decisions
6. Storage layout
7. Deployment, handover and freeze
8. Redeploy contingency
9. Requirements handed to the names service
10. Test plan
11. Sequencing
12. Out of scope

## 2. Executive summary

`.simplex` sells names through the app store and relays every on-chain action on the
user's behalf, so a user never needs ETH. Three mechanisms carry that.

**A registrar spending limit.** The guardian Safe grants a registrar hot wallet an
allowance in attoUSD; a sponsored registration or renewal deducts that name's own list
price and attaches no value. No fee moves, a compromised registrar can only spend up to its
limit, and the guardian can zero it in one transaction with no delay. The unit is the one
the price list is configured in, so the limit does not drift with the ETH price.

**Signed intents.** Every post-registration action — transfer, record edit, record clear,
subname creation, registry approval — is a one-shot EIP-712 signature submitted by a
relayer that pays gas and nothing else. No standing delegation.

**Edit credits.** Relayed record writes are metered per name, on-chain, granted at
registration and renewal and topped up by purchase. A direct write by an owner paying
their own gas is never metered.

**Status.** W1 to W6 are implemented on `ens-contracts@ab/names-v2` and green: 1062 tests
pass, 219 of them in `test/simplex` across 19 files. W7 to W10 — the deployment script, the
handover and freeze runbooks, the redeploy runbook and the docs — live in the parent repo
and are not started. One pre-existing failure remains in
`test/ethregistrar/TestBaseRegistrar.test.ts`, an upstream test asserting the registry owner
stays with the seller, which contradicts the SNRC auto-reclaim deviation; it fails without
these changes too.

## 3. The baseline this built on

Already implemented, 19 tests passing:

- `BaseRegistrarImplementation.transferWithSig(from, to, tokenId, nonce, deadline, sig,
  ephemeralPubKey, viewTag)` — EIP-712 domain `SimplexNames`, per-signer nonces,
  grace-aware ownership check, self-transfer rejected, `_transfer` so auto-reclaim fires,
  `StealthNameTransfer` emitted only when an ephemeral key is supplied.
- `SimplexResolver` — `PublicResolver` subclass with `setTextWithSig`, per-signer nonces,
  `editCredits(node)`, and `grantEditCredits(node, amount)` restricted to an immutable
  `trustedController`.
- `Root.sol` compiles but is deployed nowhere.
- `SimplexController` is UUPS behind `SimplexControllerProxy`, with `_reentrancyStatus`
  and `uint256[48] __gap` at the tail.

Not yet present: any credit system, the beneficiary role, the upgrade freeze, the public
sales switch, sponsored subname creation, and a `.simplex` deployment script.

## 4. Work items

W1 to W6 are implemented in `ens-contracts` on `ab/names-v2`. W7 to W10 live in the parent
repo and are outstanding.

### W1 — `SimplexController`: allowance, beneficiary, sales switch, freeze (done)

New state (§6): `beneficiary`, `frozen`, `registrarAllowance`, `defaultResolver`,
`publicSalesOpen`, `editCreditPriceUSD`. New constant `EDIT_CREDITS_PER_YEAR = 10`.

```solidity
function setBeneficiary(address) external;             // owner while unset, beneficiary after
function addReservedNames(string[] calldata) external; // owner or beneficiary
function setRegistrarAllowance(address, uint256) external onlyBeneficiary;  // attoUSD
function setEditCreditPrice(uint256) external onlyOwner;                   // attoUSD
function setDefaultResolver(address) external onlyOwner;
function setPublicSalesOpen(bool) external;             // owner or beneficiary; reverts once frozen
function freeze() external onlyOwner;                  // one-way
function withdraw() public nonReentrant;               // pays beneficiary
function registerWithCredit(Registration calldata) external nonReentrant;
function renewWithCredit(string calldata, uint256, bytes32) external nonReentrant;
```

`_authorizeUpgrade` and `setPublicSalesOpen` both gain `if (frozen) revert Frozen();`. One
flag closes both: after the freeze the implementation is permanent and the sales switch
holds whatever value it had, so the contract can no longer be made to do less than it does
at that moment.

`freezePriceOracle()` is removed. `StablePriceOracle.usdOracle` is `immutable`, so
changing the price feed means deploying a new oracle and calling `setPriceOracle`; freezing
that would mean a retired Chainlink feed permanently breaks registration and renewal.
`setPriceOracle` is therefore a power the owner must keep after the freeze, and leaving a
one-way function in the contract that must never be called is a footgun worth deleting. Its
storage slot is kept as an unused private bool rather than deleted, so nothing after it
shifts.

`prices`, `setPriceOracle` and `initialize` are typed `IPriceOracleUSD` rather than
`IPriceOracle`, so a replacement oracle must be able to quote in attoUSD. The variable is
still one address, so the layout is unchanged.

The payable `register()` reverts with `PublicSalesClosed` while `publicSalesOpen` is
false. `registerWithCredit`, `registerReserved` and both renew paths are exempt: the
credited path is how the investor window is served, and renewal must never be blocked.

The body of `register()` from the availability check to the `NameRegistered` emit moves
into a private `_registerCore(Registration calldata) returns (uint256 expires)`.
`register()` wraps it in the price computation, the `msg.value` check and the refund;
`registerWithCredit()` wraps it in `_spendAllowance(_rentPriceUSD(...))`, so the deduction
is the name's own list price. `renew` gets the same treatment, and both credited paths emit
the wei-equivalent list price in their event — nothing is paid either way, and the
accompanying `RegistrarAllowanceSpent` records what was actually consumed. An exhausted
registrar reverts with `InsufficientAllowance(required, available)`.

`registerWithCredit` applies `minCharLength` and `reservedNames`, and skips the NFT gate,
whose `msg.sender` would be the registrar rather than the buyer.

`registerReserved` gains the resolver path. Today it calls `base.registerWithLabel` and
nothing else, and `setSubnodeOwner` sets an owner but not a resolver, so a reserved name
does not resolve at all. It takes the shape of `register`'s resolver branch: register to
the controller, `ens.setRecord(namehash, owner, defaultResolver, 0)`, transfer the token,
grant the edit credits. A brand's name then resolves the moment it is reserved and its
later edits can be relayed, without the brand ever holding ETH.

### W2 — edit-credit grants and the acceptance top-up (done)

```solidity
interface IEditCredits { function grantEditCredits(bytes32 node, uint256 amount) external; }

function topUpEditCredits(bytes32 node, uint256 amount) external;  // deducts amount x editCreditPriceUSD
```

After a successful registration, when `registration.resolver == defaultResolver` and that
is non-zero, grant `EDIT_CREDITS_PER_YEAR * years`, where `years = duration / 365 days` by
integer division with a minimum of 1. The same on both renew paths, keyed by
`keccak256(abi.encodePacked(tldNode, labelhash))`.

`topUpEditCredits` is what a purchase buys when someone accepts a name sent to them, or
re-points a name after recovering from their phrase, or exhausts a name's credits. It
deducts `amount × editCreditPriceUSD` from the registrar's allowance, which keeps it under
the same limit and the same kill switch as registration. `editCreditPriceUSD` defaults to
zero, so it has to be set at deployment or top-ups are free.

### W3 — `clearRecordsWithSig` on the resolver (done)

`clearRecordsWithSig(bytes32 node, uint256 nonce, uint256 deadline, bytes calldata sig)`,
type hash `ClearRecords(bytes32 node,uint256 nonce,uint256 deadline)`, one credit, reusing
`_authorizeRelayed`, then `recordVersions[node]++` and the `VersionChanged` event.
Constant gas regardless of how many records exist, which is what makes accepting a gifted
name affordable: one call wipes whatever the sender left behind.

### W4 — subname records in `_authorizeRelayed` (done)

`_authorizeRelayed` resolves the signer as `ens.owner(node)`. A subname node is owned by
the `SubnameRegistrar`, so relayed edits currently reach 2LDs only. Mirror
`PublicResolver.isAuthorised`:

```solidity
address owner = ens.owner(node);
if (owner == address(nameWrapper)) owner = nameWrapper.ownerOf(uint256(node));
```

`nameWrapper` is `internal` on `PublicResolver`, so this needs no upstream change.

### W5 — `ENSRegistry.setApprovalForAllWithSig` (done)

For the `.simplex` deployment only; `.testing`'s registry is untouched. EIP-712 domain
`SimplexENSRegistry`, type hash
`ApproveAll(address owner,address operator,bool approved,uint256 nonce,uint256 deadline)`,
a `nonces(address)` map, `SignatureChecker`, and the same `_operatorApprovals` write and
`ApprovalForAll` event the existing setter produces.

This is the one change to the root of trust in this plan and gets the most review of
anything here.

### W6 — `SubnameRegistrar.createSubnameWithSig` (done)

`createSubnameWithSig(parentNode, label, nonce, deadline, sig)` and
`deleteSubnameWithSig(...)`, verifying against the effective owner `_controller` already
computes, with the contract's own nonce map.

Both W5 and W6 ship in the 30 Oct deployment even though subnames are a February 2027
feature, for the reason in §5.

### W7 — `.simplex` deployment script (outstanding)

`scripts/deploy-simplex.mjs`, modelled on `deploy-mainnet.mjs`. Only what differs is listed
here; the full call sequence including the unchanged wiring is Appendix A1 of the
launch-to-freeze plan. Deploy `Root` and give it the registry root, assign the TLD through
it, deploy `SimplexResolver` with `nameWrapper = SubnameRegistrar`,
`trustedETHController` and `trustedController` = the controller proxy, and
`trustedReverseRegistrar = address(0)`. `nftGateEnabled = false`, `smpxNft = address(0)`,
`minCharLength = 6`, `setMaxLabelLength(63)` on the registrar, and the six-entry price
curve against the Chainlink ETH/USD feed, in attoUSD per second:

```
price1Letter  31709791983700000    $1,000,000 / year
price2Letter   3170979198370000      $100,000 / year
price3Letter    317097919837000       $10,000 / year
price4Letter     31709791983700        $1,000 / year
price5Letter      3170979198370          $100 / year
price6Letter       317097919837           $10 / year   (six characters and above)
```

Six entries, not five: `StablePriceOracle` used to apply `price5Letter` to everything of
five characters or more, so a six-character name could not be priced apart from a
five-character one. The sixth entry splits them, and a five-entry array still behaves
exactly as before. Every rung is an exact multiple of the 6+ rung, so the ten-times-per-
character ratio holds without rounding drift. The one- and two-character rungs continue
the ladder rather than sitting at zero, so lowering `minCharLength` further can never hand
out free names.

`setEditCreditPrice` is set here too — it defaults to zero, which would make relayed-write
top-ups free and leave an unpriced hole in a money-bounded registrar allowance.
`setDefaultResolver` after both the controller and the resolver exist — the dependency is
circular, which is why it is a setter and not an initializer argument.

The script also reserves the ~3000 a-priori names, in batches of about 300. Measured cost
is 25.4k gas per name — 7.6M per batch, 76M in total — so at the base fee quoted in the
launch-to-freeze plan the whole set is single-digit dollars. Note that gas *estimators* run
roughly 3x over actual for this loop, so the submitted limit will look far larger than the
gas the batch really burns. It stops there: the registrar allowance and the ownership transfer are governance actions
with their own dates and callers (§7), and the script must not perform them.
It requires the admin `TimelockController` and both Safes to exist already, since it prints
the handover calls against their addresses.

Do not call `Root.lock` at deployment (§8).

### W8 — handover and freeze runbooks (outstanding)

`scripts/handover-simplex.mjs` and `scripts/freeze-simplex.mjs`, each with a dry-run mode
and a post-condition check per step. Custody — the two Safes, the timelock, which power
sits where and why, and the picture before and after — is
[`names-v2-launch-to-freeze-plan.md`](./names-v2-launch-to-freeze-plan.md); these scripts
implement its Appendix A recipes and assert the verification steps in each.

### W9 — redeploy runbook and address inventory (outstanding)

`scripts/redeploy-simplex.mjs` covering both variants — keep the `ENSRegistry` and
re-point the TLD, or deploy the whole stack fresh — emitting a new
`deployments.mainnet.simplex.json` and printing the §8 list of every consumer that must be
updated, with a verification step for each.

### W10 — documentation (outstanding)

`docs/architecture.md` for credits, relayed writes and the announcement.
`docs/security.md` for the new accepted risks: relayer liveness, the registry-wide scope
of a signed approval, the deliberately unbounded relayed entry points and the service-side
mitigation that replaces a contract cap, the public sales switch, and the fact that the
chat database now holds assets. `docs/sequence-happy-flow.md` for sponsored registration
and acceptance. `verification.mainnet.testing.json` correction, and `CLAUDE.md`'s
admin-capability list, which still names `setTreasury` and calls `maxLabelLength`
optional.

## 5. Design decisions

**The registrar limit is money, not a count of operations.** A flat per-operation credit
prices a ten-year four-character name the same as a one-year six-character one, so it
bounds transactions rather than exposure. `IPriceOracle.price` returns wei, which moves
with ETH and is useless as a limit, so `StablePriceOracle` gains `priceUSD` returning the
same quote in attoUSD before conversion — the unit the price list is already configured
in — and `setPriceOracle` is typed to `IPriceOracleUSD` so a replacement oracle must
provide it. Edit-credit top-ups have no name price, so they deduct an owner-settable
`editCreditPriceUSD` per credit; leaving them unpriced would be an unbounded hole in a
money-bounded limit.

**Per-name edit credits stay counted.** A record write has no market price, and what that
credit bounds is relayed gas, not value.

**Credits are added, never set.** `renew()` is `external payable` with no access control,
so anyone can renew anyone's name. With set semantics a stranger could renew a ten-year
name for the minimum term and collapse the owner's allowance to ten. Adding makes a
hostile renewal a gift, which is the right outcome for an unauthenticated call. Registrar
the registrar allowance is the opposite — `setRegistrarAllowance` replaces, because it is
a kill switch.

**One credit is one operation**, whatever term is bought. Simpler to reason about than
per-name-year, and adequate for what the credit is for, which is bounding a compromised
registrar's blast radius.

**Public sales are an owner switch, not a date.** A hard-coded timestamp cannot absorb a
moved release, and a date already passed cannot be undone. `setPublicSalesOpen(bool)`
follows the pattern of the NFT gate, but stays two-way rather than one-way, so it is also
the pause switch if something goes wrong during or after the launch. Since the controller
owner is retained (see the launch-to-freeze plan), it stays available indefinitely.

**No signed batch, but `clearRecordsWithSig` is kept.** `Multicallable._multicall`
delegatecalls into `address(this)`, preserving `msg.sender`, so a signature-authorised
batch would require making `PublicResolver.isAuthorised` virtual — a change to a verbatim
upstream file. Clearing is not a batch: it is one constant-gas write that does the job a
batch was wanted for.

**Relayed gas is bounded by the service, not the contracts.** Several sponsored entry
points take unbounded arguments, and OZ `SignatureChecker` falls through to an ERC-1271
`staticcall` when recovery fails. A contract-level cap would be a guess at a future limit
baked into a contract that is immutable or frozen — the fallback-URL CSV alone
is a reason to want a larger record later. The relayer is the only caller of these paths
and the only party that can judge abuse. §9 records what it must therefore do.

**Subname creation goes through a forked registry, not a change of ownership model.**
Creating a subname needs the `SubnameRegistrar` to have registry authority under the
parent node, which today means the owner calling `ens.setApprovalForAll` from their own
address — the one call that cannot be relayed. The alternative, making the registrar the
registry owner of every 2LD, would turn `ens.owner(name)` into a contract address for
every name and break every reader that follows the ENS convention. Adding
`setApprovalForAllWithSig` to `.simplex`'s own registry keeps ENS semantics exactly as
they are, keeps the approval per-user and opt-in, and adds one capability: signing instead
of paying gas.

**The `SubnameRegistrar` deployed on 30 Oct is final.** `PublicResolver` declares
`INameWrapper immutable nameWrapper` and authorises subname records through it, so the
resolver is permanently bound to the registrar address given at its construction. A
registrar deployed later would produce subnodes the resolver refuses to authorise.
Everything the sponsored subname flow needs therefore ships at deployment and lies dormant
until the client uses it.

**The controller owner is kept, and the code is frozen instead.** Brand reservation and
`registerReserved` must remain available indefinitely, so the owner is not renounced. What
makes that safe is `freeze()`, and the reason is specific: the controller is
deployed as `trustedETHController` on the resolver, and `PublicResolver.isAuthorised`
returns true unconditionally for that address, so the controller holds standing authority
to write any record on any node. Today it uses that only during registration, on the node
being registered — but that restraint lives in its code. `BaseRegistrar`'s immutable
`require(available(id))` protects ownership from a malicious controller; only a frozen
implementation protects records. Once frozen, the retained owner's whole surface is
bounded by what §4 of the launch-to-freeze plan enumerates.

**Pricing stays changeable; the sales switch does not.** A frozen oracle is a liveness risk
with no recovery: the Chainlink feed is `immutable` inside the oracle, so a retired feed
would end registration and renewal forever. A live sales switch is a censorship risk with
no recovery either, since a permanently paused payable path could never be reopened. So the
freeze locks the switch and leaves the oracle alone. The residual risk — an owner pricing
renewals out of reach so names lapse — is the only path by which any retained key reaches a
name someone already owns, and it needs the change to stay public through the timelock and
then through every name's remaining term plus 90 days of grace, with renewal permissionless
the whole time.

**Powers are split by how fast their harm accrues, not by contract.** A power sits on the
untimelocked guardian key only when the harm it answers outruns a timelock delay. Zeroing
registrar credits qualifies: a compromised registrar mints junk names every block and each
one is permanent. Pausing the payable path qualifies for the same reason. Fixing a dead
price feed does not: it is an outage, and `GRACE_PERIOD` is 90 days with `renew` working
throughout, so nobody can lose a name while the repair is scheduled.

**Controls with two directions are split between the keys.** The restrictive direction goes
to the guardian, because it is what answers an incident, is reversible by the admin, and can
never acquire anything; the permissive direction stays behind the timelock. So
`setPublicSalesOpen` and `addReservedNames` are callable by the owner or the beneficiary,
while `removeReservedNames` and `registerReserved` are owner-only. Reserving in particular
cannot be timelocked: a scheduled `addReservedNames` announces which name is valuable and
how long it stays unprotected, which invites the squatting it exists to prevent. It is also
harmless in the wrong hands — it acquires nothing, does not affect a registered name, and
`renew` never consults the reserved list, so a holder cannot be squeezed by it.

**The beneficiary is permanent and independent of the owner.** `setBeneficiary` is
callable by the owner only while the beneficiary is unset, so setting it before the
ownership handover makes the guardian Safe independent of the admin from the first block.

**`BaseRegistrar`'s owner is retained too.** `addController` is the only recovery path from
a frozen, buggy controller, and it cannot touch a live name because `_register` requires
`available(id)`. It is owned by the admin timelock like the other two.

**`Root`'s owner stays at the admin timelock** after the lock. Once `simplex` is locked nobody
can re-point the TLD, and the only remaining power is `setResolver` on the root node.

**Six price rungs, not five.** `StablePriceOracle` applied `price5Letter` to every name of
five characters or more, so a six-character name could not be priced apart from a
five-character one — which is what the published pricing has always assumed. A sixth
constructor entry splits them; a five-entry array behaves exactly as before, so every
existing caller is unaffected.

**Controller storage is append-only.** `.simplex` stays UUPS-upgradeable until
`freeze()`, so every implementation until then must preserve the layout.

**`_registerCore` is extracted rather than duplicated.** Ninety lines of registration
logic living in two places is where a divergence bug hides. `SimplexController` is a
heavily customised fork, not verbatim ENS, so keeping `register` byte-identical in the
`main...simplex` diff buys less than the duplication costs.

## 6. Storage layout

Appended after `_reentrancyStatus`, before `__gap`, per
`ens-contracts/docs/upgrades.md`:

```
slot n+0   address beneficiary;      bool frozen;              // packed
slot n+1   mapping(address => uint256) registrarAllowance;     // attoUSD
slot n+2   address defaultResolver;  bool publicSalesOpen;     // packed
slot n+3   uint256 editCreditPriceUSD;
           uint256[44] __gap;                                  // was 48
```

`EDIT_CREDITS_PER_YEAR` is a constant and consumes no slot.

## 7. Deployment, handover and freeze

Dates and the full custody model are in the launch-to-freeze plan; this is the contract
view of the same sequence.

1. **30 Oct 2026** — deploy per W7, reserve the ~3000 a-priori names, verify on Etherscan,
   tag the commit (`simplex-mainnet-v1`). `publicSalesOpen` false, `Root.locked("simplex")`
   false.
2. **2 Nov 2026** — governance handover. Before it, confirm `editCreditPriceUSD` is
   non-zero and the six-entry curve is in place: both are owner-only, so after the handover
   they move at the timelock's pace. `setBeneficiary(guardianSafe)` first, since it is
   owner-callable only while unset, then ownership of all three ownable contracts to the
   admin timelock. `SimplexController` is `Ownable2Step`, so the timelock's
   `acceptOwnership` is itself a scheduled call and lands 9 Nov; `BaseRegistrar` and `Root`
   are single-step and finish on 2 Nov. Hard deadline 12 Nov, when third parties first own
   names.
3. **2–3 Nov 2026** — guardian Safe calls `setRegistrarAllowance` for the registrar hot
   wallet. Instant, so it does not wait on the timelock or on the handover completing.
4. **12 Nov – 11 Dec 2026** — investor window. Registrations flow through
   `registerWithCredit`; `publicSalesOpen` stays false.
5. **12 Dec 2026** — guardian Safe calls `setPublicSalesOpen(true)`.
6. **1 Mar 2027 at the earliest**, gated on production experience rather than the calendar:
   confirm `publicSalesOpen == true`, then `Root.lock(labelhash("simplex"))`, then
   `freeze()`, both executed from the timelock. The controller owner is **not** renounced
   and the price oracle is **not** frozen.

Brand reservation and `registerReserved` survive the freeze, so brand outreach does not
gate it. What gates it is having no open bug against the implementation, since `freeze()`
removes the only way to fix one.

## 8. Redeploy contingency

The point of no return is the first user-owned name. Deployment is 30 Oct and the
all-live milestone 2 Nov, but the first third-party owner appears on 12 Nov. Everything
before that is our own state, and the a-priori reserved set replays in one batch. So
30 Oct – 11 Nov is a live rehearsal at no extra cost: if something is wrong, redeploy and
move the addresses.

While `simplex` is unlocked, the cheap variant is available — keep the `ENSRegistry` and
re-point the TLD at a new registrar, which leaves the resolver service untouched. This is
why `Root.lock` sits at the freeze and not at deployment. After 12 Nov a redeploy is still
recoverable but no longer free: names must be re-minted to their holders, records
rewritten, and stealth-received names reconstructed from the announcements.

The client holds no contract address — `Simplex/Chat/Names.hs` has none, and resolution
goes over SMP to the names role — so a redeploy never requires an app release. What does
change: `deployments.mainnet.simplex.json` and `verification.mainnet.simplex.json`;
`SNRC_REGISTRY_SIMPLEX` for `snrc-resolve.py`, and nothing at all if the registry is kept;
the names service's registrar and controller addresses and its announcement scan start
block; `ens-metadata-service`'s `ADDRESS_ETH_REGISTRAR` and `ADDRESS_ETH_REGISTRY`;
`ens-subgraph/subgraph.yaml` addresses and start blocks plus a re-index; and in
`ens-app-v3`, `.env.simplex`'s `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES`,
`deploy/01_get_contract_addresses.ts`, its copy of the deployments JSON, and
`src/constants/{chains,resolverAddressData,tldData}.ts`, which are keyed by chain id and
must move together. Then Etherscan verification.

## 9. Requirements handed to the names service

These carry security properties the contracts deliberately do not:

- Pre-flight simulate every relayed transaction and refuse to submit above a gas
  threshold. This covers both oversized payloads and the gas an ERC-1271 fallthrough would
  otherwise make the relayer pay for when a signature fails against a contract "owner".
- Validate payload sizes and entry counts at request time, before a credit is spent.
- Treat the thresholds as tunable configuration, not constants.
- Monitor the registrar allowance with generous headroom, in money rather than in
  operations: exhaustion is a hard service stop only the guardian Safe can clear.

## 10. Test plan

New files under `ens-contracts/test/simplex/`, following the existing fixture idiom:

- `TestRegistrarAllowance.test.ts` — a sponsored registration deducts the name's list
  price in attoUSD and attaches no value; a longer term and a shorter label cost more; the
  deduction is unchanged when the ETH price moves; the allowance refuses a name it cannot
  cover; the payable path is unaffected and still refunds; `setRegistrarAllowance` zeroes
  in one transaction; only the beneficiary may call it.
- `TestEditCreditGrants.test.ts` — `10 × years` on register and renew; a renewal by an
  unrelated address adds; a registration against a non-default resolver grants nothing;
  floor rounding at 364 and 366 days; `registerReserved` sets `defaultResolver` on the
  node and grants credits.
- `TestTopUpEditCredits.test.ts` — a top-up deducts `editCreditPriceUSD` per credit, is
  additive, refuses when the allowance cannot cover it, and only the owner may reprice.
- `TestClearRecordsWithSig.test.ts` — type-hash pinning, one credit spent, every prior
  record reads empty, wrong signer, replay, expiry, refusal at zero credits.
- `TestSubnameRelayedEdit.test.ts` — the 2LD holder signs an edit for a subname and it
  lands; a non-holder's does not.
- `TestApproveAllWithSig.test.ts` — type-hash pinning, a relayer lands the owner's signed
  approval, revocation by signing `approved = false`, wrong signer, replay, expiry, and
  that the result is identical to the transaction form.
- `TestCreateSubnameWithSig.test.ts` — end to end with no ETH at the owner's address:
  signed approval, signed creation, relayed edit on the new subname; plus wrong signer,
  replay, expiry, and creation refused without the approval.
- `TestPublicSalesSwitch.test.ts` — the payable path reverts while closed and succeeds
  when open; `registerWithCredit`, `registerReserved` and both renews are exempt; the
  switch is two-way before the freeze and reverts after it; owner and beneficiary may both
  flip it and nobody else may.
- `TestAdminSplit.test.ts` — the access split the custody model depends on:
  `addReservedNames` accepts owner and beneficiary; `removeReservedNames`,
  `registerReserved`, `setDefaultResolver`, `setMinCharLength`, `setPriceOracle` and
  `freeze` and `setEditCreditPrice` accept the owner only and reject the beneficiary;
  `setRegistrarAllowance` and
  `setBeneficiary` accept the beneficiary only and reject the owner.
- `TestBeneficiaryAndFreeze.test.ts` — beneficiary bootstrap and permanence, `withdraw`
  pays the beneficiary and not the owner, `freeze` blocks `upgradeTo`, `upgradeToAndCall` and
  `setPublicSalesOpen` and is one-way, while `setPriceOracle`, `registerReserved` and the
  reserved-name setters still work afterwards — so the retained surface is exactly what the
  launch-to-freeze plan enumerates and nothing more.
- `TestControllerStorageLayout.test.ts` — the append-only discipline, by raw slot
  inspection rather than the OZ upgrades plugin, which this repo does not carry: that
  `beneficiary` packs with `frozen`, `defaultResolver` with `publicSalesOpen`, that the new
  slots sit immediately after `_reentrancyStatus`, and that the allowance mapping hashes out
  of the linear range.
- `TestRegistrarAllowance.test.ts` also walks the price ladder — a name at each rung from
  thirteen characters down to three — asserting the deduction matches that length's price,
  that an allowance covering a long name refuses a short one, and that the deduction is
  unchanged when the ETH price moves.
- A mainnet fork test of registration → edit → transfer → accept. **Not run** — it needs an
  `INFURA_API_KEY`.

Existing suites stay green, in particular `TestSimplexController.test.ts`, which exercises
the register and renew bodies that W1 refactors.

## 11. Sequencing

Steps 1 and 2 are done; the rest are outstanding. Inside the contract window,
7 Sep – 29 Oct:

1. W1 and W2 with their tests — the largest, and what everything else depends on.
2. W3, W4, W5, W6 — independent of W1, can run in parallel. W5 gets the most review time
   of anything in this plan.
3. W7 on a local chain, then against a mainnet fork.
4. W9, written before the deployment rather than improvised after it.
5. W8 and W10.
6. Fork rehearsal of §7 end to end, then the 30 Oct deployment, then the §8 window as the
   live rehearsal: the sponsored journey, the payable path, the sales switch, and
   `transferWithSig` recovered from a seed.

## 12. Out of scope

Client crypto, the wallet, the names service, payments and UI. Refunds. The secondary
market. `.testing`, which is left as it stands. ERC-6538, ERC-4337 and ERC-2771.
