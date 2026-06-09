# Running the SNRC subgraph locally (mainnet `.testing`)

This walkthrough spins up a local Graph Node + IPFS + Postgres stack,
deploys the SNRC subgraph against it, and points the dApp at it — all
indexing Ethereum mainnet. The result is the same "rich queries" surface
the upstream ENS app gets from The Graph, without depending on any
hosted service.

Tested on Linux + macOS with Docker 24+. Windows works via Docker
Desktop but is untested here.

## Prerequisites

- Docker + Docker Compose v2.
- A mainnet RPC URL — your local Reth, Alchemy, DRPC, Infura, … any
  archive-capable provider. Initial backfill from block 25,250,870
  (the SNRC mainnet `.testing` deploy block) reads ~tens of thousands
  of logs; a rate-limited free-tier RPC will work, just slowly.
- Node 18+ and Yarn (the subgraph repo uses Yarn classic).
- A clone of the parent repo with the `ens-subgraph` submodule
  populated:

  ```sh
  git clone --recurse-submodules https://github.com/brenzi/simplex-namespace-contract
  # or, if you already cloned:
  git submodule update --init ens-subgraph
  ```

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

This is the only wiring needed — `src/utils/chains/makeLocalhostChainWithEns.ts`
reads `NEXT_PUBLIC_SUBGRAPH_URL` and forwards it to ensjs's subgraph
client. If unset, the chain falls back to the legacy
`http://localhost:42069/subgraph` endpoint used by `pnpm dev:glocal`.

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

## What's adapted vs. what's still upstream

In this fork we've adapted just enough of the upstream ENS subgraph
to make the SNRC mainnet `.testing` data surface work:

- **Adapted** — `subgraph.yaml` (data-source addresses + `SimplexController`
  source), `networks.json` (SNRC addresses), `abis/SimplexController.json`,
  `src/simplexController.ts` (NameRegistered + NameRenewed mappings).
- **Still upstream** — schema, the four legacy mapping files
  (`ensRegistry.ts`, `resolver.ts`, `ethRegistrar.ts`, `nameWrapper.ts`),
  test fixtures. Those events have the same shape on our verbatim ENS
  contracts, so they index correctly without modification.
- **Deferred** — mappings for `MinCharLengthChanged`,
  `ReservedNameAdded/Removed`, `NftGateDisabled`, and the
  `Ownable2Step` `OwnershipTransferStarted/Transferred` events on
  `SimplexController`. The reserved-name admin dashboard and the
  ownership-transition surface will need these wired through with
  matching `schema.graphql` additions. Tracked in
  [simplex-network/ens-app-v3#2](https://github.com/simplex-network/ens-app-v3/issues/2).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `failed to get latest block` in graph-node logs | RPC URL unreachable from container | Use `host.docker.internal` (already declared via `extra_hosts`), or switch to a hosted endpoint. |
| Subgraph syncs but `My Names` still empty | dApp pointing at the old fallback URL | Confirm `NEXT_PUBLIC_SUBGRAPH_URL` ends up in `next dev`'s shell env (`echo $NEXT_PUBLIC_SUBGRAPH_URL` inside the same shell that runs `pnpm dev`). |
| `entity 'Domain' does not exist` codegen error | Stale `src/types/` from a previous schema | `rm -rf src/types && yarn codegen` |
| Initial backfill is glacial | Provider rate-limiting | Switch to a local Reth or upgrade the RPC tier. The number of logs at our `startBlock` is small (~thousands) so this is RPC throughput, not subgraph work. |
| Subgraph fails to compile with `cannot find name 'ByteArray'` | AS codegen hasn't been run for the new SimplexController source | `yarn codegen` before `yarn deploy-local`. |
