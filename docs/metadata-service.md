# SNRC NFT metadata service (mainnet `.testing`)

This is the off-chain renderer that makes SNRC names show up as proper NFTs —
logo + name — in MetaMask, other wallets, and on OpenSea. It is our fork of
[`ensdomains/ens-metadata-service`](https://github.com/ensdomains/ens-metadata-service)
(submodule `ens-metadata-service`, branch `simplex`), adapted to our TLDs, our
self-hosted subgraph, and the SimpleX brand. Closes
[simplex-network/ens-app-v3#3](https://github.com/simplex-network/ens-app-v3/issues/3).

It depends on the subgraph from [`subgraph-local.md`](./subgraph-local.md) — that
is where the human-readable label comes from (the chain only stores hashes).

## Why this exists & how it fits together

ENS/SNRC NFTs store no image on-chain; a wallet asks the token contract for a
metadata URL and fetches JSON from it. ENS points that URL at a small Node
service that renders an SVG on demand. We do the same.

```
                         ┌─────────────────────── on-chain (mainnet) ───────────────────────┐
  MetaMask / OpenSea     │  NameWrapper (ERC-1155)        StaticMetadataService              │
        │  uri(tokenId)  │  uri(id) ──delegates──►  returns "https://metadata.simplex.chat/   │
        ├───────────────►│                          mainnet/<contract>/<tokenId>"            │
        │                └───────────────────────────────────────────────────────────────────┘
        │  HTTP GET that URL
        ▼
  ┌──────────────────────── this service (off-chain, Node) ───────────────────────┐
  │  getNetwork   → picks RPC + SUBGRAPH_URL                                        │
  │  checkContract→ reads chain (ownerOf / isWrapped) to classify v1 / v1-wrapped / │
  │                 v2 and derive the tokenId form                                  │
  │  getDomain    → queries OUR subgraph for the label (hash→name) + registration   │
  │                 dates, then renders the SimpleX SVG (svg-template.ts)           │
  │  returns OpenSea JSON: { name, description, image (SVG data-URI), attributes }  │
  └───────────────┬───────────────────────────────────┬────────────────────────────┘
                  │ label by labelhash/namehash         │ expiry / wrap state
                  ▼                                     ▼
        Graph Node (scripts/subgraph)            mainnet RPC (reth)
```

Two render surfaces, one design:

- **In the dApp**, the registration "congratulations" screen renders the NFT
  locally with `NFTTemplate` (`ens-app-v3`). The user sees the design instantly,
  before any wallet call.
- **In the wallet / OpenSea**, this service renders the *same* design (we ported
  `NFTTemplate` into `svg-template.ts`: identical gradient, font, layout — the
  SimpleX badge replaces the ENS logo). So the in-app preview and the wallet NFT
  match.

The label only resolves because our subgraph indexed it from `NameRegistered` /
`ReservedNameAdded` events — a wallet hitting the canonical ENS metadata service
would get nothing for a `.testing` name.

### The unwrapped-name caveat

Wallets call `uri()` on the **NameWrapper** (ERC-1155). A name that is registered
but **not wrapped** is only the `BaseRegistrar` ERC-721, whose `tokenURI` is not
implemented upstream — so it shows blank until wrapped. Deciding whether to
auto-wrap on registration is tracked separately (issue #3, "unwrapped-name gap").
This service renders correctly for both forms once it's asked; it does not change
which token the wallet looks at.

## What we changed vs. upstream

All on the `simplex` branch of the `ens-metadata-service` submodule:

- **Brand (`svg-template.ts` + `assets/simplexBadge.ts`):** swapped the ENS logo
  paths for the SimpleX badge (the `simplex-nft-badge.jpg` used on the dApp
  congrats screen), inlined as a base64 data-URI. Gradient/font/layout are
  unchanged — they already matched `NFTTemplate`.
- **Subgraph (`config.ts` + `service/network.ts`):** `SUBGRAPH_URL` env overrides
  the public per-network table → points at our self-hosted Graph Node.
- **TLD:** upstream hardcoded `eth` in several places (the 2LD `parent` filter in
  `service/subgraph.ts`, the registration-attribute gate and image-URL base in
  `service/domain.ts`, and `eth0x` in `utils/namehash.ts`). All now derive from
  `SIMPLEX_TLD` (default `testing`).
- **Text/links (`service/metadata.ts`):** description → "…, a SimpleX name.";
  `url` → `DAPP_BASE_URL`; hashed/ellipsised display fallbacks use the TLD.
- **Addresses (`config.ts`):** `ADDRESS_*` are run through `getAddress()` so a
  lowercase env value can't silently fail the checksum-sensitive contract match.
- **Avatars dropped** (`endpoint.ts`, `service/domain.ts`): out of scope for v1.

## Configuration

| Env var | Purpose | Example |
|---|---|---|
| `ENV` | `local` (fonts from `src/`, `SERVER_URL=localhost`) or `prod` | `local` |
| `HOST` | public hostname used to build `SERVER_URL` when `ENV=prod` | `metadata.simplex.chat` |
| `PORT` | listen port | `8080` |
| `SUBGRAPH_URL` | our Graph Node GraphQL endpoint (label source) | `http://127.0.0.1:8000/subgraphs/name/graphprotocol/ens` |
| `NODE_PROVIDER` / `NODE_PROVIDER_URL` | RPC for chain reads | `geth` / `http://192.168.1.58:8545` |
| `ADDRESS_ETH_REGISTRAR` | SNRC `BaseRegistrarImplementation` | from `deployments.mainnet.testing.json` |
| `ADDRESS_ETH_REGISTRY` | SNRC `ENSRegistry` | ″ |
| `ADDRESS_NAME_WRAPPER` | SNRC `NameWrapper` | ″ |
| `SIMPLEX_TLD` | TLD for display + parent-node derivation | `testing` |
| `DAPP_BASE_URL` | link target for the OpenSea `url` field | `https://testing-names.simplex.chat` |

## Test it locally

Prerequisite: the subgraph stack from [`subgraph-local.md`](./subgraph-local.md)
is up and synced (so labels resolve).

```sh
cd ens-metadata-service
yarn install            # builds the native `canvas` dep (needs cairo/pango/libjpeg)

# point at the local subgraph, your RPC, and the SNRC contract addresses
cat > .env <<'ENV'
ENV=local
PORT=8083
SUBGRAPH_URL=http://127.0.0.1:8000/subgraphs/name/graphprotocol/ens
NODE_PROVIDER=geth
NODE_PROVIDER_URL=http://192.168.1.58:8545
ADDRESS_ETH_REGISTRAR=0x42d63e6a9f92c0282dc0b9677d9192d491b0da72
ADDRESS_ETH_REGISTRY=0x03f438da0bd44da3c6c1d0392f8ba183b8b3a7a6
ADDRESS_NAME_WRAPPER=0x0994819ee8acfcf10b17ebe1f826cc753ea4e9ef
SIMPLEX_TLD=testing
DAPP_BASE_URL=https://testing-names.simplex.chat
ENV

yarn dev                # ts-node-dev on $PORT
```

Request metadata for a name. The route is
`/<network>/<contract>/<tokenId>`, where `tokenId` is the **labelhash** for an
unwrapped 2LD (`BaseRegistrar`) or the **namehash** for a wrapped name
(`NameWrapper`). For `foobar.testing` (labelhash `0x38d1…873e`):

```sh
curl -s "http://localhost:8083/mainnet/0x42d63e6a9f92c0282dc0b9677d9192d491b0da72/0x38d18acb67d25c8bb9942764b62f18e17054f66a817bd4295423adf9ed98873e" | jq '{name, description, url, attributes: [.attributes[].trait_type]}'
# {
#   "name": "foobar.testing",
#   "description": "foobar.testing, a SimpleX name.",
#   "url": "https://testing-names.simplex.chat/foobar.testing",
#   "attributes": ["Created Date","Length","Segment Length","Character Set","Registration Date","Expiration Date"]
# }
```

The raw SVG (what the wallet shows) is on the `/image` route:

```sh
curl -s ".../mainnet/<contract>/<tokenId>/image" -o nft.svg   # open in a browser
```

To compute a labelhash for any registered name:
`node -e "const{keccak256,stringToBytes}=require('viem');console.log(keccak256(stringToBytes('<label>')))"`.

## Deploy

> **Runtime note.** The renderer uses `node-canvas` (native, for text-width font
> sizing) and reads font files from disk. It therefore needs a **Node runtime
> with a filesystem** — a small VM or a container. It does **not** run on
> Cloudflare Workers (no native addons / no `fs`), despite the original issue's
> suggestion; pick a VM/container or a Node-capable serverless host instead.

1. **Build & run the service**

   ```sh
   yarn build && ENV=prod HOST=metadata.simplex.chat node dist/index.js
   ```

   Put it behind a TLS reverse proxy (Caddy/nginx) at `metadata.simplex.chat`,
   set the env vars from the table above (with `SUBGRAPH_URL` →
   the production Graph Node, `NODE_PROVIDER_URL` → a reliable RPC). Container
   image: install cairo/pango/libjpeg-dev + `yarn build`, run `node dist/index.js`.
   A response cache / CDN in front helps (renders are deterministic per tokenId).

2. **Point the NFT at it (on-chain, once per TLD)**

   `StaticMetadataService.sol` is verbatim ENS, already in `ens-contracts`.

   ```solidity
   StaticMetadataService md = new StaticMetadataService(
     "https://metadata.simplex.chat/mainnet/<NameWrapper-address>/{id}"
   );
   nameWrapper.setMetadataService(md);   // owner-only
   ```

3. **Verify** — open the name on OpenSea, or in MetaMask under the wallet's NFTs;
   it should show the SimpleX badge + the name. (For unwrapped names, see the
   caveat above.)

## Limits / follow-ups

- **Unwrapped names** render blank in wallets until wrapped (no `tokenURI` on the
  ERC-721) — auto-wrap-on-register is a separate decision.
- **Avatars** are dropped (no `/avatar` route); reuse ENS's approach later if needed.
- **Cloudflare Workers** would require replacing `node-canvas` font measurement
  with a pure-JS approach and inlining the font (already done for the badge).
