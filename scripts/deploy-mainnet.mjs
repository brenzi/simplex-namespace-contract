#!/usr/bin/env node
/**
 * Deploy SNRC contracts to Ethereum mainnet.
 *
 * Each TLD (.testing, .simplex) is an independent deployment — run this
 * script once per TLD. Same shape as scripts/deploy-testnet.mjs but:
 *   - chain = mainnet
 *   - uses the real SMPXNFT contract (no MockSMPXNFT)
 *   - uses the mainnet Chainlink ETH/USD feed
 *   - starts with a gas-price analysis + interactive cost confirmation
 *   - every tx is sent through an accelerating wrapper that bumps gas if
 *     the tx hasn't mined within 5 min
 *
 * Required env vars:
 *   DEPLOYER_KEY     hex private key (0x...) of the ephemeral deployer EOA
 *   MAINNET_RPC_URL  JSON-RPC URL for Ethereum mainnet
 *
 * Optional env vars:
 *   SIMPLEX_TLD      'testing' (default) | 'simplex'
 *   ETHUSD_FEED      Chainlink AggregatorV3 (default: mainnet feed)
 *   SMPXNFT_ADDR     SMPXNFT contract  (default: mainnet 0x3AF6D9Ee…7291)
 *   OWNER_ADDRESS    cold owner to hand off to (default: simplexchat.eth)
 *   EXPECTED_GAS     override total gas estimate used for the cost preview
 *                    (default: 120000000 — derived from Sepolia ~112M)
 *   CONFIRM=yes      skip the interactive confirmation prompt
 *
 * Run from the parent repo:
 *   DEPLOYER_KEY=0x... MAINNET_RPC_URL=https://... \
 *     SIMPLEX_TLD=simplex node scripts/deploy-mainnet.mjs
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http, labelhash, namehash, zeroHash, zeroAddress } from 'viem'
import { mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { analyzeAndConfirm, createAcceleratingDeployer } from './gas-tools.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = join(__dirname, '..', 'ens-contracts', 'artifacts', 'contracts')

const rpcUrl = process.env.MAINNET_RPC_URL
const deployerKey = process.env.DEPLOYER_KEY
const tld = process.env.SIMPLEX_TLD || 'testing'
const nftGateEnabled = tld === 'testing'

// Mainnet defaults — overridable via env.
const chainlinkEthUsd = process.env.ETHUSD_FEED || '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
const smpxNftAddr = process.env.SMPXNFT_ADDR || '0x3AF6D9Ee862376A8DFC0a78847Eb20A153557291'
const ownerAddress = process.env.OWNER_ADDRESS || '0xDa064C4567fAD2c9Da7b6DD08b5C2B2607960340'
const expectedGas = BigInt(process.env.EXPECTED_GAS || 120_000_000)

if (!deployerKey) {
  console.error('ERROR: DEPLOYER_KEY env var is required (0x-prefixed private key).')
  process.exit(1)
}
if (!rpcUrl) {
  console.error('ERROR: MAINNET_RPC_URL env var is required.')
  process.exit(1)
}

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

  // Gas + cost analysis + interactive confirm. Returns the gas params that
  // every tx in the deploy will use (sub-normal price, capped to leave room
  // for one acceleration bump).
  const gasParams = await analyzeAndConfirm({
    publicClient, account, expectedGas,
    label: `.${tld} mainnet deploy`,
  })

  // Wrap deploy/write so every tx is watched for inclusion and accelerated
  // (same nonce, +30% gas) if it hasn't mined within 5 minutes.
  const { deploy: deployRaw, write } = createAcceleratingDeployer({
    publicClient, walletClient, account, gasParams,
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

  const outFile = join(__dirname, '..', `deployments.mainnet.${tld}.json`)
  writeFileSync(outFile, JSON.stringify(addresses, null, 2))
  console.log(`Wrote ${outFile}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
