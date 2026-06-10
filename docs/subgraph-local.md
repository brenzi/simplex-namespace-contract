# Running the SNRC subgraph locally (mainnet `.testing`)

This walkthrough spins up a local Graph Node + IPFS + Postgres stack,
deploys the SNRC subgraph against it, and points the dApp at it — all
indexing Ethereum mainnet. The result is the same "rich queries" surface
the upstream ENS app gets from The Graph, without depending on any
hosted service.

Tested on Linux + macOS with Docker 24+. Windows works via Docker
Desktop but is untested here.

## Why a subgraph at all?

An Ethereum node answers *point* lookups well — "who owns namehash `0x…`?",
"what's the `simplex.contact` text record on this resolver?" — because those
are direct reads keyed by a hash you already have. It cannot answer the two
question shapes a name-manager dApp lives on:

1. **Reverse / enumeration queries.** "Which names does address `0x…` own?"
   has no on-chain index — the registry only maps `namehash → owner`, never
   the inverse. Without a subgraph the dApp falls back to scanning
   `BaseRegistrar` `Transfer` logs over a bounded recent window (`eth_getLogs`,
   chunked, rate-limited, and blind to registrations older than the scan
   depth). A subgraph indexes every registration once and serves the list
   instantly, with server-side **search, sort (e.g. by expiry), and
   pagination**.

2. **Hash → human label.** ENS — and SNRC — store only `keccak256(label)`
   on-chain; the plaintext label is *not* recoverable from the hash. The
   subgraph captures the label from the event payloads that do carry it
   (`NameRegistered(string label)`, `ReservedNameAdded(string)`) at index time
   and persists the `hash → label` preimage. That's the difference between the
   dApp rendering **`foobar.testing`** and rendering **`[38d18acb…].testing`**.

Concretely, in this dApp the subgraph powers:

- **My Names** — the full list of a connected (or impersonated) address's
  names, by real label, sorted/filtered/paginated, with no localStorage
  priming and no "Error syncing data" chain-scan fallback.
