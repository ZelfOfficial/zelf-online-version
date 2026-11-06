jest.mock("../../Repositories/Wallet/modules/stellar", () => ({ createStellarWallet: jest.fn() }));
jest.mock("../../Repositories/Wallet/modules/polkadot-kusama", () => ({
    createPolkadotWallet: jest.fn(),
    createKusamaWallet: jest.fn(),
}));
jest.mock("../../Repositories/Wallet/modules/sui", () => ({ generateSuiWalletFromMnemonic: jest.fn() }));
jest.mock("../../Repositories/Wallet/modules/ton", () => ({ createTonWallet: jest.fn() }));
jest.mock("../../Repositories/Wallet/modules/aptos", () => ({ createAptosWallet: jest.fn() }));
jest.mock("../../Repositories/Wallet/modules/solana", () => ({ createSolanaWallet: jest.fn() }));
jest.mock("../../Repositories/Tags/config/supported-domains", () => ({
    getDomainConfig: jest.fn(),
    loadDynamicDomains: jest.fn(),
}));
jest.mock("../../Repositories/Tags/modules/tags-search.module", () => ({
    searchTag: jest.fn(),
}));

const { Domain } = require("../../Repositories/Tags/modules/domain.class");
const { getDomainConfig } = require("../../Repositories/Tags/config/supported-domains");
const TagsSearchModule = require("../../Repositories/Tags/modules/tags-search.module");
const { leaseTag } = require("../../Repositories/Tags/modules/tags.module");

const bdag = new Domain({
    name: "bdag",
    status: "active",
    tags: {
        payment: { planPricing: { premium: { "6-15": { 1: 12 } } } },
        storage: { keyPrefix: "tagName" },
    },
});

describe("new .bdag leases", () => {
    beforeEach(() => {
        getDomainConfig.mockReset();
        TagsSearchModule.searchTag.mockReset();
        getDomainConfig.mockReturnValue(bdag);
    });

    test("an existing name keeps the duplicate error from v4", async () => {
        TagsSearchModule.searchTag.mockResolvedValue({ available: false, tagObject: { publicData: { tagName: "alice.bdag" } } });
        await expect(leaseTag({ tagName: "alice", domain: "bdag" }, {})).rejects.toThrow(/409:tag_already_exists/);
    });

    test("an unregistered name is refused", async () => {
        TagsSearchModule.searchTag.mockResolvedValue({ available: true });
        await expect(leaseTag({ tagName: "newname", domain: "bdag" }, {})).rejects.toMatchObject({
            clientCode: "BDAG_DEPRECATED",
            status: 410,
            details: { domain: "bdag" },
        });
    });
});
