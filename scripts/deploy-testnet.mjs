#!/usr/bin/env node
/**
 * Deploy SNRC contracts to a public testnet (Sepolia by default).
 *
 * Required env vars:
 *   DEPLOYER_KEY    - hex private key (with 0x) of the deployer EOA
 *   SEPOLIA_RPC_URL - JSON-RPC URL for Sepolia (or pass --rpc-url)
 *
 * Optional:
 *   SIMPLEX_TLD     - 'testing' (default) or 'simplex'
 *   ETHUSD_FEED     - override the Chainlink ETH/USD feed
 *
 * Outputs deployments.sepolia.json next to this script's parent dir.
 *
 * Run from the parent repo:
 *   DEPLOYER_KEY=0x... SEPOLIA_RPC_URL=https://... node scripts/deploy-testnet.mjs
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http, labelhash, namehash, zeroHash, zeroAddress } from 'viem'
import { sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = join(__dirname, '..', 'ens-contracts', 'artifacts', 'contracts')

const rpcUrl = process.env.SEPOLIA_RPC_URL
const deployerKey = process.env.DEPLOYER_KEY
const tld = process.env.SIMPLEX_TLD || 'testing'
const nftGateEnabled = tld === 'testing'
// Sepolia Chainlink ETH/USD feed (8-decimal answer). The PriceOracle reads
// `latestAnswer()` directly, so any Chainlink AggregatorV3-compatible feed works.
const chainlinkEthUsd = process.env.ETHUSD_FEED || '0x694AA1769357215DE4FAC081bf1f309aDC325306'

// Final owner of SimplexController (admin + UUPS upgrade authority).
// 0xDa064C4567fAD2c9Da7b6DD08b5C2B2607960340 owns simplexchat.eth and is
// held in cold storage. The DEPLOYER_KEY here is treated as ephemeral: it
// holds only gas for the deploy, briefly holds owner during setup so it
// can wire up reserved names and controllers, and is handed off at the
// end via Ownable2Step's transferOwnership. The cold owner must call
// acceptOwnership() afterwards to complete the handover.
const ownerAddress = process.env.OWNER_ADDRESS || '0xDa064C4567fAD2c9Da7b6DD08b5C2B2607960340'

if (!deployerKey) {
  console.error('ERROR: DEPLOYER_KEY env var is required (0x-prefixed private key).')
  process.exit(1)
}
if (!rpcUrl) {
  console.error('ERROR: SEPOLIA_RPC_URL env var is required.')
  process.exit(1)
}

const account = privateKeyToAccount(deployerKey)
const transport = http(rpcUrl)
const publicClient = createPublicClient({ chain: sepolia, transport })
const walletClient = createWalletClient({ chain: sepolia, transport, account })

function loadArtifact(path) {
  const full = join(ARTIFACTS, path)
  const json = JSON.parse(readFileSync(full, 'utf8'))
  return { abi: json.abi, bytecode: json.bytecode }
}

async function deploy(name, artifactPath, args = []) {
  const { abi, bytecode } = loadArtifact(artifactPath)
  const hash = await walletClient.deployContract({ abi, bytecode, args })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  console.log(`${name}: ${receipt.contractAddress}`)
  return { address: receipt.contractAddress, abi }
}

async function write(contract, functionName, args) {
  const hash = await walletClient.writeContract({
    address: contract.address,
    abi: contract.abi,
    functionName,
    args,
  })
  await publicClient.waitForTransactionReceipt({ hash })
}

async function main() {
  const tldNode = namehash(tld)
  console.log(`Deploying SNRC for .${tld} TLD to Sepolia (chainId ${sepolia.id})...`)
  console.log(`Deployer: ${account.address}`)
  const balance = await publicClient.getBalance({ address: account.address })
  console.log(`Balance: ${balance} wei`)
  if (balance < 100_000_000_000_000_000n) {
    console.warn('WARNING: Deployer balance is below 0.1 ETH. A full deploy needs ~0.3 ETH of gas.')
  }
  console.log(`Chainlink ETH/USD feed: ${chainlinkEthUsd}\n`)

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

  // Use the real Chainlink feed as the oracle. The ENS pricing contracts call
  // `latestAnswer()` on it; ChainlinkAggregator and our DummyOracle share that
  // method, so the feed slots in directly.
  const priceOracle = await deploy('ExponentialPremiumPriceOracle',
    'ethregistrar/ExponentialPremiumPriceOracle.sol/ExponentialPremiumPriceOracle.json',
    [chainlinkEthUsd, [0n, 0n, 4056075240196n, 1014018810049n, 31688087814n], 100000000000000000000000000n, 21n])

  // Sepolia has no SMPXNFT, so deploy a MockSMPXNFT for the testing-phase gate.
  // Token #0 goes straight to the cold owner so the deployer never holds an
  // NFT; the cold owner mints additional ones for testers afterward.
  const mockNft = await deploy('MockSMPXNFT', 'mocks/MockSMPXNFT.sol/MockSMPXNFT.json')
  await write(mockNft, 'mint', [ownerAddress])
  console.log(`Minted NFT #0 to ${ownerAddress}`)

  // SimplexController is upgradeable. Deploy the implementation, then an
  // ERC1967 proxy that calls initialize() atomically as constructor data.
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
        smpxNft: nftGateEnabled ? mockNft.address : zeroAddress,
        nftGateEnabled,
      },
      account.address,
    ],
  })

  const controllerProxy = await deploy('SimplexControllerProxy',
    'simplex/SimplexControllerProxy.sol/SimplexControllerProxy.json',
    [controllerImpl.address, initData])

  // Use the proxy address everywhere SimplexController is referenced.
  const controller = { address: controllerProxy.address, abi: controllerImpl.abi }

  await write(baseRegistrar, 'addController', [controller.address])
  await write(reverseRegistrar, 'setController', [controller.address, true])
  await write(defaultReverseRegistrar, 'setController', [controller.address, true])
  console.log('Controller wired up')

  for (const label of ['simplex', 'simplex-chat']) {
    await write(controller, 'addReservedName', [label])
    console.log(`Reserved: ${label}.${tld}`)
  }

  const publicResolver = await deploy('PublicResolver',
    'resolvers/PublicResolver.sol/PublicResolver.json',
    [ensRegistry.address, nameWrapper.address, controller.address, reverseRegistrar.address])

  await write(reverseRegistrar, 'setDefaultResolver', [publicResolver.address])

  // UniversalResolver — needed by the frontend for name lookups
  const dummyGateway = await deploy('DummyGatewayProvider',
    'mocks/DummyGatewayProvider.sol/DummyGatewayProvider.json')
  const universalResolver = await deploy('UniversalResolver',
    'universalResolver/UniversalResolver.sol/UniversalResolver.json',
    [account.address, ensRegistry.address, dummyGateway.address])

  await write(ensRegistry, 'setResolver', [tldNode, publicResolver.address])
  await write(ensRegistry, 'setOwner', [tldNode, baseRegistrar.address])
  console.log(`.${tld} node transferred to BaseRegistrar`)

  // The frontend's `useEthPrice` resolves eth-usd.data.eth -> oracle on chain.
  // Sepolia doesn't have this name registered in ENS, so we register it under our
  // own ENSRegistry (which is the only registry the frontend talks to here) and
  // point it at the Chainlink feed.
  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash('eth'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('eth'), publicResolver.address])
  await write(ensRegistry, 'setSubnodeOwner', [namehash('eth'), labelhash('data'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('data.eth'), publicResolver.address])
  await write(ensRegistry, 'setSubnodeOwner', [namehash('data.eth'), labelhash('eth-usd'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('eth-usd.data.eth'), publicResolver.address])
  await write(publicResolver, 'setAddr', [namehash('eth-usd.data.eth'), chainlinkEthUsd])
  console.log('eth-usd.data.eth -> Chainlink feed')

  // Hand every persistent role off to the cold owner. After this block,
  // the deployer EOA holds nothing on any deployed contract — its only
  // remaining capability is admin on SimplexController, gated behind
  // Ownable2Step's acceptOwnership which only the cold owner can call.
  //
  // Skip the handoff if the deployer IS the configured owner (single-key
  // dev mode used when OWNER_ADDRESS isn't set or matches the deployer).
  if (ownerAddress.toLowerCase() !== account.address.toLowerCase()) {
    console.log(`\n=== Handing off ownership to ${ownerAddress} ===`)

    // Ownable (single-step — these transfer immediately).
    await write(baseRegistrar, 'transferOwnership', [ownerAddress])
    console.log(`  BaseRegistrar owner -> cold`)
    await write(nameWrapper, 'transferOwnership', [ownerAddress])
    console.log(`  NameWrapper owner -> cold`)
    await write(mockNft, 'transferOwnership', [ownerAddress])
    console.log(`  MockSMPXNFT owner -> cold`)
    await write(reverseRegistrar, 'transferOwnership', [ownerAddress])
    console.log(`  ReverseRegistrar owner -> cold`)
    await write(defaultReverseRegistrar, 'transferOwnership', [ownerAddress])
    console.log(`  DefaultReverseRegistrar owner -> cold`)

    // ENS subnodes still owned by the deployer (from the dApp-helper
    // setup of the eth-usd.data.eth path and the reverse namespace).
    // Transfer them explicitly so the deployer can't change the price
    // oracle pointer or rebind the reverse namespace post-handoff.
    await write(ensRegistry, 'setOwner', [namehash('reverse'), ownerAddress])
    await write(ensRegistry, 'setOwner', [namehash('eth-usd.data.eth'), ownerAddress])
    await write(ensRegistry, 'setOwner', [namehash('data.eth'), ownerAddress])
    await write(ensRegistry, 'setOwner', [namehash('eth'), ownerAddress])
    console.log(`  ENS subnodes (reverse, eth-usd.data.eth, data.eth, eth) -> cold`)

    // ENS root last. After this the deployer can't reassign any TLD.
    await write(ensRegistry, 'setOwner', [zeroHash, ownerAddress])
    console.log(`  ENS root -> cold`)

    // SimplexController uses Ownable2Step — this sets pendingOwner but
    // does NOT transfer admin until the cold owner accepts.
    await write(controller, 'transferOwnership', [ownerAddress])
    console.log(`\n  SimplexController pendingOwner -> ${ownerAddress}`)
    console.log(`  To complete the handover, the cold owner must submit:`)
    console.log(`      controller.acceptOwnership()  at ${controller.address}`)
    console.log(`  Until then the deployer EOA (${account.address}) still has`)
    console.log(`  SimplexController admin rights (and nothing else).`)
  } else {
    console.log(`\nDeployer (${account.address}) remains owner of all contracts — no handover.`)
  }

  const addresses = {
    ENSRegistry: ensRegistry.address,
    BaseRegistrarImplementation: baseRegistrar.address,
    ReverseRegistrar: reverseRegistrar.address,
    DefaultReverseRegistrar: defaultReverseRegistrar.address,
    NameWrapper: nameWrapper.address,
    PublicResolver: publicResolver.address,
    ETHRegistrarController: controller.address,
    ExponentialPremiumPriceOracle: priceOracle.address,
    // ChainLink feed (used in place of DummyOracle on Sepolia).
    DummyOracle: chainlinkEthUsd,
    MockSMPXNFT: mockNft.address,
    NameWrapperPublicResolver: publicResolver.address,
    UniversalResolver: universalResolver.address,
    // Multicall3 is canonically deployed across networks at the same address.
    Multicall: '0xcA11bde05977b3631167028862bE2a173976CA11',
    DNSRegistrar: zeroAddress,
    DNSSECImpl: zeroAddress,
    LegacyETHRegistrarController: zeroAddress,
    LegacyPublicResolver: zeroAddress,
    WrappedEthRegistrarController: zeroAddress,
    WrappedStaticBulkRenewal: zeroAddress,
    UniversalRegistrarRenewalWithReferrer: zeroAddress,
    OffchainDNSResolver: zeroAddress,
    ExtendedDNSResolver: zeroAddress,
    OutdatedResolver: zeroAddress,
  }

  const outPath = join(__dirname, '..', 'deployments.sepolia.json')
  writeFileSync(outPath, JSON.stringify(addresses, null, 2))
  console.log(`\n=== DEPLOYMENT ADDRESSES (saved to ${outPath}) ===`)
  console.log(JSON.stringify(addresses, null, 2))

  // Verification metadata — consumed by scripts/verify-sepolia.mjs.
  // The proxy needs (impl, initData) to verify constructor args; the impl
  // takes no args. Kept in a sibling file so deployments.sepolia.json
  // stays clean for the frontend.
  const verificationPath = join(__dirname, '..', 'verification.sepolia.json')
  writeFileSync(verificationPath, JSON.stringify({
    SimplexControllerImpl: controllerImpl.address,
    SimplexControllerProxy: controllerProxy.address,
    proxyInitData: initData,
    coldOwner: ownerAddress,
    deployer: account.address,
  }, null, 2))
  console.log(`Verification metadata saved to ${verificationPath}`)
  console.log(`Run: ETHERSCAN_API_KEY=... node scripts/verify-sepolia.mjs`)
  console.log(`\nNEXT_PUBLIC_SEPOLIA_DEPLOYMENT_ADDRESSES=${JSON.stringify(addresses)}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
