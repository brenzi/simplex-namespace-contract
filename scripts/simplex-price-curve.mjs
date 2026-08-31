/**
 * The `.simplex` price curve, in the shape `SimplexPriceOracle.setPrices` takes
 * it: a base price per year for every length above the tallest rung, plus rungs
 * `(maxLength, priceUSDPerYear)` where a rung covers every length up to
 * `maxLength`. $10 a year at six characters and above, ten times more for each
 * character lost.
 *
 * One source of truth for deploy-local, deploy-testnet and deploy-mainnet, so
 * the three cannot drift apart.
 *
 * Mind the unit. These are attoUSD per YEAR. The vendored
 * `ExponentialPremiumPriceOracle` that `.testing` runs takes attoUSD per SECOND,
 * so the two lists are not interchangeable: pasting one into the other is off by
 * a factor of 31,536,000 and neither contract rejects it.
 */
const USD = 10n ** 18n

/** Every length above the tallest rung, so six characters and up: $10 / yr. */
export const SIMPLEX_PRICE_BASE = 10n * USD

export const SIMPLEX_PRICE_RUNGS = [
  { maxLength: 1n, priceUSDPerYear: 1000000n * USD }, //    $1,000,000 / yr
  { maxLength: 2n, priceUSDPerYear: 100000n * USD }, //       $100,000 / yr
  { maxLength: 3n, priceUSDPerYear: 10000n * USD }, //         $10,000 / yr
  { maxLength: 4n, priceUSDPerYear: 1000n * USD }, //           $1,000 / yr
  { maxLength: 5n, priceUSDPerYear: 100n * USD }, //              $100 / yr
]

/** ENS's mainnet Dutch auction: $100,000,000 decaying to nothing over 21 days. */
export const SIMPLEX_START_PREMIUM = 100000000n * USD
export const SIMPLEX_TOTAL_DAYS = 21n

/**
 * Chainlink's ETH/USD feeds report 8 decimals, and `DummyOracle` mimics them.
 * `SimplexPriceOracle` cannot read this from the feed (the interface has no
 * `decimals()`), so it has to be told.
 */
export const USD_FEED_DECIMALS = 8

/** Where the artifact lives, relative to `artifacts/contracts`. */
export const SIMPLEX_PRICE_ORACLE_ARTIFACT =
  'simplex/SimplexPriceOracle.sol/SimplexPriceOracle.json'
