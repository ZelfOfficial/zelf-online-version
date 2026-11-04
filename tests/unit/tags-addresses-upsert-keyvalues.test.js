const {
    buildUpsertPrimarySearchableKeyvalues,
    mergeAddressKeyvaluesIntoPublicData,
} = require("../../Repositories/Tags/modules/tags-addresses.module");

describe("buildUpsertPrimarySearchableKeyvalues", () => {
    test("packs ton and aptos into addresses chunks for primary-pin upsert", () => {
        const reserved = {
            tagName: "qa99.zelf",
            hasPassword: "false",
            type: "mainnet",
            domain: "zelf",
            extraParams: JSON.stringify({ origin: "online", v: 4 }),
        };
        const addresses = {
            ethAddress: "0x0000000000000000000000000000000000000001",
            solanaAddress: "So11111111111111111111111111111111111111112",
            suiAddress: "0x0000000000000000000000000000000000000000000000000000000000000001",
            btcAddress: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh",
            tonAddress: "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K",
            aptosAddress: "0x0000000000000000000000000000000000000000000000000000000000000002",
        };

        const keyvalues = buildUpsertPrimarySearchableKeyvalues(reserved, addresses);
        const publicData = { ...keyvalues };
        mergeAddressKeyvaluesIntoPublicData(publicData);

        expect(publicData.tonAddress).toBe(addresses.tonAddress);
        expect(publicData.aptosAddress).toBe(addresses.aptosAddress);
        expect(keyvalues.addresses || keyvalues.addresses2).toBeDefined();
    });
});
