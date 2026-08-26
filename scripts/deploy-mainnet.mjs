#!/usr/bin/env node
/**
 * Deploy SNRC contracts to Ethereum mainnet — wait-for-cheap-base strategy.
 *
 * Each TLD (.testing, .simplex) is an independent deployment — run this
 * script once per TLD. Strategy / contracts otherwise mirror Sepolia.
 *
 * Workflow:
 *   1. Spawns a local Hardhat fork of mainnet and runs the full deploy
 *      sequence against it as a dry-run to capture per-step gasUsed.
 *   2. Computes ceiling cost = total gas × MAX_BASE_FEE_GWEI, prints a
 *      summary, prompts Y/N.
 *   3. Stops the fork. Runs the real deploy against mainnet, sending every
 *      tx with `maxFeePerGas = MAX_BASE_FEE_GWEI` and zero priority. Each
 *      tx waits for `baseFeePerGas ≤ cap` before submission.
 *   4. If a submitted tx stalls (base climbed back above cap, mempool
 *      eviction, etc.) for `BUMP_AFTER_HOURS`, the cap bumps by
 *      `BUMP_PCT%` and resubmits at the same nonce.
 *   5. Every successful tx appends to a JSONL journal; re-running the
 *      script picks up where it left off.
 *
 * Required env vars:
 *   DEPLOYER_KEY       hex private key (0x...) of the ephemeral deployer
 *   MAINNET_RPC_URL    JSON-RPC URL for mainnet (used by both fork + real)
 *   MAX_BASE_FEE_GWEI  cap on per-gas price (e.g. "0.078")
 *
 * Optional env vars:
 *   SIMPLEX_TLD        'testing' (default) | 'simplex'
 *   ETHUSD_FEED        Chainlink AggregatorV3 (default: mainnet feed)
 *   SMPXNFT_ADDR       SMPXNFT contract  (default: 0x3AF6D9Ee…7291)
 *   OWNER_ADDRESS      cold owner (default: simplexchat.eth)
 *   BUMP_AFTER_HOURS   stall threshold before cap bump (default: 24)
 *   BUMP_PCT           cap multiplier on stall (default: 20)
 *   FORK_PORT          local port for the dry-run fork (default: 18545 — picked
 *                      to avoid Reth/Geth's stock 8545/8546 ports)
 *   CONFIRM=yes        skip the interactive confirmation prompt
 *
 * Files written next to the addresses file:
 *   deployments.mainnet.${tld}.json            ← final addresses (on success)
 *   deployments.mainnet.${tld}.journal.jsonl   ← per-tx journal (resume source)
 *   deployments.mainnet.${tld}.attempts.log    ← every attempt + reason
 *
 * Commit the addresses file AND the journal to the repo.
 * See docs/deployment.md → Mainnet.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http, labelhash, namehash, parseGwei, parseEther, zeroHash, zeroAddress } from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  analyzeAndConfirm, createDryRunRunner, createWaitForBaseRunner,
  fundOnFork, loadJournal, spawnHardhatFork, DEFAULTS,
} from './gas-tools.mjs'
import { assembleVerification } from './build-verification.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const ARTIFACTS = join(REPO_ROOT, 'ens-contracts', 'artifacts', 'contracts')
const ENS_CONTRACTS_DIR = join(REPO_ROOT, 'ens-contracts')

const rpcUrl = process.env.MAINNET_RPC_URL
const deployerKey = process.env.DEPLOYER_KEY
// No default. An unset or typo'd SIMPLEX_TLD silently re-targets the whole run —
// gate logic, price array, journal, addresses file and verification metadata all
// follow it, and a `.testing`-defaulted run would resume against the committed
// `.testing` journal and then overwrite it with a mismatched schema.
const KNOWN_TLDS = ['testing', 'simplex']
const tld = process.env.SIMPLEX_TLD
if (!tld || !KNOWN_TLDS.includes(tld)) {
  console.error(
    `SIMPLEX_TLD must be set explicitly to one of: ${KNOWN_TLDS.join(', ')} (got ${JSON.stringify(tld)})`,
  )
  process.exit(1)
}
const nftGateEnabled = tld === 'testing'
const maxBaseFeeGwei = process.env.MAX_BASE_FEE_GWEI

const chainlinkEthUsd = process.env.ETHUSD_FEED || '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
const smpxNftAddr = process.env.SMPXNFT_ADDR || '0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291'
const ownerAddress = process.env.OWNER_ADDRESS || '0xDa064C4567fAD2c9Da7b6DD08b5C2B2607960340'
// The guardian holds the restrictive, no-delay powers: setRegistrarAllowance (the
// money kill switch), setPublicSalesOpen (the pause), addReservedNames, and it is
// `withdraw`'s payee. It must differ from the admin owner — that separation is the
// point. See docs/plans/names-v2-launch-to-freeze-plan.md.
const guardianAddress = process.env.GUARDIAN_ADDRESS
if (!guardianAddress || guardianAddress.toLowerCase() === ownerAddress.toLowerCase()) {
  console.error(
    'GUARDIAN_ADDRESS must be set and must differ from OWNER_ADDRESS.\n' +
      '  `setBeneficiary` is owner-callable only while the beneficiary is unset, so a\n' +
      '  guardian equal to the admin owner is burned in permanently at deploy time and\n' +
      '  collapses the two-key split the admin model is built on.',
  )
  process.exit(1)
}

const bumpAfterMs = (parseFloat(process.env.BUMP_AFTER_HOURS) || (DEFAULTS.BUMP_AFTER_MS / 3600000)) * 3600 * 1000
const bumpPct = BigInt(process.env.BUMP_PCT || DEFAULTS.BUMP_PCT)
// Default 18545 (not 8546): Reth/Geth use 8546 for the WebSocket JSON-RPC
// and 8545 for HTTP, so a stock node setup conflicts with the standard
// 8546 default. Pick a port that's unlikely to overlap with anything.
const forkPort = parseInt(process.env.FORK_PORT || '18545', 10)

if (!deployerKey) { console.error('ERROR: DEPLOYER_KEY env var is required.'); process.exit(1) }
if (!rpcUrl) { console.error('ERROR: MAINNET_RPC_URL env var is required.'); process.exit(1) }
if (!maxBaseFeeGwei) {
  console.error('ERROR: MAX_BASE_FEE_GWEI env var is required (e.g. "0.078").')
  console.error('       Pick this from Dune (e.g. the 5th-percentile recent base fee).')
  process.exit(1)
}
const maxBaseFeeWei = parseGwei(maxBaseFeeGwei)

const account = privateKeyToAccount(deployerKey)
const addressesPath = join(REPO_ROOT, `deployments.mainnet.${tld}.json`)
const journalPath = join(REPO_ROOT, `deployments.mainnet.${tld}.journal.jsonl`)
const attemptsLogPath = join(REPO_ROOT, `deployments.mainnet.${tld}.attempts.log`)

function loadArtifact(path) {
  const full = join(ARTIFACTS, path)
  const json = JSON.parse(readFileSync(full, 'utf8'))
  return { abi: json.abi, bytecode: json.bytecode }
}

/**
 * The actual SNRC deploy sequence, parameterised by a runner. Called
 * once with a dry-run runner (forked node) to capture gas, then again
 * with the real wait-for-base runner against mainnet.
 *
 * Returns the addresses object suitable for deployments.mainnet.${tld}.json.
 */
