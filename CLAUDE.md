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
- When in doubt, leave ENS code untouched. A smaller diff is always better.

## What this is

Full fork of [ENS contracts](https://github.com/ensdomains/ens-contracts) + [ENS app v3](https://github.com/ensdomains/ens-app-v3) adapted for SimpleX Chat's decentralized namespace system. Maps human-readable names (`alice.simplex`) to categorized SimpleX short link data (contact links, channel links) on Ethereum.

## Architecture

Single `ENSRegistry` (UUPS proxy, unchanged logic) with two TLDs:
- `.simplex` — NFT-gated registration (SMPXNFT holders only initially), 6+ char minimum, reserved names, stablecoin pricing
- `.testing` — open registration, 3+ chars, same pricing

Each TLD has its own `BaseRegistrarImplementation` (ERC-721, UUPS-wrapped, unchanged logic) + `SimplexController` (commit-reveal, pricing, gates — new). One shared `SimplexResolver` stores categorized links per name (`mapping(node => mapping(category => bytes))`) — new. `SNRCNameWrapper` provides ERC-1155 wrapping with fuses (moderate changes from ENS NameWrapper: parameterized TLD support).

Unchanged ENS contracts keep their original filenames for easy diffing against upstream.

Payment is ERC-20 stablecoin (USDC/USDT), not ETH. Pricing: 1 USDC/year base (6+ chars), 8x for 5-char, 32x for 4-char, 128x for 3-char.

## Key references

- Whitepaper: `/work/community-credits-whitepaper/community_credits_whitepaper.tex` (§Public Namespaces, §SNRC definition)
- RFC PR: https://github.com/simplex-chat/simplex-chat/pull/7001
- ENS contracts: https://github.com/ensdomains/ens-contracts
- ENS app v3: https://github.com/ensdomains/ens-app-v3
- Community credits PoC: `/work/simplex-community-credits-poc/` (reuse `TestUSDC.sol`, match Solidity 0.8.24 + Hardhat conventions)

## NFT gate contract (mainnet)

Address: `0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291`
Name: "SimpleX NFT: SMPX testnet access", Symbol: SMPXNFT, ERC-721, 560 tokens.
Key non-standard functions: `setMinter(address)`, `setNextTokenURI(string)`, `lockMintingPermanently()`, `burn(uint256)`, `withdraw()`. Sequential token IDs via `nextTokenId` counter. Gate check is `balanceOf(sender) > 0`.
`MockSMPXNFT.sol` replicates this interface for local/testnet.

## Resolver categories

The resolver uses `bytes32` keys (not a single blob). Initial categories:
- `keccak256("contact")` — SimpleX contact short link
- `keccak256("channel")` — SimpleX channel short link
- Extensible: any `bytes32` key works without contract changes

## Admin capabilities

- `setNftGateEnabled(false)` — one-way (true→false)
- `setMinCharLength(uint8)` — monotonic decrease only (6→5→4→3)
- `addReservedName` / `removeReservedName` / `registerReserved`
- `setTreasury`, `setPaymentToken`
- UUPS upgrade authority (can be renounced)

## Toolchain

- Node 20.x (`/usr/bin/node`), pnpm 9.x
- Solidity 0.8.24, Hardhat 2.x, optimizer 200 runs, evmVersion paris
- OpenZeppelin Contracts v5 (UUPS, ERC-721, ERC-1155, ERC-20, Ownable)
- Frontend: Next.js + styled-components + wagmi/viem (fork of ens-app-v3, logo swap only)
- Tests: Hardhat + ethers v6 (contracts), Playwright (e2e)

## Deployment targets

- **Local**: Hardhat node, mocks for USDC + SMPXNFT
- **Hoodi testnet**: chainId 560048, deploy mocks (no real USDC/NFT on Hoodi)
- **Mainnet**: real USDC (`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`), real SMPXNFT, treasury = SNCC multisig

## Deployment order (dependencies)

1. Mocks (TestUSDC, MockSMPXNFT) — local/testnet only
2. ENSRegistry (UUPS proxy)
3. SimplexResolver (UUPS proxy)
4. ReverseRegistrar
5. Root → transfer registry root → assign TLD ownership → lock
6. BaseRegistrarImplementation × 2 (UUPS proxy, one per TLD)
7. SimplexPriceOracle
8. SimplexController × 2 (one per TLD, different gate configs)
9. Add controllers to their base registrars
10. SNRCNameWrapper (UUPS proxy)
11. Output addresses to `deployments/<network>.json`

## Conventions from the PoC to follow

- `TestUSDC.sol`: 6 decimals, open `mint()` for test harness, standard ERC-20 interface (copy from PoC)
- Use `hardhat.config.ts` (not `.cjs`), but match PoC's solc settings
- ethers v6 footguns: `NonceManager` doesn't auto-increment across calls; `signer.reset()` after expected reverts; use `await signer.getAddress()` not `signer.address`

## Frontend approach

Fork ens-app-v3, minimal diff:
- **Branding**: swap logo and favicon only. No theme/color/font changes.
- **Contract rewiring**: replace `@ensdomains/ensjs` calls with direct viem calls to SNRC contracts via `src/contracts/snrc.ts`
- **Disable**: DNS import, ENS v2 migration, legacy favourites, on-chain subname UI — short-circuit, don't delete
- **Adapt**: registration flow (USDC approve + TLD selector + NFT gate), profile (contact/channel links), pricing
- **Add**: admin panel page, NFT gate indicator
