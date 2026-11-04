const { tonAddressLookupValues } = require('../../Repositories/Tags/modules/ton-address-lookup.util');
const { mapRouteScanHolding } = require('../../Repositories/Avalanche/modules/avalanche-balance.util');
const ton = 'EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K';
test('bounceable, non-bounceable and raw TON spellings resolve the same account', () => {
    const variants = tonAddressLookupValues(ton);
    expect(variants).toHaveLength(3);
    for (const address of variants) expect(new Set(tonAddressLookupValues(address))).toEqual(new Set(variants));
    expect(() => tonAddressLookupValues(ton.replace('II', 'll'))).toThrow();
});
test('RouteScan integer quantities keep token decimals instead of inflating the balance', () => {
    expect(mapRouteScanHolding({tokenQuantity:'1234567890123456789',tokenDecimals:18,tokenSymbol:'WAVAX'}).amount).toBe('1.234567890123456789');
    expect(mapRouteScanHolding({tokenQuantity:'unknown',tokenDecimals:18})).toBeNull();
    expect(mapRouteScanHolding({tokenQuantity:'1',tokenAddress:'0xFF498d'})).toBeNull();
    expect(mapRouteScanHolding({tokenQuantity:'1000',tokenDecimals:'18',tokenSymbol:'X'}).amount).toBe('0.000000000000001');
});

test('EVM lookups try the checksum and lowercase spellings the registry may hold (#562)', () => {
    const { addressLookupValues } = require('../../Repositories/Tags/modules/ton-address-lookup.util');
    const checksum = '0xB8aB5d8c0a32410653C98adE00E0a202fdCe2117';
    const variants = addressLookupValues('ethAddress', checksum.toLowerCase());

    expect(variants).toEqual(expect.arrayContaining([checksum, checksum.toLowerCase()]));
    expect(new Set(addressLookupValues('ethAddress', checksum))).toEqual(new Set(variants));
    expect(addressLookupValues('solanaAddress', 'E5zQvcpuRdtcwZfRxBKHLgnUQRf6wCsYBf75Lix5upEG')).toEqual(['E5zQvcpuRdtcwZfRxBKHLgnUQRf6wCsYBf75Lix5upEG']);
    expect(addressLookupValues('ethAddress', 'not-an-address')).toEqual(['not-an-address']);
});
