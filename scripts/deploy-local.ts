/**
 * Deploy SNRC contracts to a local Hardhat node.
 * Run from ens-contracts/:  npx hardhat run ../scripts/deploy-local.ts
 *
 * Outputs NEXT_PUBLIC_DEPLOYMENT_ADDRESSES JSON for the frontend.
 */
import hre from 'hardhat'
import { labelhash, namehash, zeroHash, zeroAddress } from 'viem'

async function main() {
  const connection = await hre.network.connect()
  const [deployer] = await connection.viem.getWalletClients()
  const account = deployer.account

  const tld = process.env.SIMPLEX_TLD || 'testing'
  const tldNode = namehash(tld)
  const nftGateEnabled = tld === 'testing'

  console.log(`Deploying SNRC for .${tld} TLD...`)
  console.log(`Deployer: ${account.address}`)

  // 1. ENSRegistry
  const ensRegistry = await connection.viem.deployContract('ENSRegistry', [])
  console.log(`ENSRegistry: ${ensRegistry.address}`)

  // 2. BaseRegistrarImplementation
  const baseRegistrar = await connection.viem.deployContract(
    'BaseRegistrarImplementation',
    [ensRegistry.address, tldNode],
  )
  console.log(`BaseRegistrarImplementation: ${baseRegistrar.address}`)

  // 3. ReverseRegistrar
  const reverseRegistrar = await connection.viem.deployContract(
    'ReverseRegistrar',
    [ensRegistry.address],
  )
  console.log(`ReverseRegistrar: ${reverseRegistrar.address}`)

  // 4. DefaultReverseRegistrar
  const defaultReverseRegistrar = await connection.viem.deployContract(
    'DefaultReverseRegistrar',
    [],
  )
  console.log(`DefaultReverseRegistrar: ${defaultReverseRegistrar.address}`)

  // 5. Set up reverse namespace
  await ensRegistry.write.setSubnodeOwner([
    zeroHash,
    labelhash('reverse'),
    account.address,
  ])
  await ensRegistry.write.setSubnodeOwner([
    namehash('reverse'),
    labelhash('addr'),
    reverseRegistrar.address,
  ])

  // 6. Set TLD owner to deployer first (we need to set resolver before handing to BaseRegistrar)
  await ensRegistry.write.setSubnodeOwner([
    zeroHash,
    labelhash(tld),
    account.address,
  ])

  // 7. NameWrapper
  const nameWrapper = await connection.viem.deployContract('NameWrapper', [
    ensRegistry.address,
    baseRegistrar.address,
    account.address, // metadataService (deployer as placeholder)
  ])
  console.log(`NameWrapper: ${nameWrapper.address}`)

  // 8. PublicResolver
  const publicResolver = await connection.viem.deployContract('PublicResolver', [
    ensRegistry.address,
    nameWrapper.address,
    zeroAddress, // controller (set later)
    reverseRegistrar.address,
  ])
  console.log(`PublicResolver: ${publicResolver.address}`)

  // 9. Set resolver for reverse
  await reverseRegistrar.write.setDefaultResolver([publicResolver.address])

  // 10. Price oracle
  const dummyOracle = await connection.viem.deployContract('DummyOracle', [
    100000000n, // $1 = 1e8 (Chainlink format)
  ])
  const priceOracle = await connection.viem.deployContract(
    'ExponentialPremiumPriceOracle',
    [
      dummyOracle.address,
      [0n, 0n, 4056075240196n, 1014018810049n, 31688087814n],
      100000000000000000000000000n, // startPremium
      21n, // totalDays
    ],
  )
  console.log(`PriceOracle: ${priceOracle.address}`)

  // 11. MockSMPXNFT (for NFT gate testing)
  const mockNft = await connection.viem.deployContract('MockSMPXNFT', [])
  console.log(`MockSMPXNFT: ${mockNft.address}`)

  // Mint NFTs to deployer for testing
  await mockNft.write.mint([account.address])
  console.log(`Minted NFT #0 to deployer`)

  // 12. SimplexController
  const controller = await connection.viem.deployContract('SimplexController', [
    baseRegistrar.address,
    priceOracle.address,
    60n,  // minCommitmentAge (60s)
    86400n, // maxCommitmentAge (1 day)
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
  ])
  console.log(`SimplexController: ${controller.address}`)

  // 13. Wire up controller
  await baseRegistrar.write.addController([controller.address])
  await reverseRegistrar.write.setController([controller.address, true])
  await defaultReverseRegistrar.write.setController([controller.address, true])
  console.log(`Controller wired up`)

  // 14. Set resolver for TLD (while deployer still owns the node)
  await ensRegistry.write.setResolver([tldNode, publicResolver.address])

  // 15. Transfer TLD ownership to BaseRegistrar
  await ensRegistry.write.setOwner([tldNode, baseRegistrar.address])
  console.log(`.${tld} node owner transferred to BaseRegistrar`)

  // Output deployment addresses in the format the frontend expects
  // SimplexController maps to ETHRegistrarController key (same interface)
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
    // Keys expected by frontend but not deployed — use zero address
    UniversalResolver: zeroAddress,
    Multicall: zeroAddress,
    DNSRegistrar: zeroAddress,
    DNSSECImpl: zeroAddress,
    LegacyETHRegistrarController: zeroAddress,
    LegacyPublicResolver: zeroAddress,
    WrappedEthRegistrarController: zeroAddress,
    NameWrapperPublicResolver: publicResolver.address,
    WrappedStaticBulkRenewal: zeroAddress,
    UniversalRegistrarRenewalWithReferrer: zeroAddress,
    OffchainDNSResolver: zeroAddress,
    ExtendedDNSResolver: zeroAddress,
    OutdatedResolver: zeroAddress,
  }

  console.log('\n=== DEPLOYMENT ADDRESSES ===')
  console.log(JSON.stringify(addresses, null, 2))
  console.log('\n=== NEXT_PUBLIC_DEPLOYMENT_ADDRESSES ===')
  console.log(`NEXT_PUBLIC_DEPLOYMENT_ADDRESSES='${JSON.stringify(addresses)}'`)
  console.log(`\nDone! .${tld} deployment complete.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
