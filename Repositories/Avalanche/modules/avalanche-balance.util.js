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

/**
 * Map a Routescan Etherscan `addresstokenbalance` row.
 * Returns null when the quantity or decimals cannot be formatted.
 */
const mapRoutescanAddressToken = (token) => {
    if (!token || typeof token !== 'object') return null;
    const quantity = String(token.TokenQuantity ?? '');
    const decimals = Number(token.TokenDivisor);
    if (!/^\d+$/.test(quantity) || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
        return null;
    }
    const amount = formatUnits(quantity, decimals);
    const priceNumber = Number(token.TokenPriceUSD ?? 0);
    const price = Number.isFinite(priceNumber) ? priceNumber : 0;
    const fiatBalance = Number(amount) * price;
    return {
        _amount: Number(amount),
        _fiatBalance: Number.isFinite(fiatBalance) ? String(fiatBalance) : '0',
        _price: price,
        address: token.TokenAddress,
        amount,
        decimals,
        fiatBalance: Number.isFinite(fiatBalance) ? fiatBalance : 0,
        image: '',
        name: token.TokenName || token.TokenSymbol || token.TokenAddress,
        price: String(token.TokenPriceUSD ?? '0'),
        symbol: token.TokenSymbol,
        tokenType: 'ERC-20',
    };
};

module.exports = { mapRouteScanHolding, mapRoutescanAddressToken };
