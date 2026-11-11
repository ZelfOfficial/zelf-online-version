/**
 * Tokens that may produce a "you received" push.
 *
 * Anyone can mint a token called "USDT" and airdrop it, so a push that trusts
 * the token symbol turns into a phishing vector ("You received 5000 USDT").
 * Only these curated contracts, mints and coin types are announced; every other
 * token transfer is marked seen silently. Native coins are always allowed.
 * TON uses TonAPI's jetton `verification === "whitelist"` instead of a list.
 * Stellar credit assets need a trustline the user opened, so they are allowed.
 */

const { STATIC_POPULAR_SPL_BY_MINT, ZNS_MAINNET_MINT } = require("../../Solana/modules/solana-spl-known-metadata");

const evm = (entries) => Object.freeze(Object.fromEntries(entries.map(([address, symbol, decimals]) => [address.toLowerCase(), { symbol, decimals }])));

const EVM_TOKENS = Object.freeze({
    ethereum: evm([
        ["0xdAC17F958D2ee523a2206206994597C13D831ec7", "USDT", 6],
        ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USDC", 6],
        ["0x6B175474E89094C44Da98b954EedeAC495271d0F", "DAI", 18],
        ["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "WETH", 18],
        ["0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", "WBTC", 8],
        ["0x6c3ea9036406852006290770BEdFcAbA0e23A0e8", "PYUSD", 6],
    ]),
    polygon: evm([
        ["0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "USDT", 6],
        ["0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "USDC", 6],
        ["0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", "USDC.e", 6],
        ["0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", "DAI", 18],
        ["0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", "WETH", 18],
        ["0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", "WPOL", 18],
    ]),
    avalanche: evm([
        ["0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", "USDC", 6],
        ["0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7", "USDT", 6],
        ["0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664", "USDC.e", 6],
        ["0xc7198437980c041c805A1EDcbA50c1Ce5db95118", "USDT.e", 6],
        ["0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", "WAVAX", 18],
    ]),
    bsc: evm([
        ["0x55d398326f99059fF775485246999027B3197955", "USDT", 18],
        ["0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", "USDC", 18],
        ["0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", "BUSD", 18],
        ["0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3", "DAI", 18],
        ["0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409", "FDUSD", 18],
        ["0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", "WBNB", 18],
        ["0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", "BTCB", 18],
        ["0x2170Ed0880ac9A755fd29B2688956BD959F933F8", "ETH", 18],
    ]),
});

const SOLANA_MINTS = Object.freeze({
    ...Object.fromEntries(Object.entries(STATIC_POPULAR_SPL_BY_MINT).map(([mint, meta]) => [mint, { symbol: meta.symbol }])),
    [ZNS_MAINNET_MINT]: { symbol: "ZNS" },
    "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo": { symbol: "PYUSD" },
});

/** Aptos: legacy coin types and fungible-asset metadata addresses (64-hex long form). */
const APTOS_ASSETS = Object.freeze({
    "0x1::aptos_coin::AptosCoin": { symbol: "APT", decimals: 8, native: true },
    "0x000000000000000000000000000000000000000000000000000000000000000a": { symbol: "APT", decimals: 8, native: true },
    "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b": { symbol: "USDC", decimals: 6 },
    "0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b": { symbol: "USDt", decimals: 6 },
});

/** Sui coin types (package address in long form). */
const SUI_COINS = Object.freeze({
    "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI": { symbol: "SUI", decimals: 9, native: true },
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC": { symbol: "USDC", decimals: 6 },
});

const evmToken = (network, contract) => EVM_TOKENS[network]?.[String(contract || "").toLowerCase()] || null;
const evmTokenContracts = (network) => Object.keys(EVM_TOKENS[network] || {});
const solanaMint = (mint) => SOLANA_MINTS[mint] || null;

const longSuiType = (coinType) =>
    String(coinType || "").replace(/^0x([0-9a-fA-F]{1,64})::/, (_, hex) => `0x${hex.toLowerCase().padStart(64, "0")}::`);
const suiCoin = (coinType) => SUI_COINS[longSuiType(coinType)] || null;

const aptosAsset = (assetType) => {
    const raw = String(assetType || "");
    if (APTOS_ASSETS[raw]) return APTOS_ASSETS[raw];
    if (/^0x[0-9a-fA-F]{1,64}$/.test(raw)) return APTOS_ASSETS[`0x${raw.slice(2).toLowerCase().padStart(64, "0")}`] || null;
    return null;
};

module.exports = {
    APTOS_ASSETS,
    EVM_TOKENS,
    SOLANA_MINTS,
    SUI_COINS,
    aptosAsset,
    evmToken,
    evmTokenContracts,
    longSuiType,
    solanaMint,
    suiCoin,
};
