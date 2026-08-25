# `.simplex` — launch to freeze

Who controls the contracts, from deployment to the freeze. Dates match
`launch-names-v2.gan`. Contract changes are in
[`names-v2-contracts.md`](./names-v2-contracts.md).

## 1. Table of contents

1. Table of contents
2. Timeline
3. The keys
4. Powers, before and after the freeze
5. What no key can ever do
6. Why it is built this way
7. Appendix A — transition recipes

## 2. Timeline

| Date | Change |
|---|---|
| 30 Oct 2026 | `.simplex` deployed and the ~3000 a-priori names reserved, both by the deploy key. Public sales closed. |
| 2 Nov 2026 | Handover starts. `setBeneficiary` and two of three ownership transfers. |
| 2–3 Nov 2026 | Guardian Safe funds the registrar. First real use of the new setup. |
| 4 Nov 2026 | Contracts, registrar, app and codes all live. |
| 9 Nov 2026 | Timelock accepts the controller. The deploy key owns nothing and is destroyed. |
| 12 Nov 2026 | Investor window opens. **Hard deadline for handover** — first names owned by third parties. |
| 12 Dec 2026 | Public sales open. Admin Safe at 3-of-5 by this date. |
| 22 Feb 2027 *(earliest)* | Admin Safe schedules `Root.lock` and `freeze()` in the timelock. |
| 1 Mar 2027 *(earliest)* | Both executed. Contracts frozen. |

The freeze dates are the earliest, not a commitment. Every other date in the table is
binding. The freeze happens when the gate in §7, A7 is met; if it is not met, the date
moves out.

## 3. The keys

**Deploy key** — one hot EOA. Exists 30 Oct to 2 Nov only. Owns everything in that window,
then nothing. Never used again.

**Admin timelock** — an OpenZeppelin `TimelockController`, 7-day delay. Owns `Root`,
`BaseRegistrarImplementation` and `SimplexController` from 2 Nov onwards, permanently.
Every admin action is scheduled publicly and executes a week later.

**Admin Safe** — proposes to the timelock. One hardware wallet minimum at handover, 3-of-5
by 12 Dec 2026. Signers geographically distributed.

**Guardian Safe** — 2-of-4, called directly, no delay. It is the controller's
`beneficiary`. Holds the incident-response powers and receives revenue. Also a canceller on
the timelock.

**Registrar hot wallet** — owns nothing. Held in KMS by the names service. Pays gas, spends
registrar credits, submits relayed user signatures.

## 4. Powers, before and after the freeze

| Key | 2 Nov 2026 to the freeze | After the freeze |
|---|---|---|
| Deploy key | nothing | nothing |
| Admin timelock (7 days) | upgrade the controller; `removeReservedNames`; `registerReserved`; `setMinCharLength`; `setDefaultResolver`; `setPriceOracle`; `recoverFunds`; `addController`; `removeController`; `setMetadataRenderer`; `setMaxLabelLength`; `setSubnameHook`; `baseRegistrar.setResolver`; `Root.setResolver`; `Root.setController`; `Root.lock`; `freeze()` | same, minus upgrade and minus `freeze()`, which are spent |
| Admin Safe | proposes and executes timelock actions; adds and removes its own signers | same |
| Guardian Safe (instant) | `addReservedNames`; `setPublicSalesOpen`; `setRegistrarCredits`; `setBeneficiary`; receives `withdraw()`; cancels timelock actions | same, minus `setPublicSalesOpen` |
| Registrar hot wallet | `registerWithCredit`; `renewWithCredit`; `topUpEditCredits`; relaying signed user intents | same |
| Anyone | `commit`; payable `register` and `renew`; `withdraw`; all signed-intent paths; own-name record writes; `reclaim`; subname create and delete; `purge` | same |

`disableNftGate` is the one owner function not listed. `.simplex` deploys with the gate
already off and the function reverts when it is, so it is inert from day one.

Three powers exist after the freeze because losing them would be worse than keeping them.
`registerReserved` and `addReservedNames` keep brand outreach open with no end date.
`addController` is the only repair path if the frozen controller has a bug.
`setMetadataRenderer` is how NFT artwork is updated, since the renderer is immutable and
gets replaced rather than edited.

## 5. What no key can ever do

No key can take, transfer or re-point a name that someone owns. `_register` requires
`available(id)`, which is false until 90 days past expiry, and that check is in the
immutable registrar. `reclaim` needs the token holder. `transferWithSig` needs the owner's
signature. After the freeze, no key can change the controller's code, so no key can
write records on a name it does not own.