async function runDeploySequence({ deploy: deployRaw, write }) {
  const tldNode = namehash(tld)

  const deploy = async (name, artifactPath, args = []) => {
    const { abi, bytecode } = loadArtifact(artifactPath)
    return deployRaw(name, abi, bytecode, args)
  }

  const ensRegistry = await deploy('ENSRegistry',
    'registry/ENSRegistry.sol/ENSRegistry.json')

  const baseRegistrar = await deploy('BaseRegistrarImplementation',
    'ethregistrar/BaseRegistrarImplementation.sol/BaseRegistrarImplementation.json',
    [ensRegistry.address, tldNode])

  // No reverse registrar: SNRC maps names to SimpleX links in one direction and
  // nothing resolves an address back to a name. PublicResolver no longer inherits
  // ReverseClaimer, so nothing needs to own addr.reverse for the resolver to deploy.
  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash(tld), account.address])

  // attoUSD per second by label length [1, 2, 3, 4, 5, 6+]. Six entries, not five:
  // a five-entry array makes price5Letter apply to everything 5 chars and up, so
  // 5 and 6+ could not be priced apart. $10/yr at 6+, ten times more per character
  // lost, continuing down to 1 char so lowering minCharLength never hands out free
  // names.
  const priceArray = tld === 'testing'
    ? [0n, 0n, 0n, 0n, 0n, 0n]
    : [
        31709791983700000n, // 1 char    $1,000,000 / yr
        3170979198370000n,  // 2 chars     $100,000 / yr
        317097919837000n,   // 3 chars      $10,000 / yr
        31709791983700n,    // 4 chars       $1,000 / yr
        3170979198370n,     // 5 chars         $100 / yr
        317097919837n,      // 6+ chars         $10 / yr
      ]
  const priceOracle = await deploy('ExponentialPremiumPriceOracle',
    'ethregistrar/ExponentialPremiumPriceOracle.sol/ExponentialPremiumPriceOracle.json',
    [chainlinkEthUsd, priceArray, 100000000000000000000000000n, 21n])

  const smpxNft = { address: smpxNftAddr }

  const controllerImpl = await deploy('SimplexControllerImpl',
    'simplex/SimplexController.sol/SimplexController.json')

  const initData = encodeFunctionData({
    abi: controllerImpl.abi,
    functionName: 'initialize',
    args: [
      baseRegistrar.address,
      priceOracle.address,
      60n,
      86400n,
      ensRegistry.address,
      {
        tldNode,
        tldSuffix: `.${tld}`,
        minCharLength: 6,
        smpxNft: nftGateEnabled ? smpxNft.address : zeroAddress,
        nftGateEnabled,
      },
      account.address,
    ],
  })

  const controllerProxy = await deploy('SimplexControllerProxy',
    'simplex/SimplexControllerProxy.sol/SimplexControllerProxy.json',
    [controllerImpl.address, initData])

  const controller = { address: controllerProxy.address, abi: controllerImpl.abi }

  await write(baseRegistrar, 'addController', [controller.address])

  const reservedAtDeploy = ['simplex', 'simplex-chat']
  await write(controller, 'addReservedNames', [reservedAtDeploy])

  // SubnameRegistrar owns + resolves subnames, soulbound to the 2LD NFT. It is
  // deployed before the resolver because the resolver's nameWrapper slot points
  // at it (subname records authorise via subnameRegistrar.ownerOf).
  const subnameRegistrar = await deploy('SubnameRegistrar',
    'simplex/SubnameRegistrar.sol/SubnameRegistrar.json',
    [ensRegistry.address, baseRegistrar.address])

  // SimplexResolver = PublicResolver + signed record writes (setTextWithSig,
  // clearRecordsWithSig), so a user with no ETH can have records relayed.
  // wrapper-free v3: the NameWrapper slot is repurposed for the SubnameRegistrar
  // (the 2LD itself is never wrapped — its node is owned directly by the NFT
  // holder via auto-reclaim). trustedReverseRegistrar is address(0) and inert.
  const publicResolver = await deploy('SimplexResolver',
    'simplex/SimplexResolver.sol/SimplexResolver.json',
    [ensRegistry.address, subnameRegistrar.address, controller.address, zeroAddress])

  // One-time wiring now that the resolver exists, while the deployer still owns
  // the registrar (before the ownership handover below).
  await write(subnameRegistrar, 'setResolver', [publicResolver.address])
  await write(baseRegistrar, 'setSubnameHook', [subnameRegistrar.address])
  // registerReserved points a brand's name here, so it resolves without the brand
  // ever holding ETH.
  await write(controller, 'setDefaultResolver', [publicResolver.address])

  const dummyGateway = await deploy('DummyGatewayProvider',
    'mocks/DummyGatewayProvider.sol/DummyGatewayProvider.json')
  const universalResolver = await deploy('UniversalResolver',
    'universalResolver/UniversalResolver.sol/UniversalResolver.json',
    [account.address, ensRegistry.address, dummyGateway.address])

  await write(ensRegistry, 'setResolver', [tldNode, publicResolver.address])
  await write(ensRegistry, 'setOwner', [tldNode, baseRegistrar.address])

  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash('eth'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('eth'), publicResolver.address])
  await write(ensRegistry, 'setSubnodeOwner', [namehash('eth'), labelhash('data'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('data.eth'), publicResolver.address])
  await write(ensRegistry, 'setSubnodeOwner', [namehash('data.eth'), labelhash('eth-usd'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('eth-usd.data.eth'), publicResolver.address])
  await write(publicResolver, 'setAddr', [namehash('eth-usd.data.eth'), chainlinkEthUsd])

  // On-chain NFT metadata + subname index. setMetadataRenderer must run while the
  // deployer still owns the registrar (before the ownership handover below).
  const metadataRenderer = await deploy('MetadataRenderer',
    'simplex/MetadataRenderer.sol/MetadataRenderer.json',
    [`.${tld}`])
  await write(baseRegistrar, 'setMetadataRenderer', [metadataRenderer.address])
  // Cap label length at the DNS octet limit (63 bytes). Bounds labelOf storage
  // and on-chain SVG/JSON render size. (security.md L4)
  await write(baseRegistrar, 'setMaxLabelLength', [63n])

  // Set the beneficiary BEFORE handing ownership over. `setBeneficiary` is
  // owner-callable only while it is unset and beneficiary-callable thereafter, so
  // doing it here is what makes revenue and the registrar kill switch independent
  // of the admin key from the first block. Skipping it leaves `withdraw` reverting.
  await write(controller, 'setBeneficiary', [guardianAddress])

  if (ownerAddress.toLowerCase() !== account.address.toLowerCase()) {
    await write(baseRegistrar, 'transferOwnership', [ownerAddress])
    await write(ensRegistry, 'setOwner', [namehash('eth-usd.data.eth'), ownerAddress])
    await write(ensRegistry, 'setOwner', [namehash('data.eth'), ownerAddress])
    await write(ensRegistry, 'setOwner', [namehash('eth'), ownerAddress])
    await write(ensRegistry, 'setOwner', [zeroHash, ownerAddress])
    await write(controller, 'transferOwnership', [ownerAddress])
  }

  return {
    ENSRegistry: ensRegistry.address,
    BaseRegistrarImplementation: baseRegistrar.address,
    ReverseRegistrar: zeroAddress,
    DefaultReverseRegistrar: zeroAddress,
    NameWrapper: zeroAddress, // wrapper-free v3
    MetadataRenderer: metadataRenderer.address,
    SubnameRegistrar: subnameRegistrar.address,
    PublicResolver: publicResolver.address,
    ETHRegistrarController: controller.address,
    // Implementation address for the SimplexController behind the
    // ETHRegistrarController proxy. Surfaced so Etherscan source
    // verification can target both impl + proxy.
    SimplexControllerImpl: controllerImpl.address,
    ExponentialPremiumPriceOracle: priceOracle.address,
    // 3rd constructor arg of UniversalResolver — kept so verification
    // can reconstruct that contract's calldata.
    DummyGatewayProvider: dummyGateway.address,
    DummyOracle: chainlinkEthUsd,
    SMPXNFT: smpxNftAddr,
    NameWrapperPublicResolver: publicResolver.address,
    UniversalResolver: universalResolver.address,
    Multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
    DNSRegistrar: '0x0000000000000000000000000000000000000000',
    DNSSECImpl: '0x0000000000000000000000000000000000000000',
    LegacyETHRegistrarController: '0x0000000000000000000000000000000000000000',
    LegacyPublicResolver: '0x0000000000000000000000000000000000000000',
    WrappedEthRegistrarController: '0x0000000000000000000000000000000000000000',
    WrappedStaticBulkRenewal: '0x0000000000000000000000000000000000000000',
    UniversalRegistrarRenewalWithReferrer: '0x0000000000000000000000000000000000000000',
    OffchainDNSResolver: '0x0000000000000000000000000000000000000000',
    ExtendedDNSResolver: '0x0000000000000000000000000000000000000000',
    OutdatedResolver: '0x0000000000000000000000000000000000000000',
  }
}

// Track the spawned fork at module scope so cleanup handlers can reach it.
let activeFork = null
function cleanupFork() {
  if (activeFork) {
    try { activeFork.stop() } catch {}
    activeFork = null
  }
}
process.on('SIGINT',  () => { cleanupFork(); process.exit(130) })
process.on('SIGTERM', () => { cleanupFork(); process.exit(143) })
process.on('exit',    () => { cleanupFork() })

async function main() {
  console.log(`SNRC mainnet deploy for .${tld} (chainId ${mainnet.id})`)
  console.log(`  Deployer:          ${account.address}`)
  console.log(`  Cold owner:        ${ownerAddress}`)
  console.log(`  Chainlink ETH/USD: ${chainlinkEthUsd}`)
  console.log(`  SMPXNFT:           ${smpxNftAddr}`)
  console.log(`  Cap (gwei):        ${maxBaseFeeGwei}`)
  console.log(`  Bump rule:         after ${bumpAfterMs / 3600000}h stall, cap × ${Number(100n + bumpPct) / 100}`)
  console.log(`  Journal:           ${journalPath}`)
  console.log(`  Attempts log:      ${attemptsLogPath}`)

  // ----- 1. Dry run against a forked mainnet -----
  activeFork = await spawnHardhatFork({
    mainnetRpcUrl: rpcUrl,
    port: forkPort,
    ensContractsDir: ENS_CONTRACTS_DIR,
  })
  let dryTotals
  try {
    await fundOnFork({
      forkUrl: activeFork.url,
      address: account.address,
      weiHex: '0x56bc75e2d63100000',  // 100 ETH
    })
    const dry = createDryRunRunner({ forkUrl: activeFork.url, forkChainId: activeFork.chainId, account })
    console.log(`\n--- Dry-run on fork ---`)
    await runDeploySequence({
      deploy: dry.deploy,
      write: dry.write,
    })
    dryTotals = dry.totals()
    console.log(`Dry-run captured ${dryTotals.perStep.length} steps, ${dryTotals.totalGas.toLocaleString()} gas total`)
  } finally {
    cleanupFork()
  }

  // ----- 2. Preflight + confirm -----
  const transport = http(rpcUrl)
  const publicClient = createPublicClient({ chain: mainnet, transport })
  const walletClient = createWalletClient({ chain: mainnet, transport, account })

  await analyzeAndConfirm({
    publicClient, account,
    maxBaseFeeWei, dryRunTotals: dryTotals,
    journalPath,
    bumpAfterMs, bumpPct,
    label: `.${tld} mainnet deploy preflight`,
  })

  // ----- 3. Real deploy against mainnet -----
  console.log(`\n--- Real deploy ---`)
  const real = createWaitForBaseRunner({
    publicClient, walletClient, account,
    maxBaseFeeWei, bumpAfterMs, bumpPct,
    journalPath, attemptsLogPath,
  })

  const addresses = await runDeploySequence({
    deploy: real.deploy,
    write: real.write,
  })

  console.log(`\nDeployer remaining balance: ${(Number(await publicClient.getBalance({ address: account.address })) / 1e18).toFixed(6)} ETH`)
  console.log(`Total spent this run+prior: ${(Number(real.spent()) / 1e18).toFixed(6)} ETH`)

  writeFileSync(addressesPath, JSON.stringify(addresses, null, 2))
  console.log(`Wrote ${addressesPath}`)

  // Emit verification metadata so `verify-etherscan.mjs` (with NETWORK=mainnet)
  // can pick this deploy up without a separate reconstruction pass.
  const verificationPath = join(REPO_ROOT, `verification.mainnet.${tld}.json`)
  const verificationMeta = assembleVerification({
    network: 'mainnet', tld, addresses,
    deployer: account.address, chainlinkEthUsd, smpxNftAddr,
  })
  writeFileSync(verificationPath, JSON.stringify(verificationMeta, null, 2))
  console.log(`Wrote ${verificationPath}`)

  console.log(`\nCommit ${addressesPath} AND ${journalPath} AND ${verificationPath} to the repo.`)
  console.log(`See docs/deployment.md → Mainnet → Step 3.`)
}

main().catch((err) => {
  cleanupFork()
  console.error(err)
  process.exit(1)
})
