#!/usr/bin/env node
/**
 * Partial mainnet redeploy for the SNRC `.testing` TLD: deploy the fixed,
 * TLD-parameterised NameWrapper plus a matching PublicResolver, replacing the
 * `.eth`-hardcoded wrapper (`0x9be8…`) that could mis-wrap `.testing` names.
 *
 * This is a DEPLOY-ONLY script. It does not touch the live registry,
 * registrar, controller, or any existing name — it only deploys new contracts
 * and (optionally) hands the new NameWrapper's ownership to the multisig.
 * Repointing the dApp / subgraph / metadata service is a config change, done
 * afterwards from the addresses this script prints (see
 * docs/redeploy-wrapper-testing.md).
 *
 * Prerequisites:
 *   - `pnpm --filter ens-contracts compile` (artifacts must reflect the fixed
 *     5-arg NameWrapper constructor).
 *   - Nothing is wrapped on the old wrapper (verified: 0 names) — so there is
 *     nothing to migrate.
 *
 * Required env:
 *   DEPLOYER_KEY      hex private key of the deployer EOA (funded)
 *   MAINNET_RPC_URL   JSON-RPC URL for Ethereum mainnet
 *
 * Optional env:
 *   METADATA_URI      ERC-1155 metadata URI for the NameWrapper's
 *                     StaticMetadataService (may contain `{id}`). Can be
 *                     changed later via NameWrapper.setMetadataService, so a
 *                     placeholder here is fine. Default: the value below.
 *   OWNER_ADDRESS     multisig to receive NameWrapper ownership
 *                     (default: the SNCC multisig used by deploy-mainnet.mjs).
 *                     Set to the deployer to skip the transfer.
 *   MAX_FEE_GWEI      cap on maxFeePerGas (e.g. "10"). If unset, viem estimates.
 *
 * Run from the parent repo:
 *   DEPLOYER_KEY=0x... MAINNET_RPC_URL=https://... \
 *     node scripts/redeploy-wrapper-testing.mjs
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  namehash,
  parseGwei,
} from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const ARTIFACTS = join(REPO_ROOT, 'ens-contracts', 'artifacts', 'contracts')

const TLD = 'testing'
// DNS-encoded ".testing": 0x07 'testing' 0x00.
const TLD_DNS_NAME = '0x0774657374696e6700'
const TLD_NODE = namehash(TLD)

const rpcUrl = process.env.MAINNET_RPC_URL
const deployerKey = process.env.DEPLOYER_KEY
const metadataUri =
  process.env.METADATA_URI ||
  'https://metadata.simplex.chat/mainnet/{id}' // placeholder — update post-deploy if needed
const ownerAddress = process.env.OWNER_ADDRESS || '0xDa064C4567fAD2c9Da7b6DD08b5C2B2607960340'
const maxFeePerGas = process.env.MAX_FEE_GWEI ? parseGwei(process.env.MAX_FEE_GWEI) : undefined

if (!deployerKey) { console.error('ERROR: DEPLOYER_KEY env var is required.'); process.exit(1) }
if (!rpcUrl) { console.error('ERROR: MAINNET_RPC_URL env var is required.'); process.exit(1) }

const account = privateKeyToAccount(deployerKey)
const transport = http(rpcUrl)
const publicClient = createPublicClient({ chain: mainnet, transport })
const walletClient = createWalletClient({ chain: mainnet, transport, account })

const addressesPath = join(REPO_ROOT, `deployments.mainnet.${TLD}.json`)
const journalPath = join(REPO_ROOT, `redeploy-wrapper.mainnet.${TLD}.journal.json`)

function loadArtifact(path) {
  const json = JSON.parse(readFileSync(join(ARTIFACTS, path), 'utf8'))
  return { abi: json.abi, bytecode: json.bytecode }
}

function loadExistingAddresses() {
  if (!existsSync(addressesPath)) {
    console.error(`ERROR: ${addressesPath} not found — need existing deployment addresses.`)
    process.exit(1)
  }
  const a = JSON.parse(readFileSync(addressesPath, 'utf8'))
  for (const k of ['ENSRegistry', 'BaseRegistrarImplementation', 'ReverseRegistrar', 'ETHRegistrarController']) {
    if (!a[k]) { console.error(`ERROR: ${addressesPath} missing ${k}`); process.exit(1) }
  }
  return a
}

async function deploy(name, artifactPath, args) {
  const { abi, bytecode } = loadArtifact(artifactPath)
  console.log(`Deploying ${name} ${JSON.stringify(args)} ...`)
  const hash = await walletClient.deployContract({ abi, bytecode, args, ...(maxFeePerGas ? { maxFeePerGas } : {}) })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${name} deploy reverted (${hash})`)
  console.log(`  ${name} = ${receipt.contractAddress}  (block ${receipt.blockNumber}, tx ${hash})`)
  return { name, address: receipt.contractAddress, abi, block: Number(receipt.blockNumber), txHash: hash }
}

async function main() {
  const a = loadExistingAddresses()
  console.log(`Partial wrapper redeploy for .${TLD} on mainnet`)
  console.log(`  Deployer: ${account.address}`)
  console.log(`  Balance:  ${await publicClient.getBalance({ address: account.address })} wei`)
  console.log(`  Reusing — registry ${a.ENSRegistry}, registrar ${a.BaseRegistrarImplementation},`)
  console.log(`            controller ${a.ETHRegistrarController}, reverseRegistrar ${a.ReverseRegistrar}\n`)

  // 1) Metadata service for the new wrapper (swappable later via setMetadataService).
  const metadata = await deploy(
    'StaticMetadataService',
    'wrapper/StaticMetadataService.sol/StaticMetadataService.json',
    [metadataUri],
  )

  // 2) Fixed, TLD-parameterised NameWrapper.
  const wrapper = await deploy(
    'NameWrapper',
    'wrapper/NameWrapper.sol/NameWrapper.json',
    [a.ENSRegistry, a.BaseRegistrarImplementation, metadata.address, TLD_NODE, TLD_DNS_NAME],
  )

  // 3) New PublicResolver bound to the new wrapper (so wrapped names can edit
  //    records). trustedETHController = SimplexController; trustedReverse =
  //    ReverseRegistrar (per the PublicResolver gotcha in CLAUDE.md).
  const resolver = await deploy(
    'PublicResolver',
    'resolvers/PublicResolver.sol/PublicResolver.json',
    [a.ENSRegistry, wrapper.address, a.ETHRegistrarController, a.ReverseRegistrar],
  )

  // 4) Hand NameWrapper ownership to the multisig (PublicResolver is ownerless).
  if (ownerAddress.toLowerCase() !== account.address.toLowerCase()) {
    console.log(`\nTransferring NameWrapper ownership to ${ownerAddress} ...`)
    const hash = await walletClient.writeContract({
      address: wrapper.address, abi: wrapper.abi, functionName: 'transferOwnership',
      args: [ownerAddress], ...(maxFeePerGas ? { maxFeePerGas } : {}),
    })
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`  done (tx ${hash})`)
  }

  const out = {
    tld: TLD,
    StaticMetadataService: metadata.address,
    NameWrapper: wrapper.address,
    PublicResolver: resolver.address,
    deployBlocks: { StaticMetadataService: metadata.block, NameWrapper: wrapper.block, PublicResolver: resolver.block },
    metadataUri,
    txHashes: { StaticMetadataService: metadata.txHash, NameWrapper: wrapper.txHash, PublicResolver: resolver.txHash },
  }
  writeFileSync(journalPath, JSON.stringify(out, null, 2))

  console.log(`\n=== New addresses (also written to ${journalPath}) ===`)
  console.log(JSON.stringify(out, null, 2))
  console.log(`\nNext: apply the config diffs in docs/redeploy-wrapper-testing.md`)
  console.log(`  - deployments.mainnet.${TLD}.json: NameWrapper, PublicResolver, NameWrapperPublicResolver, StaticMetadataService`)
  console.log(`  - ens-subgraph/subgraph.yaml: NameWrapper datasource address+startBlock; add new Resolver datasource`)
  console.log(`  - ens-metadata-service: ADDRESS_NAME_WRAPPER=${wrapper.address}`)
  console.log(`  - verify on Etherscan; tag simplex-mainnet-${TLD}-v2`)
}

main().catch((err) => { console.error(err); process.exit(1) })
