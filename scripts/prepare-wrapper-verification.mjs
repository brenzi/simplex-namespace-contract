#!/usr/bin/env node
/**
 * Refresh verification.mainnet.testing.json for the TLD-parameterised
 * NameWrapper redeploy, so `verify-etherscan.mjs` can submit the three new
 * contracts (StaticMetadataService, NameWrapper, PublicResolver) to Etherscan.
 *
 * Computes each contract's ABI-encoded `constructorArgs` from its artifact's
 * constructor inputs + the new on-chain addresses, then rewrites the matching
 * `contracts` entries (the unchanged entries are left as-is — re-verifying them
 * is a no-op on Etherscan).
 *
 * The StaticMetadataService URI is read straight from the deployed contract
 * (`uri(0)`) so the encoded arg is byte-exact — a mismatch fails verification.
 *
 * Required env:
 *   MAINNET_RPC_URL   to read the deployed metadata URI
 *
 * Run after the redeploy, then verify:
 *   MAINNET_RPC_URL=https://... node scripts/prepare-wrapper-verification.mjs
 *   ETHERSCAN_API_KEY=... NETWORK=mainnet SIMPLEX_TLD=testing node scripts/verify-etherscan.mjs
 */
import { createPublicClient, http, namehash, encodeAbiParameters } from 'viem'
import { mainnet } from 'viem/chains'
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const ARTIFACTS = join(REPO_ROOT, 'ens-contracts', 'artifacts', 'contracts')

const tld = 'testing'
const TLD_DNS_NAME = '0x0774657374696e6700'
const tldNode = namehash(tld)

const rpcUrl = process.env.MAINNET_RPC_URL
if (!rpcUrl) { console.error('ERROR: MAINNET_RPC_URL env var is required (to read the metadata URI).'); process.exit(1) }

const deployments = JSON.parse(readFileSync(join(REPO_ROOT, `deployments.mainnet.${tld}.json`), 'utf8'))
const verificationPath = join(REPO_ROOT, `verification.mainnet.${tld}.json`)
const verification = JSON.parse(readFileSync(verificationPath, 'utf8'))

const { ENSRegistry, BaseRegistrarImplementation, ReverseRegistrar, ETHRegistrarController,
        NameWrapper, PublicResolver, StaticMetadataService } = deployments
for (const [k, v] of Object.entries({ NameWrapper, PublicResolver, StaticMetadataService })) {
  if (!v) { console.error(`ERROR: deployments.mainnet.${tld}.json missing ${k} — run the redeploy first.`); process.exit(1) }
}

const constructorInputs = (artifactPath) => {
  const abi = JSON.parse(readFileSync(join(ARTIFACTS, artifactPath), 'utf8')).abi
  const ctor = abi.find((e) => e.type === 'constructor')
  return ctor ? ctor.inputs : []
}
const encode = (artifactPath, args) => encodeAbiParameters(constructorInputs(artifactPath), args)

async function main() {
  const pc = createPublicClient({ chain: mainnet, transport: http(rpcUrl) })

  // Byte-exact metadata URI from the deployed contract.
  const metadataUri = await pc.readContract({
    address: StaticMetadataService,
    abi: [{ type: 'function', name: 'uri', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'string' }] }],
    functionName: 'uri', args: [0n],
  })
  console.log(`Deployed metadata URI: ${JSON.stringify(metadataUri)}`)

  const metaArtifact = 'wrapper/StaticMetadataService.sol/StaticMetadataService.json'
  const wrapArtifact = 'wrapper/NameWrapper.sol/NameWrapper.json'
  const resolverArtifact = 'resolvers/PublicResolver.sol/PublicResolver.json'

  verification.contracts.StaticMetadataService = {
    address: StaticMetadataService.toLowerCase(),
    artifact: `contracts/${metaArtifact}`,
    constructorArgs: encode(metaArtifact, [metadataUri]),
  }
  verification.contracts.NameWrapper = {
    address: NameWrapper.toLowerCase(),
    artifact: `contracts/${wrapArtifact}`,
    constructorArgs: encode(wrapArtifact, [ENSRegistry, BaseRegistrarImplementation, StaticMetadataService, tldNode, TLD_DNS_NAME]),
  }
  verification.contracts.PublicResolver = {
    address: PublicResolver.toLowerCase(),
    artifact: `contracts/${resolverArtifact}`,
    constructorArgs: encode(resolverArtifact, [ENSRegistry, NameWrapper, ETHRegistrarController, ReverseRegistrar]),
  }
  // NameWrapperPublicResolver points at the same PublicResolver address — keep it aligned.
  if (verification.contracts.NameWrapperPublicResolver) {
    verification.contracts.NameWrapperPublicResolver = { ...verification.contracts.PublicResolver }
  }

  writeFileSync(verificationPath, JSON.stringify(verification, null, 2) + '\n')
  console.log(`\nUpdated ${verificationPath} for:`)
  for (const name of ['StaticMetadataService', 'NameWrapper', 'PublicResolver']) {
    const c = verification.contracts[name]
    console.log(`  ${name}  ${c.address}`)
    console.log(`    constructorArgs: ${c.constructorArgs}`)
  }
  console.log(`\nNow verify:`)
  console.log(`  ETHERSCAN_API_KEY=... NETWORK=mainnet SIMPLEX_TLD=${tld} node scripts/verify-etherscan.mjs`)
}

main().catch((err) => { console.error(err); process.exit(1) })
