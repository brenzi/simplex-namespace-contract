
`node scripts/deploy-testnet.mjs`

```
Deploying SNRC for .testing TLD to Sepolia (chainId 11155111)...
Deployer: 0x7b28Ab00D172647a85B16dAe26485FA0d570FD4f
Balance: 959233482400761669 wei
Chainlink ETH/USD feed: 0x694AA1769357215DE4FAC081bf1f309aDC325306

ENSRegistry: 0x2f97af21ca3eb3f5311f439c05234ca94163bc33
BaseRegistrarImplementation: 0x5e24a4c91d81468534c8b9ad5651281374d09ad2
ReverseRegistrar: 0x06d97573643e6c6274ba5487826a0e37179cd194
DefaultReverseRegistrar: 0xe6f18059f38202e23f765ac9a8dd3511b6bdb0c6
NameWrapper: 0xe845701ad6c1103b63ce6c4e04c235c5866e80e5
ExponentialPremiumPriceOracle: 0x36572152712e77e53fe5868bcb42c0c98d46a430
MockSMPXNFT: 0x05bfadc7d78d01bc6d31cd4ce0a8c76a68b0106f
Minted NFT #0 to 0xC14ccEc78342e3DAf136E6C36025b397C377614e
SimplexControllerImpl: 0xb683dd6826463206157d3f4a8fa915a4aceaf74d
SimplexControllerProxy: 0x8b35dfd584b865b5f81a8455edb6a25caa56cfe2
Controller wired up
Reserved: simplex.testing
Reserved: simplex-chat.testing
PublicResolver: 0xb35a2f76379437638426acb4d9a45546acbf4f5c
DummyGatewayProvider: 0xa1c34fee48dd7097277e01381f1a5db30a47c58c
UniversalResolver: 0xec05f7e56284179977b7483fa1b3fc3dd93e87bc
.testing node transferred to BaseRegistrar
eth-usd.data.eth -> Chainlink feed

=== Handing off ownership to 0xC14ccEc78342e3DAf136E6C36025b397C377614e ===
  BaseRegistrar owner -> cold
  NameWrapper owner -> cold
  MockSMPXNFT owner -> cold
  ReverseRegistrar owner -> cold
  DefaultReverseRegistrar owner -> cold
  ENS subnodes (reverse, eth-usd.data.eth, data.eth, eth) -> cold
 ENS root -> cold

  SimplexController pendingOwner -> 0xC14ccEc78342e3DAf136E6C36025b397C377614e
  To complete the handover, the cold owner must submit:
      controller.acceptOwnership()  at 0x8b35dfd584b865b5f81a8455edb6a25caa56cfe2
  Until then the deployer EOA (0x7b28Ab00D172647a85B16dAe26485FA0d570FD4f) still has
  SimplexController admin rights (and nothing else).

=== DEPLOYMENT ADDRESSES (saved to /home/brenzi/claude-sandbox/simplex-namespace-contract/deployments.sepolia.json) ===
{
  "ENSRegistry": "0x2f97af21ca3eb3f5311f439c05234ca94163bc33",
  "BaseRegistrarImplementation": "0x5e24a4c91d81468534c8b9ad5651281374d09ad2",
  "ReverseRegistrar": "0x06d97573643e6c6274ba5487826a0e37179cd194",
  "DefaultReverseRegistrar": "0xe6f18059f38202e23f765ac9a8dd3511b6bdb0c6",
  "NameWrapper": "0xe845701ad6c1103b63ce6c4e04c235c5866e80e5",
  "PublicResolver": "0xb35a2f76379437638426acb4d9a45546acbf4f5c",
  "ETHRegistrarController": "0x8b35dfd584b865b5f81a8455edb6a25caa56cfe2",
  "ExponentialPremiumPriceOracle": "0x36572152712e77e53fe5868bcb42c0c98d46a430",
  "DummyOracle": "0x694AA1769357215DE4FAC081bf1f309aDC325306",
  "MockSMPXNFT": "0x05bfadc7d78d01bc6d31cd4ce0a8c76a68b0106f",
  "NameWrapperPublicResolver": "0xb35a2f76379437638426acb4d9a45546acbf4f5c",
  "UniversalResolver": "0xec05f7e56284179977b7483fa1b3fc3dd93e87bc",
  "Multicall": "0xcA11bde05977b3631167028862bE2a173976CA11",
  "DNSRegistrar": "0x0000000000000000000000000000000000000000",
  "DNSSECImpl": "0x0000000000000000000000000000000000000000",
  "LegacyETHRegistrarController": "0x0000000000000000000000000000000000000000",
  "LegacyPublicResolver": "0x0000000000000000000000000000000000000000",
  "WrappedEthRegistrarController": "0x0000000000000000000000000000000000000000",
  "WrappedStaticBulkRenewal": "0x0000000000000000000000000000000000000000",
  "UniversalRegistrarRenewalWithReferrer": "0x0000000000000000000000000000000000000000",
  "OffchainDNSResolver": "0x0000000000000000000000000000000000000000",
  "ExtendedDNSResolver": "0x0000000000000000000000000000000000000000",
  "OutdatedResolver": "0x0000000000000000000000000000000000000000"
}
Verification metadata saved to /home/brenzi/claude-sandbox/simplex-namespace-contract/verification.sepolia.json
Run: ETHERSCAN_API_KEY=... node scripts/verify-sepolia.mjs

NEXT_PUBLIC_SEPOLIA_DEPLOYMENT_ADDRESSES={"ENSRegistry":"0x2f97af21ca3eb3f5311f439c05234ca94163bc33","BaseRegistrarImplementation":"0x5e24a4c91d81468534c8b9ad5651281374d09ad2","ReverseRegistrar":"0x06d97573643e6c6274ba5487826a0e37179cd194","DefaultReverseRegistrar":"0xe6f18059f38202e23f765ac9a8dd3511b6bdb0c6","NameWrapper":"0xe845701ad6c1103b63ce6c4e04c235c5866e80e5","PublicResolver":"0xb35a2f76379437638426acb4d9a45546acbf4f5c","ETHRegistrarController":"0x8b35dfd584b865b5f81a8455edb6a25caa56cfe2","ExponentialPremiumPriceOracle":"0x36572152712e77e53fe5868bcb42c0c98d46a430","DummyOracle":"0x694AA1769357215DE4FAC081bf1f309aDC325306","MockSMPXNFT":"0x05bfadc7d78d01bc6d31cd4ce0a8c76a68b0106f","NameWrapperPublicResolver":"0xb35a2f76379437638426acb4d9a45546acbf4f5c","UniversalResolver":"0xec05f7e56284179977b7483fa1b3fc3dd93e87bc","Multicall":"0xcA11bde05977b3631167028862bE2a173976CA11","DNSRegistrar":"0x0000000000000000000000000000000000000000","DNSSECImpl":"0x0000000000000000000000000000000000000000","LegacyETHRegistrarController":"0x0000000000000000000000000000000000000000","LegacyPublicResolver":"0x0000000000000000000000000000000000000000","WrappedEthRegistrarController":"0x0000000000000000000000000000000000000000","WrappedStaticBulkRenewal":"0x0000000000000000000000000000000000000000","UniversalRegistrarRenewalWithReferrer":"0x0000000000000000000000000000000000000000","OffchainDNSResolver":"0x0000000000000000000000000000000000000000","ExtendedDNSResolver":"0x0000000000000000000000000000000000000000","OutdatedResolver":"0x0000000000000000000000000000000000000000"}
```
then, verify code on etherscan to get nicer UX:

