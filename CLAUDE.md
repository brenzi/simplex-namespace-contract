# CLAUDE.md — SimpleX Namespace Registry Contract (SNRC)

Implementation plan: [`snrc-implementation-plan.md`](./snrc-implementation-plan.md).

## BINDING: Minimize diff to upstream

This project forks ENS contracts and ENS app v3. The #1 priority is **minimal diff to upstream** for auditability. Every changed line must be justified.

Rules:
- **Do NOT rename files** unless the contract's interface/behavior actually changes. `ENSRegistry.sol` stays `ENSRegistry.sol`.
- **Do NOT restyle the frontend.** Keep ENS's Thorin design system, colors, fonts, layout. Only swap logo/favicon.
- **Do NOT refactor, reformat, or "clean up"** ENS code. Match their style even if you'd do it differently.
- **Do NOT add comments** explaining what you changed or why — that belongs in commit messages and the plan, not in the diff.
- **Do NOT add abstractions** "for flexibility" — if a one-line change works, don't wrap it in a helper.
- **Disable features by short-circuiting** (early return, skip rendering), not by deleting ENS code.
- **UUPS wrapping is mechanical**: constructor→initialize, add UUPSUpgradeable inheritance, add _authorizeUpgrade. No other changes to the contract body.
- **Do NOT rename variables, functions, or files** unless the name is actively misleading after our changes.
- **Do NOT move code** between files unless scope genuinely needs to change.
- Anything not strictly required by our functional changes is **completely prohibited** — no drive-by refactoring, no "making code better."
- When in doubt, leave ENS code untouched. A smaller diff is always better.

## What this is

