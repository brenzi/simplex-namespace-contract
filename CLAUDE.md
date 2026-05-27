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

Set via `setText(node, "simplex.contact", value)`, read via `text(node, "simplex.contact")`. Standard ENS text-record pattern.

## Admin capabilities

- `setNftGateEnabled(false)` — one-way (true→false)
- `setMinCharLength(uint8)` — monotonic decrease only (6→5→4→3)
- `addReservedName` / `removeReservedName` / `registerReserved`
- `setTreasury` (where ETH fees go)
- UUPS upgrade authority (can be renounced)

## Toolchain

- Node 20.x (`/usr/bin/node`), pnpm 9.x
- Solidity 0.8.24, Hardhat 2.x, optimizer 200 runs, evmVersion paris
- OpenZeppelin Contracts v5 (UUPS, ERC-721, ERC-1155, ERC-20, Ownable)
- Frontend: Next.js + styled-components + wagmi/viem (fork of ens-app-v3, logo swap only)
- Tests: Hardhat + ethers v6 (contracts), Playwright (e2e)

## Deployment targets

- **Local**: Hardhat node, MockSMPXNFT + DummyOracle (fixed ETH/USD rate)
- **Hoodi testnet**: chainId 560048, MockSMPXNFT + DummyOracle
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

Fork ens-app-v3, minimal diff. Each frontend deployment targets one TLD.
- **Branding**: swap logo and favicon only. No theme/color/font changes.
- **Contract rewiring**: replace `@ensdomains/ensjs` calls with direct viem calls to SNRC contracts via `src/contracts/snrc.ts`
- **Disable**: DNS import, ENS v2 migration, legacy favourites, on-chain subname UI, image upload/display — short-circuit, don't delete
- **Payment**: ETH — same as ENS, no changes to payment flow
- **Adapt**: TLD name in config (not a selector), profile (highlight simplex.contact/channel fields), pricing display
- **Add**: admin panel page, NFT gate indicator (.testing only)