One indirect path exists and is not closed: the admin can set a hostile price oracle,
price renewals out of reach, and take names as they lapse. It needs a public 7-day
schedule, then each name's remaining term plus 90 days of grace, and renewal is
permissionless throughout — anyone can renew anyone's name at the old price meanwhile.

## 6. Why it is built this way

**Two keys, not one.** A power sits on the instant key only when the harm it answers
happens faster than 7 days. A compromised registrar mints junk names every block, so
zeroing its credits must be instant. An exploit in the payable path accrues per block, so
pausing must be instant. Fixing a dead price feed is an outage, not a loss — 90 days of
grace means nobody loses a name while the repair is scheduled — so it can wait.

**Restrictive powers are instant, permissive ones are delayed.** The guardian can reserve a
name, pause sales and cut credits. The admin releases reserved names, hands names to
brands, funds registrars and opens sales. Reserving in particular cannot be delayed: a
scheduled `addReservedNames(["nike"])` tells a squatter which name is valuable and how long
it stays unprotected. Reserving is also safe in the wrong hands — it acquires nothing,
does not affect a registered name, and `renew` never checks the reserved list.

**Safes rather than hardware wallets.** Every signer holds a hardware wallet either way;
the choice is one device or several behind a Safe. One device is a single point of failure
in both directions: lose it and admin is gone, steal it and admin is taken. It also cannot
be rotated safely here — `BaseRegistrar` uses single-step `Ownable` and `Root` uses a
version with no zero-address check, both immutable, so rotating a device key means an
unverified one-shot `transferOwnership` where a wrong address is permanent. With a Safe the
owner address never changes and signers rotate inside it. A Safe also survives a signer
leaving, and gives per-signer attribution on chain.

**A timelock behind the admin Safe.** The known Safe failure mode is signers approving what
they cannot verify. The timelock means a bad transaction is scheduled, not executed, and the
guardian Safe can cancel it — so the people who were tricked are not the only ones who can
undo it.

**7 days, not 48 hours.** The bound on hostile pricing is that people see it coming and
renew. Longer is better for that. It costs patience on brand registrations, which are never
urgent.

**The price oracle stays changeable.** `StablePriceOracle.usdOracle` is `immutable`, so
changing the Chainlink feed needs a new oracle. Chainlink has retired feeds before. A frozen
oracle with a retired feed would break registration and renewal permanently, with no
recovery on any key.

**The sales switch does not stay changeable.** A permanently paused payable path could never
be reopened, so `freeze()` closes the switch in whatever position it holds.

**The freeze date is a floor, not a deadline.** It removes the only repair path for a bug in
the controller, and `Root.lock` removes the only cheap redeploy path, so it should happen
only after enough production use to be confident in both. 1 Mar 2027 is about eleven weeks
of public operation after 12 Dec. Slipping costs nothing operationally — brand reservation,
`registerReserved` and everything else survive the freeze — but it keeps the upgrade power
alive, and that is the one unbounded power in the system. So: not before the gate is met,
and not long after.

## 7. Appendix A — transition recipes

Every on-chain call, in order, with who signs it.

### A1. Deployment — 30 Oct 2026

Caller: **deploy key**, alone.

1. Deploy `ENSRegistry`, `Root`, `BaseRegistrarImplementation`, price oracle,
   `SimplexController` implementation and proxy, `SubnameRegistrar`, `SimplexResolver`,
   `MetadataRenderer`, `UniversalResolver`.
2. `Root.setController(deployKey, true)`; `Root.setSubnodeOwner(labelhash("simplex"), baseRegistrar)`.
3. `baseRegistrar.addController(controllerProxy)`; `baseRegistrar.setMetadataRenderer(renderer)`;
   `baseRegistrar.setMaxLabelLength(63)`; `baseRegistrar.setSubnameHook(subnameRegistrar)`.
4. `subnameRegistrar.setResolver(simplexResolver)`.
5. `controller.setDefaultResolver(simplexResolver)`.
6. `controller.addReservedNames([...])` for the ~3000 a-priori names, in batches of about
   300. Roughly 24k gas per name, so about 7M gas per batch and 70M in total — run it at a
   low base fee, which `deploy-mainnet.mjs` already supports through `MAX_BASE_FEE_GWEI`.
   The list is final from 15 Oct, so it is ready.
7. Leave `publicSalesOpen == false` and `Root.locked("simplex") == false`.

