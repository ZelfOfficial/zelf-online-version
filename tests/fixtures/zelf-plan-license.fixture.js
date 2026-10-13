/**
 * Test-only license fixture: production reads planPricing / name length from the IPFS license JSON.
 */
const { Domain } = require("../../Repositories/Tags/modules/domain.class");

const cells = (base) => ({ 1: base, 2: base * 2, 3: base * 3, lifetime: base * 10 });

const zelfPlanLicenseData = () => ({
    name: "zelf",
    tags: {
        minLength: 1,
        maxLength: 27,
        payment: {
            pricingTable: {},
            planPricing: {
                premium: { "6-27": cells(29) },
                unlimited: { "1-27": cells(99) },
            },
            whitelist: {},
        },
    },
});

const zelfPlanLicense = () => new Domain(zelfPlanLicenseData());

/** Point `getDomainConfig` (used when no domainConfig is passed) at the fixture license. */
const useZelfPlanLicense = () => {
    const SupportedDomains = require("../../Repositories/Tags/config/supported-domains");
    const license = zelfPlanLicense();
    return jest.spyOn(SupportedDomains, "getDomainConfig").mockImplementation(() => license);
};

module.exports = { zelfPlanLicenseData, zelfPlanLicense, useZelfPlanLicense };