```
> node scripts/verify-sepolia.mjs

--- SimplexController (implementation) ---
  address: 0xb683dd6826463206157d3f4a8fa915a4aceaf74d
  compiler: v0.8.26+commit.8a97fa7a
  source:   project/contracts/simplex/SimplexController.sol:SimplexController
  submitted, guid=ggjjb2xkdmjd87l2quv8f81aqeutdhvqvm1vst5rzrg6tfaap4

  OK: Pass - Verified

--- SimplexControllerProxy (ERC1967) ---
  address: 0x8b35dfd584b865b5f81a8455edb6a25caa56cfe2
  compiler: v0.8.26+commit.8a97fa7a
  source:   project/contracts/simplex/SimplexControllerProxy.sol:SimplexControllerProxy
  submitted, guid=askrc8f9tx848vgwim6q9vp69psvha5k5975w4atgjzzivikqp

  OK: Pass - Verified

All contracts verified.
```

Now, call the proxy contract with "accept ownership":

https://sepolia.etherscan.io/address/0x8b35dfd584b865b5F81A8455eDb6a25cAA56CfE2#writeProxyContract

[done tx](https://sepolia.etherscan.io/tx/0x7938dd08cd78150fda1b0718b94d9029766eb669c51e1c79d422796b3c3941b0)