- **Human-readable labels everywhere** a name is shown — including
  reserved-then-directly-registered names, which never emit
  `NameRegistered(string)` and are otherwise stuck as `[labelhash].testing`
  (see [step 3](#3-build--deploy-the-subgraph)).
- **Subname listings, registration dates, and expiry data** surfaced from the
  indexed `Domain` / `Registration` entities rather than reconstructed from
  raw logs.

The chain-scan fallback exists for deployments with no indexer (local Hardhat,
a bare Sepolia stack), but it can't recover labels and can't do rich queries —
which is exactly the gap this subgraph closes.

## Prerequisites

- Docker + Docker Compose v2.
- A mainnet RPC URL (see [RPC node requirements](#rpc-node-requirements) below).
  Initial backfill from block 25,250,870 (the SNRC mainnet `.testing` deploy
  block) reads ~tens of thousands of logs; a rate-limited free-tier RPC will
  work, just slowly.
- Node 18+ and Yarn (the subgraph repo uses Yarn classic).
- A clone of the parent repo with the `ens-subgraph` submodule
  populated:

  ```sh
  git clone --recurse-submodules https://github.com/brenzi/simplex-namespace-contract
  # or, if you already cloned:
  git submodule update --init ens-subgraph
  ```

### RPC node requirements

The subgraph is **purely event-driven**: every data source uses only
`eventHandlers` (no `callHandlers`/`blockHandlers`), and no mapping makes an
`eth_call` (no `Contract.bind`). So Graph Node only ever asks the RPC for:

- `eth_chainId` / `eth_getBlockByNumber` / `eth_getBlockByHash` — block ingestion;
- `eth_getLogs` — the actual work, scanning event logs from the start block to head;
- block receipts — `eth_getBlockReceipts` (fast path, auto-detected) or a
  per-tx `eth_getTransactionReceipt` fallback.

What that means for node choice:

| Node type | Works? | Notes |
|---|---|---|
| Archive node | ✅ | Works, but **overkill** — historical state is never read. |
| Pruned full node (e.g. `reth --full`) | ✅ **recommended minimum** | Verified against `reth v2.0.0 --full`: historical *state* is pruned (`eth_call` at the start block returns *"state … is pruned"*) and `trace_*` is absent, yet the subgraph indexes to head with `health: healthy`. |
| Hosted RPC (Alchemy/DRPC/Infura/…) | ✅ | Any tier; free tiers just backfill slower. `eth_getLogs` + receipts is all that's used. |
| Light client | ❌ | Cannot answer historical `eth_getLogs` / receipt queries over the indexing range. |

The one thing the node **must** retain is **logs + receipts back to the start
block (25,250,870)** — i.e. don't enable receipt/log pruning before that
height. `reth --full` keeps receipts (it only prunes historical state), so it's
fine; it's also the cheapest sufficient option. Neither historical state
(archive) nor a trace API (`trace_filter`/`debug_trace*`) is required.

## 1. Configure the RPC

```sh
cd simplex-namespace-contract
cp scripts/subgraph/.env.example scripts/subgraph/.env
$EDITOR scripts/subgraph/.env
```

Set `SUBGRAPH_RPC_URL` to your mainnet endpoint. Examples in the file.
For local Reth users, the loopback address from inside Docker is
`http://host.docker.internal:8545` (the compose file declares the
`host-gateway` extra-host so this works on Linux too).

## 2. Boot Graph Node + IPFS + Postgres

```sh
docker compose -f scripts/subgraph/docker-compose.yml \
               --env-file scripts/subgraph/.env up -d
```

Endpoints (loopback-only):

| Service              | URL                          | Purpose                                                                      |
|----------------------|------------------------------|------------------------------------------------------------------------------|
| Graph Node — admin   | `http://127.0.0.1:8020`      | `graph create` / `graph deploy` target.                                       |
| Graph Node — GraphQL | `http://127.0.0.1:8000`      | The query surface the dApp will talk to.                                      |
| Graph Node — status  | `http://127.0.0.1:8030`      | Indexing-status JSON-RPC. Useful to check how far backfill has progressed.    |
| IPFS                 | `http://127.0.0.1:5001`      | The Graph publishes subgraph manifests + AssemblyScript code via IPFS.        |
| Postgres             | `127.0.0.1:5432` (not bound) | Internal. Bound only inside the compose network.                              |

Watch the logs:

```sh
docker compose -f scripts/subgraph/docker-compose.yml logs -f graph-node
```

A healthy startup ends with `Downloading latest blocks from Ethereum`
followed by `Block ingestor: …`. If you see `ProviderError: failed to
get latest block`, your RPC URL is unreachable from inside the
container — recheck `SUBGRAPH_RPC_URL` and any firewall rules.

### Seed the ENS rainbow table (required on graph-node ≥ 0.30)

The pinned image (`graph-node:v0.36.0`) makes the `ens.nameByHash` host
function — called by the upstream `handleNewOwner` / `handleNameRegistered`
mappings — **throw** `Missing ENS data: see github.com/graphprotocol/ens-rainbow`
whenever its rainbow table (`public.ens_names`) is empty. The subgraph then
fatal-errors on the first registry event (block ~25,250,885) and never
indexes. Older graph-node returned null here, which is why this isn't in the
original walkthrough.

We don't need the full 5.9 GB rainbow dump — SNRC labels come from the
controller's `NameRegistered(string)` and `ReservedNameAdded(string)` events
(see step 3). We just need the table to be non-empty so `nameByHash` returns
null (→ `[labelhash]` fallback) instead of throwing. Seed the genuine TLD /
reverse-registrar labels once the table exists:

```sh
# Wait until graph-node has created public.ens_names, then seed real labels.
docker compose -f scripts/subgraph/docker-compose.yml exec -T postgres \
  psql -U graph-node -d graph-node -c "
INSERT INTO public.ens_names (hash, name) VALUES
 ('0x5f16f4c7f149ac4f9510d9cf8cf384038ad348b3bcdc01915f95de12df9d1b02','testing'),
 ('0xe5e14487b78f85faa6e1808e89246cf57dd34831548ff2e6097380d98db2504a','addr'),
 ('0xdec08c9dbbdd0890e300eb5062089b2d4b1c40e3673bbccb5423f7b37dcf9a9c','reverse'),
 ('0x329539a1d23af1810c48a07fe7fc66a3b34fbc8b37e9b3cdb97bb88ceab7e4bf','resolver')
ON CONFLICT (hash) DO NOTHING;"
```

The seed lives in the `postgres-data` volume — it survives restarts but a
`down -v` wipes it, so re-seed after a volume reset (before re-deploying).

## 3. Build + deploy the subgraph

```sh
cd ens-subgraph
pnpm install
pnpm codegen                  # generates AssemblyScript types from the ABIs
pnpm create-local             # registers the subgraph slug on the local node
pnpm deploy-local             # uploads the manifest + WASM, starts indexing
```

`yarn deploy-local` prints a GraphQL endpoint when it finishes:

```
Build completed: QmYourCidHere
Deployed to http://127.0.0.1:8000/subgraphs/name/graphprotocol/ens
```

`graphprotocol/ens` is the slug — that name comes from the
`create-local` / `deploy-local` scripts in the subgraph's
`package.json`. You can rename it if you want a different URL.

### Watching the backfill

Initial sync from block 25,250,870 to chain head takes ~15 min
against Alchemy/DRPC, ~5 min against a local Reth. Track progress with:

```sh
curl -s -X POST http://127.0.0.1:8030/graphql -H 'Content-Type: application/json' \
  -d '{"query":"{ indexingStatusForCurrentVersion(subgraphName:\"graphprotocol/ens\") { synced chains { latestBlock { number } chainHeadBlock { number } } } }"}' \
  | jq
```

`synced: true` ⇒ the subgraph has caught up to the chain head.

## 4. Point the dApp at the local subgraph

In `ens-app-v3/.env.development.local` (create if absent), add:

```env
NEXT_PUBLIC_SUBGRAPH_URL=http://127.0.0.1:8000/subgraphs/name/graphprotocol/ens
```

`src/utils/chains/makeLocalhostChainWithEns.ts` reads `NEXT_PUBLIC_SUBGRAPH_URL`
and forwards it to ensjs's subgraph client. If unset, the chain falls back to
the legacy `http://localhost:42069/subgraph` endpoint used by `pnpm dev:glocal`.

Setting it also flips the **`My Names` data source**: `useNamesForAddress`
otherwise short-circuits to a BaseRegistrar `Transfer` chain-scan whenever a
custom deployment is configured (`NEXT_PUBLIC_MAINNET_DEPLOYMENT_ADDRESSES`
etc.), and that path can only label names whose preimage is already in the
browser's `ensjs:labels` cache — so a freshly-impersonated address sees
`[labelhash].testing`. With `NEXT_PUBLIC_SUBGRAPH_URL` set, the hook queries
the subgraph instead and renders the real label (incl. reserved names).

Restart `pnpm dev` so Next picks up the new env var.

## 5. Verify

Open the dApp on a name you own (or have registered records for) and
visit `My Names`. With the subgraph synced, you should see:

- Full list of names without the `getLogs` chain-scan fallback (no more
  "Error syncing data" banner on a fresh browser without local
  storage).
- Names rendered as labels rather than raw `0x…` hashes — that's what
  `simplexController.ts`'s `setNamePreimage` populates on every
  `NameRegistered` event.

You can also hit the GraphQL endpoint directly:

```sh
curl -s -X POST http://127.0.0.1:8000/subgraphs/name/graphprotocol/ens \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ domains(first:10){ id labelName name owner { id } } registrations(first:10){ labelName cost expiryDate } }"}' \
  | jq
```

Expect to see your registered `.testing` names in `labelName` / `name`
once the indexer has reached the blocks they were registered in.

## Tear down

```sh
docker compose -f scripts/subgraph/docker-compose.yml down -v
```

`-v` wipes Postgres + IPFS volumes; drop it to keep the indexed state
across restarts.

## Production deployment

The compose stack above is a **dev** setup — loopback-only ports, a
`let-me-in` Postgres password, no TLS, an open GraphQL endpoint. The notes
below cover what changes for a real deployment. None of it requires touching
the subgraph code; it's all topology, sizing, and hardening.

### How heavy is it, really?

Barely. After a full sync this subgraph's database is **~194 MB**, and **~176
MB of that is graph-node's own block cache** (`chain1.blocks`) — the SNRC
entity tables (`domain`, `registration`, `reserved_name`, …) total under a
megabyte. The dataset grows slowly: the block cache tracks chain head (order
of a few GB/year), the entity tables track `.testing` registrations. So the
indexer stack (Graph Node + Postgres + IPFS) is light. **The only potentially
heavy component is the Ethereum RPC, and only if you self-host it.**

### Topology

Two independently-sizable pieces:

1. **Indexer stack** — Graph Node + Postgres + IPFS (the compose file).
2. **Ethereum RPC** — see [RPC node requirements](#rpc-node-requirements).
   Either a hosted provider or your own `reth --full`. Keep it on its own
   host (or co-locate; see sizing).

Only the **GraphQL query port (8000)** should ever be public. The admin
JSON-RPC (8020), index-status (8030), Prometheus metrics (8040), IPFS (5001),
and Postgres (5432) must stay private (firewall / private network / bound to
loopback). Put 8000 behind a reverse proxy (Caddy/nginx/Traefik) terminating
TLS, with rate-limiting and ideally an HTTP cache or CDN — dApp queries are
read-heavy and repetitive.

### VM sizing

| Scenario | vCPU | RAM | Disk | Notes |
|---|---|---|---|---|
| Indexer stack only, **hosted RPC** (Alchemy/DRPC/…) | 2 | 4–8 GB | 50–100 GB SSD | The cheap, recommended path. RAM mostly for Postgres cache; disk is headroom over the ~GB-scale DB. |
| Indexer stack + **self-hosted `reth --full`** on one box | 4–8 (high clock) | 32 GB | ~1.5 TB **TLC NVMe** | reth dominates: ≥1.2 TB NVMe + 8 GB just for reth, plus the stack. NVMe is non-negotiable for reth; QLC drives stall during sync. |
| Self-hosted **reth archive** (not needed here) | 4–8 | 32–64 GB | ~3 TB NVMe | Only if another consumer needs historical state — this subgraph doesn't. |

reth figures are from its [system requirements](https://reth.rs/run/system-requirements/)
(full ≥1.2 TB / 8 GB; archive ≥2.8 TB / 16 GB; favour clock speed over core
count — EL execution is single-threaded). The indexer stack adds little on top.

### Hardening checklist

- **Postgres password** — replace the `let-me-in` default
  (`POSTGRES_PASSWORD` in `.env`). Keep `--locale=C --encoding=UTF8`; The
  Graph requires the C collation for deterministic ordering.
- **`GRAPH_POI_ACCESS_TOKEN`** — set it on graph-node. Unset, the startup log
  warns *"GRAPH_POI_ACCESS_TOKEN not set; might leak POIs to the public via
  GraphQL"*; a token gates the proof-of-indexing query field.
- **CORS** — allow the dApp origin on the proxy in front of 8000 (the browser
  queries it cross-origin).
- **Restart policy** — add `restart: unless-stopped` to all three services so
  the stack survives reboots/crashes.
- **Backups** — snapshot the `postgres-data` volume (or `pg_dump`). It holds
  both the indexed state *and* the `ens_names` rainbow seed, so a restore is
  self-contained; only a from-scratch DB needs re-seeding (see step 2).
- **RPC reliability** — a flaky endpoint stalls indexing. Use a dependable
  provider, or list several behind graph-node's `ethereum:` connection (it
  fails over across multiple URLs).
- **Monitoring** — scrape graph-node's Prometheus metrics (8040) and alert on
  indexing lag (`chainHeadBlock − latestBlock`) and subgraph `health` flipping
  to `failed`. The status endpoint (8030) exposes the same as JSON-RPC.
- **Version pinning** — graph-node is pinned to `v0.36.0` in the compose file;
  test before bumping (the rainbow-table behaviour in step 2 is version-specific).

### Wiring the production dApp

Point the deployed dApp at the public endpoint by setting
`NEXT_PUBLIC_SUBGRAPH_URL=https://<your-graphql-host>/subgraphs/name/graphprotocol/ens`
in the production build env (Cloudflare Pages / GitHub Actions). As covered in
step 4, that env var also flips `My Names` from the chain-scan fallback to the
subgraph, so it must be set in prod for labels (incl. reserved names) to render.

## What's adapted vs. what's still upstream

In this fork we've adapted just enough of the upstream ENS subgraph
to make the SNRC mainnet `.testing` data surface work:

- **Adapted** — `subgraph.yaml` (data-source addresses + `SimplexController`
  source), `networks.json` (SNRC addresses), `abis/SimplexController.json`,
  `src/simplexController.ts` (NameRegistered + NameRenewed + **ReservedNameAdded
  / ReservedNameRemoved** mappings), the `ReservedName` entity in
  `schema.graphql`, and a preimage fallback in `src/ethRegistrar.ts`
  (`handleNameRegistered` consults `ReservedName` when `nameByHash` misses).
  This is what lets names **reserved then registered directly via the
  BaseRegistrar** (e.g. `registerReserved`) resolve to their label — those
  never emit `NameRegistered(string)`, so the reservation event is their only
  on-chain label source.
- **Still upstream** — schema, the four legacy mapping files
  (`ensRegistry.ts`, `resolver.ts`, `ethRegistrar.ts`, `nameWrapper.ts`),
  test fixtures. Those events have the same shape on our verbatim ENS
  contracts, so they index correctly without modification.
- **Deferred** — mappings for `MinCharLengthChanged`, `NftGateDisabled`, and
  the `Ownable2Step` `OwnershipTransferStarted/Transferred` events on
  `SimplexController`. The min-char / NFT-gate admin surface and the
  ownership-transition surface will need these wired through with matching
  `schema.graphql` additions. Tracked in
  [simplex-network/ens-app-v3#2](https://github.com/simplex-network/ens-app-v3/issues/2).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `failed to get latest block` in graph-node logs | RPC URL unreachable from container | Use `host.docker.internal` (already declared via `extra_hosts`), or switch to a hosted endpoint. |
| Subgraph syncs but `My Names` still empty | dApp pointing at the old fallback URL | Confirm `NEXT_PUBLIC_SUBGRAPH_URL` ends up in `next dev`'s shell env (`echo $NEXT_PUBLIC_SUBGRAPH_URL` inside the same shell that runs `pnpm dev`). |
| `entity 'Domain' does not exist` codegen error | Stale `src/types/` from a previous schema | `rm -rf src/types && yarn codegen` |
| Initial backfill is glacial | Provider rate-limiting | Switch to a local Reth or upgrade the RPC tier. The number of logs at our `startBlock` is small (~thousands) so this is RPC throughput, not subgraph work. |
| Subgraph fails to compile with `cannot find name 'ByteArray'` | AS codegen hasn't been run for the new SimplexController source | `yarn codegen` before `yarn deploy-local`. |
