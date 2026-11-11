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

const ZERO_ADDRESSES = new Set([
    '0x0000000000000000000000000000000000000000',
    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
]);

const positiveNumber = (value) => {
    if (value === undefined || value === null || value === '') return false;
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0;
};

/**
 * True when the row is the native AVAX balance rather than an ERC-20.
 * A contract that merely uses the AVAX symbol stays an ERC-20.
 */
const isNativeAvaxEntry = (token) => {
    if (!token || typeof token !== 'object') return false;
    if (String(token.tokenType || '').toUpperCase() === 'AVAX') return true;
    if (String(token.symbol || '').toUpperCase() !== 'AVAX') return false;
    const address = String(token.address || '').trim().toLowerCase();
    return address === '' || ZERO_ADDRESSES.has(address);
};

const contractAddressKey = (token) => {
    const address = String(token?.address || '').trim().toLowerCase();
    return /^0x[0-9a-f]{40}$/.test(address) ? address : '';
};

const entryHasPriceOrFiat = (token) =>
    [token?._price, token?.price, token?._fiatBalance, token?.fiatBalance].some(positiveNumber);

const preferPricedEntry = (current, candidate) => {
    if (!current) return candidate;
    if (!candidate) return current;
    if (entryHasPriceOrFiat(candidate) && !entryHasPriceOrFiat(current)) return candidate;
    return current;
};

const tokenFiatAmount = (token) => {
    const primary = Number(token?.fiatBalance);
    if (Number.isFinite(primary)) return primary;
    const secondary = Number(token?._fiatBalance);
    return Number.isFinite(secondary) ? secondary : 0;
};

/**
 * Union of Routescan and Glacier holding lists.
 * ERC-20 rows collapse by lowercase contract address. The copy that carries
 * price or fiat data wins. Native AVAX is kept once. `balance` stays the
 * total fiat of the merged rows.
 */
const mergeAvalancheTokenHoldings = (first, second) => {
    const merged = [];
    const indexByAddress = new Map();
    let nativeIndex = -1;

    for (const source of [first, second]) {
        const tokens = Array.isArray(source?.tokens) ? source.tokens : [];
        for (const token of tokens) {
            if (!token || typeof token !== 'object') continue;
            if (isNativeAvaxEntry(token)) {
                if (nativeIndex < 0) {
                    nativeIndex = merged.length;
                    merged.push(token);
                } else {
                    merged[nativeIndex] = preferPricedEntry(merged[nativeIndex], token);
                }
                continue;
            }

            const key = contractAddressKey(token);
            if (!key) {
                merged.push(token);
                continue;
            }

            const existingIndex = indexByAddress.get(key);
            if (existingIndex === undefined) {
                indexByAddress.set(key, merged.length);
                merged.push(token);
            } else {
                merged[existingIndex] = preferPricedEntry(merged[existingIndex], token);
            }
        }
    }

    const balance = merged.reduce((sum, token) => sum + tokenFiatAmount(token), 0);
    return {
        balance: String(balance),
        total: merged.length,
        tokens: merged,
    };
};

module.exports = {
    isNativeAvaxEntry,
    mapRouteScanHolding,
    mapRoutescanAddressToken,
    mergeAvalancheTokenHoldings,
};
