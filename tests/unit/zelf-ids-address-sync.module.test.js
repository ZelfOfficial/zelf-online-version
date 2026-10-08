const {
    buildAddressSourceFromSync,
    partitionSyncAddresses,
    addressFieldsChanged,
} = require("../../Repositories/ZelfID/modules/zelf-ids-address-sync.module");

const VALID_TON_A = "EQDSMp6iTSQkQYqi9TfHLyYa-EwGdD1MH-4AQliWeII0V_8K";
const VALID_TON_B = "EQBHyu-oZVDHRYQ1-rKlGqpHy5yAqanPBirEQNMNOmfHLotW";

describe("zelf-ids-address-sync.module", () => {
    test("buildAddressSourceFromSync overwrites an existing TON address", () => {
        const publicData = { tonAddress: VALID_TON_A, btcAddress: "bc1old" };
        const { accepted } = partitionSyncAddresses({ tonAddress: VALID_TON_B });
        const merged = buildAddressSourceFromSync(publicData, accepted);
        expect(merged.tonAddress).toBe(VALID_TON_B);
    });

    test("addressFieldsChanged detects TON updates", () => {
        const before = { tonAddress: VALID_TON_A };
        const { accepted } = partitionSyncAddresses({ tonAddress: VALID_TON_B });
        const after = buildAddressSourceFromSync(before, accepted);
        expect(addressFieldsChanged(before, after)).toBe(true);
    });
});