GitHub forks of [ENS contracts](https://github.com/ensdomains/ens-contracts) + [ENS app v3](https://github.com/ensdomains/ens-app-v3) adapted for SimpleX Chat's decentralized namespace system. Maps human-readable names (`alice.simplex`) to categorized SimpleX short link data (contact links, channel links) on Ethereum.

## Repo structure

Public forks as git submodules of this repo:

```
simplex-namespace-contract/           ← this repo (parent)
  ens-contracts/                      ← submodule → simplex-network/ens-contracts
  ens-app-v3/                         ← submodule → simplex-network/ens-app-v3
  scripts/                            ← cross-repo deployment helpers
  docs/                               ← project-level docs
  test/                               ← cross-repo test fixtures
```

- `main` in each fork tracks upstream ENS (fetch-only)
- `simplex` branch is our working branch — all SNRC changes here
- `main...simplex` diff on GitHub is the audit surface
- This parent repo holds the plan, docs, and cross-repo tooling

## Architecture

Two separate deployments — one per TLD. Each is a near-standard ENS deployment with a custom controller. `.testing` launches first.

- `.testing` — NFT-gated (SMPXNFT holders only initially), 6+ char minimum, reserved names
- `.simplex` — NO NFT gate, 6+ char minimum, reserved names

Each deployment: `ENSRegistry` + `BaseRegistrarImplementation` + `SimplexController` + `PublicResolver` + `NameWrapper` + `Root` + `ReverseRegistrar`. All ENS contracts verbatim except `SimplexController`.

`SimplexController` is UUPS-upgradeable (ERC-1967 proxy). Every upgrade must preserve its storage layout — see [`ens-contracts/docs/upgrades.md`](./ens-contracts/docs/upgrades.md) for the `__gap` / append-only invariants and the pre-upgrade checklist.

Resolver: ENS `PublicResolver` used verbatim. SimpleX links stored as text records: `simplex.contact`, `simplex.channel`.

Subnames are on-chain (via NameWrapper), not off-chain. This diverges from the current whitepaper draft but is the intended design. NameWrapper also enables marketplace trading of names as ERC-1155 tokens.

Payment is ETH (same as ENS). Pricing: $1/year (6+ chars), $8 (5), $32 (4), $128 (3). ENS price oracle verbatim.

## Key references

- Whitepaper: `/work/community-credits-whitepaper/community_credits_whitepaper.tex` (§Public Namespaces, §SNRC definition)
- RFC PR: https://github.com/simplex-chat/simplex-chat/pull/7001
- ENS contracts: https://github.com/ensdomains/ens-contracts
- ENS app v3: https://github.com/ensdomains/ens-app-v3
- Community credits PoC: `/work/simplex-community-credits-poc/` (match Solidity 0.8.24 + Hardhat conventions)

## NFT gate contract (mainnet)

Address: `0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291`
Name: "SimpleX NFT: SMPX testnet access", Symbol: SMPXNFT, ERC-721, 560 tokens.
Key non-standard functions: `setMinter(address)`, `setNextTokenURI(string)`, `lockMintingPermanently()`, `burn(uint256)`, `withdraw()`. Sequential token IDs via `nextTokenId` counter. Gate check is `balanceOf(sender) > 0`.
`MockSMPXNFT.sol` replicates this interface for local/testnet.

## SimpleX data in resolver

ENS PublicResolver used verbatim. SimpleX links stored as text records:
- `simplex.contact` — contact short link (1:1 messaging)
- `simplex.channel` — channel short link (group/channel)

Both records store a **comma-separated list** of URLs (primary first, fallbacks after) so a name can advertise multiple SMP servers for redundancy. Clients SHOULD try them in order. The on-chain layer is unchanged — it's still a plain `setText` / `text` against the ENSIP-5 key. The SNRC REST resolver (`scripts/resolver/snrc-resolve.py`) parses the CSV and returns each as `string[]` (`simplexContact`, `simplexChannel`). The dApp's editor caps the list at 5 entries.

## Admin capabilities

- `setNftGateEnabled(false)` — one-way (true→false)
- `setMinCharLength(uint8)` — monotonic decrease only (6→5→4→3)
- `addReservedNames` / `removeReservedNames` / `registerReserved` (the two reserved-name setters take string arrays — bulk in a single tx, ~1000/call)
- `setTreasury` (where ETH fees go)
- UUPS upgrade authority (can be renounced)

## Deviations from `snrc-implementation-plan.md`

- **NameWrapper not UUPS-wrapped.** Plan called for it (for upgradeability + marketplace flexibility), but NameWrapper is 25,925 bytes — already over the 24,576-byte EIP-170 limit before UUPS boilerplate is added. Adding `UUPSUpgradeable + Initializable + _authorizeUpgrade` pushes it to ~27,500 bytes. Two options were considered and rejected: BeaconProxy (same size constraint) and slimming NameWrapper by stripping ReverseClaimer/ERC20Recoverable/legacy upgrade path (too large a diff from upstream ENS, hurts auditability). Decision: keep NameWrapper verbatim, accept non-upgradeability. If a serious bug requires fixing post-launch, migrate names to a new wrapper via the existing `upgradeContract` hook ENS already provides.

## Toolchain

- Node 22.x, pnpm 9.x
- Solidity 0.8.26, Hardhat 3.x (ENS upstream uses this)
- OpenZeppelin Contracts v5 (UUPS, ERC-721, ERC-1155, ERC-20, Ownable)
- Frontend: Next.js + styled-components + wagmi/viem (fork of ens-app-v3, logo swap only)
- Tests: Hardhat + ethers v6 (contracts), Playwright (e2e)

## Deployment targets

- **Local**: Hardhat node, MockSMPXNFT + DummyOracle (fixed ETH/USD rate)
- **Sepolia testnet**: chainId 11155111, MockSMPXNFT deployed once + Chainlink ETH/USD feed (`0x694AA17…`)
- **Mainnet**: Chainlink ETH/USD oracle, real SMPXNFT (`0x3AF6D9Ee...`), treasury = SNCC multisig

## Deployment order (per TLD)

Each TLD is an independent deployment:

1. MockSMPXNFT (local/testnet only, shared)
2. ENSRegistry (UUPS proxy)
3. PublicResolver (verbatim ENS)
4. ReverseRegistrar
5. Root → transfer registry root → assign TLD ownership → lock
6. BaseRegistrarImplementation (UUPS proxy)
7. Price oracle (DummyOracle local / Chainlink mainnet) + ExponentialPremiumPriceOracle
8. SimplexController (NFT gate on for .testing, off for .simplex)
9. Add controller to base registrar
10. NameWrapper (UUPS-wrapped, verbatim ENS)
11. Output addresses to `deployments/<network>-<tld>.json`

## Conventions from the PoC to follow

- Use `hardhat.config.ts` (not `.cjs`), but match PoC's solc settings
- ethers v6 footguns: `NonceManager` doesn't auto-increment across calls; `signer.reset()` after expected reverts; use `await signer.getAddress()` not `signer.address`

## Frontend approach

Fork ens-app-v3, minimal diff. Each frontend deployment targets one TLD via `NEXT_PUBLIC_SIMPLEX_TLD` env var.

### Done
- **ensjs patch**: `getNameType` + `validation` patched so `.testing`/`.simplex` are treated as eth-like TLDs (pnpm patch, 4 one-line changes)
- **TLD support**: all `.endsWith('.eth')` checks expanded to include our TLDs
- **Search**: bare name search appends configured TLD
- **Branding**: placeholder logo SVGs (need real SimpleX logo)
- **Disable**: DNS import, ENS v2, legacy favourites, ENS nav links — short-circuited
- **Images**: avatar upload hidden, avatar display disabled (useEnsAvatar returns null)
- **Chains**: Sepolia testnet wired (Hoodi was rejected — Sepolia gives us Chainlink ETH/USD and a public subgraph)
- **Config**: `.env.simplex` with all env vars, contract addresses via `NEXT_PUBLIC_DEPLOYMENT_ADDRESSES`
- **Build**: `pnpm build` passes

### Remaining
- **Admin panel**: new page for reserved names, char length, NFT gate management
- **NFT gate indicator**: show NFT requirement on .testing registration
- **Pricing display**: show $1/$8/$32/$128 instead of ENS pricing
- **Real logo**: replace placeholder SVGs with SimpleX brand assets
- **End-to-end test**: deploy contracts to Hardhat, point frontend, verify full registration flow
- **Subgraph**: ENS app relies on The Graph for name queries — local dev without subgraph limits some features

## Gotchas / time-sinks learned the hard way

Don't re-derive these. Check here first.

### Hardhat 3 (`hardhat@3.x` with `npx hardhat node`)
- `npx hardhat node` uses the network named **`default`**, NOT `hardhat`. Setting `chainId` on the `hardhat` network in config does nothing. To get a non-default chainId, run `npx hardhat --network hardhat node`. Run script does this.
- Default in-memory chainId is **31337**. Viem's `localhost` chain (which the ENS app uses) is **1337**. We standardised on 1337 so they match. If the test wallet's chainId differs from RPC's, `eth_sendRawTransaction` rejects with "invalid chainId".
- Hardhat 3 doesn't implement `eth_createAccessList` (returns -32004). Viem uses this for gas-tightening; we patched `createAccessList.ts` to swallow that error and return an empty list.
- `eth_estimateGas` with state overrides (3rd param) returns a JSON-parse error "trailing characters". Hardhat doesn't accept state overrides. The fallback in `createAccessList` returning empty avoids this.
- Hardhat's block.timestamp drifts ahead of wall-clock after every `evm_increaseTime`. The advance is permanent for the node session. Fresh restart resets it. Frontend's CountdownCircle compares `block.timestamp*1000` against `Date.now()`, so big drift breaks the wait.

### viem batching
- viem batches reads via Multicall3's `aggregate3` (`0x82ad56cb`), **NOT `tryAggregate`**. Our mock must implement both. Symptom: every read fails with Hardhat "Internal error" → wagmi shows `data: undefined`.

### ENS app local dev expectations
- `useEthPrice` hardcodes `eth-usd.data.eth` — must be registered locally with addr → DummyOracle. Without it, the Pricing-step Next button is disabled forever ("Loading"). Deploy script handles this.
- `localhost` chain in ENS app's frontend config = chainId 1337. Resolver address tables in `src/constants/{resolverAddressData,tldData}.ts` key off `'1337'`. If you change one, change all.

### Process hygiene
- Always `pkill -9 -f "hardhat\|next\|playwright"` AND `lsof -ti :8545 :3000 | xargs -r kill -9` before restarting the stack. Background playwright runs from prior turns will silently re-grep the same test you're trying to run now.
- `pnpm dev` Fast Refresh can get stuck in a reload loop after many code edits in the same session — `rm -rf ens-app-v3/.next` between major restarts.
- `bash scripts/run-local.sh` must run from `/work/simplex-namespace-contract/` (it doesn't `cd` to repo root).

### PublicResolver `trustedETHController` parameter
- PublicResolver constructor takes `(ENS, NameWrapper, trustedETHController, trustedReverseRegistrar)`. Passing zero for trustedETHController means the controller **cannot** write resolver records during `register()`. Symptom: register reverts deep in `multicallWithNodeCheck` (used when `registration.data` is non-empty, e.g. setting a resolver + addr record + reverseRecord). The deploy script must deploy the controller FIRST, then the resolver with the controller address as the trusted controller. Don't pass zeroAddress.
- Same applies to `trustedReverseRegistrar`. We pass the ReverseRegistrar address there.

### Playwright fixture playbook (steal from ens-app-v3)
- `ens-app-v3/playwright/fixtures/time.ts` already solves the wall-clock vs block-clock issue: `page.clock.install({ time: blockTimestamp })` overrides browser `Date.now()` to match chain time, then `page.clock.runFor(ms)` + `testClient.increaseTime` advance both in lockstep. Use this pattern instead of `await page.waitForTimeout(60000)`.
- `ens-app-v3/e2e/specs/stateless/registerName.spec.ts` is a 2391-line existing test for the full registration flow. Before writing custom e2e tests from scratch, check whether an adapted ENS spec covers the same flow — that's likely the lower-diff path long-term.

### Stateful test names
- Hardhat runs in a single shared session — names registered by one test persist for the rest of the suite. Either use unique per-run name (e.g. `reg${Date.now().toString(36)}`) or reset chain state between tests. Symptom: a test passes when run alone but fails in suite (the previously-registered name is no longer `available`).
