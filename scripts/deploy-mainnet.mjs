#!/usr/bin/env node
/**
 * Deploy SNRC contracts to Ethereum mainnet — frugal, resumable.
 *
 * Each TLD (.testing, .simplex) is an independent deployment — run this
 * script once per TLD. Same shape as scripts/deploy-testnet.mjs but:
 *   - chain = mainnet
 *   - uses the real SMPXNFT contract (no MockSMPXNFT)
 *   - uses the mainnet Chainlink ETH/USD feed
 *   - gas strategy: zero priority + probe at 10% of base + ×√2 bump every
 *     15 min (see scripts/gas-tools.mjs for the full state machine)
 *   - total spend capped by GAS_BUDGET_ETH; aborts cleanly if the next
 *     attempt would push past it
 *   - every successful tx appended to a JSONL journal; re-running the
 *     script after a partial failure picks up exactly where it left off
 *
 * Required env vars:
 *   DEPLOYER_KEY     hex private key (0x...) of the ephemeral deployer EOA
 *   MAINNET_RPC_URL  JSON-RPC URL for Ethereum mainnet
 *   GAS_BUDGET_ETH   total spend cap for the whole deploy (e.g. "0.3")
 *
 * Optional env vars:
 *   SIMPLEX_TLD      'testing' (default) | 'simplex'
 *   ETHUSD_FEED      Chainlink AggregatorV3 (default: mainnet feed)
 *   SMPXNFT_ADDR     SMPXNFT contract  (default: mainnet 0x3AF6D9Ee…7291)
 *   OWNER_ADDRESS    cold owner to hand off to (default: simplexchat.eth)
 *   CONFIRM=yes      skip the interactive confirmation prompt
 *
 * Files written next to the addresses file:
 *   deployments.mainnet.${tld}.json            ← final addresses (on success)
 *   deployments.mainnet.${tld}.journal.jsonl   ← per-tx journal (resume source)
 *   deployments.mainnet.${tld}.attempts.log    ← every attempt + reason
 *
 * The deployer is responsible for committing the addresses file AND the
 * journal to the repo. See docs/deployment.md.
 *
 * Run from the parent repo:
 *   DEPLOYER_KEY=0x... MAINNET_RPC_URL=https://... GAS_BUDGET_ETH=0.3 \
 *     SIMPLEX_TLD=simplex node scripts/deploy-mainnet.mjs
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http, labelhash, namehash, parseEther, zeroHash, zeroAddress } from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { analyzeAndConfirm, createFrugalDeployer } from './gas-tools.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = join(__dirname, '..', 'ens-contracts', 'artifacts', 'contracts')

const rpcUrl = process.env.MAINNET_RPC_URL
const deployerKey = process.env.DEPLOYER_KEY
const tld = process.env.SIMPLEX_TLD || 'testing'
const nftGateEnabled = tld === 'testing'
const budgetEthRaw = process.env.GAS_BUDGET_ETH

// Mainnet defaults — overridable via env.
const chainlinkEthUsd = process.env.ETHUSD_FEED || '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
const smpxNftAddr = process.env.SMPXNFT_ADDR || '0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291'
const ownerAddress = process.env.OWNER_ADDRESS || '0xDa064C4567fAD2c9Da7b6DD08b5C2B2607960340'

if (!deployerKey) {
  console.error('ERROR: DEPLOYER_KEY env var is required (0x-prefixed private key).')
  process.exit(1)
}
if (!rpcUrl) {
  console.error('ERROR: MAINNET_RPC_URL env var is required.')
  process.exit(1)
}
if (!budgetEthRaw) {
  console.error('ERROR: GAS_BUDGET_ETH env var is required (e.g. "0.3").')
  console.error('       The script will not send any tx that would push spend past this cap.')
  process.exit(1)
}
const budgetWei = parseEther(budgetEthRaw)

const REPO_ROOT = join(__dirname, '..')
const addressesPath = join(REPO_ROOT, `deployments.mainnet.${tld}.json`)
const journalPath = join(REPO_ROOT, `deployments.mainnet.${tld}.journal.jsonl`)
const attemptsLogPath = join(REPO_ROOT, `deployments.mainnet.${tld}.attempts.log`)

const account = privateKeyToAccount(deployerKey)
const transport = http(rpcUrl)
const publicClient = createPublicClient({ chain: mainnet, transport })
const walletClient = createWalletClient({ chain: mainnet, transport, account })

function loadArtifact(path) {
  const full = join(ARTIFACTS, path)
  const json = JSON.parse(readFileSync(full, 'utf8'))
  return { abi: json.abi, bytecode: json.bytecode }
}

async function main() {
  const tldNode = namehash(tld)
  console.log(`Deploying SNRC for .${tld} TLD to Ethereum mainnet (chainId ${mainnet.id})`)
  console.log(`  Deployer:          ${account.address}`)
  console.log(`  Cold owner:        ${ownerAddress}`)
  console.log(`  Chainlink ETH/USD: ${chainlinkEthUsd}`)
  console.log(`  SMPXNFT:           ${smpxNftAddr}`)
  console.log(`  Journal:           ${journalPath}`)
  console.log(`  Attempts log:      ${attemptsLogPath}`)

  // Stats, budget, resume preview, interactive confirm.
  await analyzeAndConfirm({
    publicClient, account, budgetWei, journalPath,
    label: `.${tld} mainnet deploy`,
  })

  // Frugal runner: probe at 10% × baseFee, ×√2 escalation per attempt,
  // 15min mempool watch, journal-backed resume, hard-capped at budgetWei.
  const { deploy: deployRaw, write } = createFrugalDeployer({
    publicClient, walletClient, account,
    budgetWei, journalPath, attemptsLogPath,
  })
  const deploy = async (name, artifactPath, args = []) => {
    const { abi, bytecode } = loadArtifact(artifactPath)
    return deployRaw(name, abi, bytecode, args)
  }

  // --- Deploys ---

  const ensRegistry = await deploy('ENSRegistry',
    'registry/ENSRegistry.sol/ENSRegistry.json')

  const baseRegistrar = await deploy('BaseRegistrarImplementation',
    'ethregistrar/BaseRegistrarImplementation.sol/BaseRegistrarImplementation.json',
    [ensRegistry.address, tldNode])

  const reverseRegistrar = await deploy('ReverseRegistrar',
    'reverseRegistrar/ReverseRegistrar.sol/ReverseRegistrar.json',
    [ensRegistry.address])

  const defaultReverseRegistrar = await deploy('DefaultReverseRegistrar',
    'reverseRegistrar/DefaultReverseRegistrar.sol/DefaultReverseRegistrar.json')

  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash('reverse'), account.address])
  await write(ensRegistry, 'setSubnodeOwner', [namehash('reverse'), labelhash('addr'), reverseRegistrar.address])
  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash(tld), account.address])

  const nameWrapper = await deploy('NameWrapper',
    'wrapper/NameWrapper.sol/NameWrapper.json',
    [ensRegistry.address, baseRegistrar.address, account.address])

  // .testing stays free in the early phase (NFT-gated; gas-only).
  // .simplex uses the production pricing curve: $1/$8/$32/$128 per year
  // for 6+/5/4/3 chars, with the standard exponential premium ramp.
  const priceArray = tld === 'testing'
    ? [0n, 0n, 0n, 0n, 0n]
    : [0n, 0n, 4056075240196n, 1014018810049n, 31688087814n]
  const priceOracle = await deploy('ExponentialPremiumPriceOracle',
    'ethregistrar/ExponentialPremiumPriceOracle.sol/ExponentialPremiumPriceOracle.json',
    [chainlinkEthUsd, priceArray, 100000000000000000000000000n, 21n])

  // Mainnet uses the real SMPXNFT — skip MockSMPXNFT entirely.
  const smpxNft = { address: smpxNftAddr }

  // SimplexController via UUPS proxy. Init data is encoded as the proxy
  // constructor's calldata so initialize() runs atomically.
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
      reverseRegistrar.address,
      defaultReverseRegistrar.address,
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
  await write(reverseRegistrar, 'setController', [controller.address, true])
  await write(defaultReverseRegistrar, 'setController', [controller.address, true])

  const reservedAtDeploy = ['simplex', 'simplex-chat']
  await write(controller, 'addReservedNames', [reservedAtDeploy])

  const publicResolver = await deploy('PublicResolver',
    'resolvers/PublicResolver.sol/PublicResolver.json',
    [ensRegistry.address, nameWrapper.address, controller.address, reverseRegistrar.address])

  await write(reverseRegistrar, 'setDefaultResolver', [publicResolver.address])

  const dummyGateway = await deploy('DummyGatewayProvider',
    'mocks/DummyGatewayProvider.sol/DummyGatewayProvider.json')
  const universalResolver = await deploy('UniversalResolver',
    'universalResolver/UniversalResolver.sol/UniversalResolver.json',
    [account.address, ensRegistry.address, dummyGateway.address])

  await write(ensRegistry, 'setResolver', [tldNode, publicResolver.address])
  await write(ensRegistry, 'setOwner', [tldNode, baseRegistrar.address])

  // The frontend's `useEthPrice` resolves eth-usd.data.eth → oracle on chain.
  // We register this name in OUR registry (not mainnet ENS) so the frontend
  // can fetch the Chainlink feed without reaching outside our deployment.
  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash('eth'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('eth'), publicResolver.address])
  await write(ensRegistry, 'setSubnodeOwner', [namehash('eth'), labelhash('data'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('data.eth'), publicResolver.address])
  await write(ensRegistry, 'setSubnodeOwner', [namehash('data.eth'), labelhash('eth-usd'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('eth-usd.data.eth'), publicResolver.address])
  await write(publicResolver, 'setAddr', [namehash('eth-usd.data.eth'), chainlinkEthUsd])

  // --- Ownership handoff to cold owner ---
  // After this, the deployer EOA holds nothing on any deployed contract
  // except SimplexController admin, which is gated behind Ownable2Step's
  // acceptOwnership — only the cold owner can complete the transfer.
  if (ownerAddress.toLowerCase() !== account.address.toLowerCase()) {
    console.log(`\n=== Handing off ownership to ${ownerAddress} ===`)

    await write(baseRegistrar, 'transferOwnership', [ownerAddress])
    await write(nameWrapper, 'transferOwnership', [ownerAddress])
    await write(reverseRegistrar, 'transferOwnership', [ownerAddress])
    await write(defaultReverseRegistrar, 'transferOwnership', [ownerAddress])

    await write(ensRegistry, 'setOwner', [namehash('reverse'), ownerAddress])
    await write(ensRegistry, 'setOwner', [namehash('eth-usd.data.eth'), ownerAddress])
    await write(ensRegistry, 'setOwner', [namehash('data.eth'), ownerAddress])
    await write(ensRegistry, 'setOwner', [namehash('eth'), ownerAddress])
    await write(ensRegistry, 'setOwner', [zeroHash, ownerAddress])

    await write(controller, 'transferOwnership', [ownerAddress])
    console.log(`\nSimplexController pendingOwner = ${ownerAddress}`)
    console.log(`Cold owner must call controller.acceptOwnership() at ${controller.address}`)
    console.log(`to complete the handover.`)
  } else {
    console.log(`\nDeployer is the configured owner — no handover.`)
  }

  // --- Final summary ---
  const finalBalance = await publicClient.getBalance({ address: account.address })
  console.log(`\nDeployer remaining balance: ${(Number(finalBalance) / 1e18).toFixed(4)} ETH`)

  const addresses = {
    ENSRegistry: ensRegistry.address,
    BaseRegistrarImplementation: baseRegistrar.address,
    ReverseRegistrar: reverseRegistrar.address,
    DefaultReverseRegistrar: defaultReverseRegistrar.address,
    NameWrapper: nameWrapper.address,
    PublicResolver: publicResolver.address,
    ETHRegistrarController: controller.address,
    ExponentialPremiumPriceOracle: priceOracle.address,
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

  writeFileSync(addressesPath, JSON.stringify(addresses, null, 2))
  console.log(`Wrote ${addressesPath}`)
  console.log(`\nCommit ${addressesPath} AND ${journalPath} to the repo.`)
  console.log(`See docs/deployment.md → Mainnet → Step 2.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