Reserving here rather than after the handover is not closing an open hole — `publicSalesOpen`
is false and the registrar has no credits, so nothing can be registered before 12 Nov
anyway. It removes a task that could slip, and it makes the reserved set part of the
deployment's acceptance check rather than a separate errand.

Prerequisite, before this date: both Safes deployed and each has executed one rehearsal
transaction; the `TimelockController` deployed with proposer = admin Safe, cancellers =
admin Safe and guardian Safe, executor = open, delay = 7 days.

### A2. Handover — 2 Nov 2026

Order matters. `setBeneficiary` is owner-callable only while unset.

| # | Caller | Call |
|---|---|---|
| 1 | deploy key | `controller.setBeneficiary(guardianSafe)` |
| 2 | deploy key | `controller.transferOwnership(adminTimelock)` |
| 3 | admin Safe → timelock | schedule and execute `controller.acceptOwnership()` |
| 4 | deploy key | `baseRegistrar.transferOwnership(adminTimelock)` |
| 5 | deploy key | `root.setController(adminTimelock, true)` and `root.setController(deployKey, false)` |
| 6 | deploy key | `root.transferOwnership(adminTimelock)` |

Step 3 sits in the timelock for 7 days, so schedule it on 2 Nov and execute on 9 Nov;
steps 4–6 can complete on 2 Nov. Between step 2 and step 3 the deploy key can still cancel
by transferring ownership elsewhere, so the deploy key is destroyed only after step 3
executes and the checks below pass.

Verify: `owner()` is the timelock on all three contracts; `beneficiary()` is the guardian
Safe; every former deploy-key call reverts.

### A3. Guardian's first use — 2–3 Nov 2026

Caller: **guardian Safe**, 2 signatures.

1. `controller.setRegistrarCredits(registrarHotWallet, N)` — sized to expected demand plus
   headroom.

This works even though A2 step 3 is still pending, because `setRegistrarCredits` is
beneficiary-only and does not depend on who currently owns the controller.

### A4. Open public sales — 12 Dec 2026

Caller: **guardian Safe**, 2 signatures. `controller.setPublicSalesOpen(true)`.

### A5. Admin Safe to 3-of-5 — by 12 Dec 2026

Caller: **admin Safe**, current threshold. Safe transactions, not contract calls: add
owners, then `changeThreshold(3)`. No contract ownership moves. Same procedure for any
later rotation, on either Safe, at any time.

### A6. Routine operations — ongoing

| Action | Caller | Call |
|---|---|---|
| Reserve a brand name under threat | guardian Safe, 2 sigs | `controller.addReservedNames([name])` |
| Give a brand its name | admin Safe → timelock, 7 days | `controller.registerReserved(label, brandAddr, duration)` |
| Refill registrar credits | guardian Safe, 2 sigs | `controller.setRegistrarCredits(registrar, N)` |
| Cut off a compromised registrar | guardian Safe, 2 sigs | `controller.setRegistrarCredits(registrar, 0)` |
| Pause payable sales | guardian Safe, 2 sigs | `controller.setPublicSalesOpen(false)` |
| Replace the price oracle | admin Safe → timelock, 7 days | `controller.setPriceOracle(newOracle)` |
| Update NFT artwork | admin Safe → timelock, 7 days | `baseRegistrar.setMetadataRenderer(newRenderer)` |
| Cancel a scheduled admin action | guardian Safe, 2 sigs | `timelock.cancel(id)` |

### A7. Freeze — 22 Feb 2027 at the earliest, executed 7 days later

Gate, all three required before scheduling:

- No open bug or unexplained behaviour against the controller implementation.
- The full sponsored journey has run in production since 12 Dec with no defect that needed
  an upgrade to fix.
- No redeploy under consideration, since `Root.lock` ends that option.

If any fails, move the date out. Do not move it in.

**Scheduling day.** Caller: **admin Safe**, 3 of 5. Schedule two timelock operations:

1. `root.lock(labelhash("simplex"))`
2. `controller.freeze()`

**Seven days later.** Before executing, read `controller.publicSalesOpen()`. If false, the
guardian Safe sets it true first — this is the last moment it can. Then execute both
operations in order. Executor is open, so anyone can submit them.

Verify: `root.locked(labelhash("simplex")) == true`; `controller.frozen() == true`;
simulated `upgradeTo`, `upgradeToAndCall` and `setPublicSalesOpen` all revert; simulated
`setPriceOracle` still succeeds; `owner()` is still the timelock and not `address(0)`.

Then confirm live: a sponsored registration, a relayed record edit, a signed transfer,
`registerReserved`, and `withdraw()` paying the guardian Safe.
