#!/usr/bin/env node
/**
 * Deploy SNRC contracts to a local Hardhat node.
 * Run from parent repo:  node scripts/deploy-local.mjs
 *
 * Requires: ens-contracts compiled (npx hardhat compile)
 * Outputs NEXT_PUBLIC_DEPLOYMENT_ADDRESSES JSON for the frontend.
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http, labelhash, namehash, zeroHash, zeroAddress } from 'viem'
import { localhost } from 'viem/chains'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ARTIFACTS = join(__dirname, '..', 'ens-contracts', 'artifacts', 'contracts')

function loadArtifact(path) {
  const full = join(ARTIFACTS, path)
  const json = JSON.parse(readFileSync(full, 'utf8'))
  return { abi: json.abi, bytecode: json.bytecode }
}

const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545'
const tld = process.env.SIMPLEX_TLD || 'testing'
const tldNode = namehash(tld)
const nftGateEnabled = tld === 'testing'

const transport = http(rpcUrl)
const publicClient = createPublicClient({ chain: localhost, transport })
const walletClient = createWalletClient({
  chain: localhost,
  transport,
  account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // Hardhat account #0
})
const account = walletClient.account

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
  console.log(`Deploying SNRC for .${tld} TLD...`)
  console.log(`Deployer: ${account.address}`)
  console.log(`RPC: ${rpcUrl}\n`)

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

  // Set up reverse namespace
  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash('reverse'), account.address])
  await write(ensRegistry, 'setSubnodeOwner', [namehash('reverse'), labelhash('addr'), reverseRegistrar.address])

  // Set TLD owner to deployer (need to set resolver before transferring)
  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash(tld), account.address])

  const nameWrapper = await deploy('NameWrapper',
    'wrapper/NameWrapper.sol/NameWrapper.json',
    [ensRegistry.address, baseRegistrar.address, account.address])

  const dummyOracle = await deploy('DummyOracle',
    'ethregistrar/DummyOracle.sol/DummyOracle.json',
    [100000000n])

  // .testing is free during the testing phase (gas-only). .simplex keeps the
  // production curve: $1 / $8 / $32 / $128 per year for 6+ / 5 / 4 / 3 chars.
  const priceArray = tld === 'testing'
    ? [0n, 0n, 0n, 0n, 0n]
    : [0n, 0n, 4056075240196n, 1014018810049n, 31688087814n]
  const priceOracle = await deploy('ExponentialPremiumPriceOracle',
    'ethregistrar/ExponentialPremiumPriceOracle.sol/ExponentialPremiumPriceOracle.json',
    [dummyOracle.address, priceArray, 100000000000000000000000000n, 21n])

  const mockNft = await deploy('MockSMPXNFT',
    'mocks/MockSMPXNFT.sol/MockSMPXNFT.json')

  await write(mockNft, 'mint', [account.address])
  console.log(`Minted NFT #0 to deployer`)

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

  // Use the proxy address everywhere SimplexController is referenced. ABI
  // is the implementation's; calls reach storage via the proxy.
  const controller = { address: controllerProxy.address, abi: controllerImpl.abi }

  // PublicResolver must trust the controller so it can write records during register()
  const publicResolver = await deploy('PublicResolver',
    'resolvers/PublicResolver.sol/PublicResolver.json',
    [ensRegistry.address, nameWrapper.address, controller.address, reverseRegistrar.address])

  await write(reverseRegistrar, 'setDefaultResolver', [publicResolver.address])

  // Wire up
  await write(baseRegistrar, 'addController', [controller.address])
  await write(reverseRegistrar, 'setController', [controller.address, true])
  await write(defaultReverseRegistrar, 'setController', [controller.address, true])
  console.log(`Controller wired up`)

  // Genesis reserved-names list — these labels cannot be registered by the public.
  // Extend as needed before deploying to testnet / mainnet.
  for (const label of ['simplex', 'simplex-chat']) {
    await write(controller, 'addReservedName', [label])
    console.log(`Reserved: ${label}.${tld}`)
  }

  // UniversalResolver (needed by the frontend for name lookups)
  const dummyGateway = await deploy('DummyGatewayProvider',
    'mocks/DummyGatewayProvider.sol/DummyGatewayProvider.json')

  const universalResolver = await deploy('UniversalResolver',
    'universalResolver/UniversalResolver.sol/UniversalResolver.json',
    [account.address, ensRegistry.address, dummyGateway.address])

  const multicall3 = await deploy('Multicall3',
    'mocks/Multicall3.sol/Multicall3.json')
  const multicall3Address = multicall3.address

  // Set resolver then transfer TLD to BaseRegistrar
  await write(ensRegistry, 'setResolver', [tldNode, publicResolver.address])
  await write(ensRegistry, 'setOwner', [tldNode, baseRegistrar.address])
  console.log(`.${tld} node transferred to BaseRegistrar`)

  // Frontend's useEthPrice resolves eth-usd.data.eth -> ChainLink-like oracle.
  // Register the path under root and point its addr record at DummyOracle (has latestAnswer()).
  await write(ensRegistry, 'setSubnodeOwner', [zeroHash, labelhash('eth'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('eth'), publicResolver.address])
  await write(ensRegistry, 'setSubnodeOwner', [namehash('eth'), labelhash('data'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('data.eth'), publicResolver.address])
  await write(ensRegistry, 'setSubnodeOwner', [namehash('data.eth'), labelhash('eth-usd'), account.address])
  await write(ensRegistry, 'setResolver', [namehash('eth-usd.data.eth'), publicResolver.address])
  await write(publicResolver, 'setAddr', [namehash('eth-usd.data.eth'), dummyOracle.address])
  console.log(`eth-usd.data.eth -> DummyOracle\n`)

  const addresses = {
    ENSRegistry: ensRegistry.address,
    BaseRegistrarImplementation: baseRegistrar.address,
    ReverseRegistrar: reverseRegistrar.address,
    DefaultReverseRegistrar: defaultReverseRegistrar.address,
    NameWrapper: nameWrapper.address,
    PublicResolver: publicResolver.address,
    ETHRegistrarController: controller.address,
    ExponentialPremiumPriceOracle: priceOracle.address,
    DummyOracle: dummyOracle.address,
    MockSMPXNFT: mockNft.address,
    NameWrapperPublicResolver: publicResolver.address,
    UniversalResolver: universalResolver.address,
    Multicall: multicall3Address,
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

  console.log('\n=== DEPLOYMENT ADDRESSES ===')
  console.log(JSON.stringify(addresses, null, 2))
  console.log(`\nNEXT_PUBLIC_DEPLOYMENT_ADDRESSES=${JSON.stringify(addresses)}`)

  // Persist for tests that need to reach the contracts directly.
  const { writeFileSync } = await import('fs')
  writeFileSync(join(__dirname, '..', 'deployments.local.json'), JSON.stringify(addresses, null, 2))
}

main().catch((err) => { console.error(err); process.exit(1) })
