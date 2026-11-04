const { formatUnits } = require('ethers');

/**
 * Map a RouteScan ERC-20 holding. Returns null when required fields are missing/invalid
 * so one bad row cannot 500 the whole balance response.
 */
const mapRouteScanHolding = (token) => {
    if (!token || typeof token !== 'object') return null;
    const quantity = String(token.tokenQuantity ?? '');
    const decimals = Number(token.tokenDecimals);
    if (!/^\d+$/.test(quantity) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
        return null;
    }
    const amount = formatUnits(quantity, decimals);
    return {
        address: token.tokenAddress,
        amount,
        decimals,
        fiatBalance: Number(token.tokenValueInUsd || 0),
        price: String(token.tokenPrice || '0'),
        name: token.tokenName || token.tokenSymbol || token.tokenAddress,
        symbol: token.tokenSymbol,
        tokenType: 'ERC-20',
    };
};

module.exports = { mapRouteScanHolding };
