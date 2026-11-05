jest.mock("../../Repositories/Wallet/modules/stellar", () => ({ createStellarWallet: jest.fn() }));
jest.mock("../../Repositories/Wallet/modules/polkadot-kusama", () => ({
    createPolkadotWallet: jest.fn(),
    createKusamaWallet: jest.fn(),
}));
jest.mock("../../Repositories/Wallet/modules/sui", () => ({ generateSuiWalletFromMnemonic: jest.fn() }));
jest.mock("../../Repositories/Wallet/modules/ton", () => ({ createTonWallet: jest.fn() }));
jest.mock("../../Repositories/Wallet/modules/aptos", () => ({ createAptosWallet: jest.fn() }));
jest.mock("../../Repositories/Wallet/modules/solana", () => ({ createSolanaWallet: jest.fn() }));

const { errorHandler } = require("../../Core/http-handler");
const {
    CODE,
    MESSAGE,
    STATUS,
    assertDomainAcceptsNewUse,
    deprecatedUseError,
    isDeprecatedChain,
    isDeprecatedDomain,
    isDeprecatedPaymentNetwork,
    rejectDeprecatedRequest,
} = require("../../Core/deprecated-networks");
const { activateChain } = require("../../Repositories/ZelfID/modules/zelf-id-chain-activation.module");
const { applyAvailableNameOffer, assertDomainOfferedForNewNames } = require("../../Repositories/ZelfID/modules/zelf-id-plan.module");
const { Domain, filterOfferedDomains } = require("../../Repositories/Tags/modules/domain.class");
const { WATCHED_NETWORKS, isSupportedNetwork, isWatchedNetwork } = require("../../Repositories/TxNotifications/modules/networks");
const Social = require("../../Repositories/SocialCampaigns/modules/social-campaigns.module");
const { verifySmartContractPayment } = require("../../Repositories/Tags/modules/tag-smart-contract-payment.module");
const { paymentConfirmationValidation } = require("../../Repositories/Tags/middlewares/my-tags.middleware");

const priced = (name) =>
    new Domain({
        name,
        status: "active",
        tags: { payment: { planPricing: { premium: { "6-15": { 1: 12 } } } } },
    });

describe("BDAG deprecation contract", () => {
    test("410 BDAG_DEPRECATED with the holder message", () => {
        const handled = errorHandler(deprecatedUseError({ chain: "blockdag" }));
        expect(handled).toEqual({ status: STATUS, code: CODE, message: MESSAGE });
        expect(CODE).toBe("BDAG_DEPRECATED");
        expect(STATUS).toBe(410);
    });

    test("domain, chain, and payment aliases", () => {
        expect(isDeprecatedDomain("bdag")).toBe(true);
        expect(isDeprecatedDomain(".bdag")).toBe(true);
        expect(isDeprecatedDomain("alice.bdag")).toBe(true);
        expect(isDeprecatedDomain("alice.bdag.hold")).toBe(true);
        expect(isDeprecatedDomain("zelf")).toBe(false);
        expect(isDeprecatedChain("blockdag")).toBe(true);
        expect(isDeprecatedChain("BDAG")).toBe(true);
        expect(isDeprecatedChain("ethereum")).toBe(false);
        expect(isDeprecatedPaymentNetwork("bdag")).toBe(true);
        expect(isDeprecatedPaymentNetwork("BLOCKDAG_SC")).toBe(true);
        expect(isDeprecatedPaymentNetwork("ETH")).toBe(false);
    });

    test("middleware answers 410 before a generic validation error", async () => {
        const ctx = { request: { body: { tagName: "alice", domain: "zelf", network: "BDAG", token: "x" } } };
        let continued = false;
        await paymentConfirmationValidation(ctx, async () => {
            continued = true;
        });
        expect(continued).toBe(false);
        expect(ctx.status).toBe(410);
        expect(ctx.body).toEqual({ code: "BDAG_DEPRECATED", message: MESSAGE });
    });

    test("a .bdag renewal quote is rejected and a zelf quote is not", () => {
        const bdag = { request: { body: { tagName: "alice.bdag", network: "ETH" } }, status: 200 };
        expect(rejectDeprecatedRequest(bdag, bdag.request.body)).toBe(true);
        expect(bdag.status).toBe(410);
        const zelf = { request: { body: { tagName: "alice", domain: "zelf", network: "ETH" } } };
        expect(rejectDeprecatedRequest(zelf, zelf.request.body)).toBe(false);
    });
});

describe("BDAG chain activation", () => {
    test("activate refuses blockdag and its alias", async () => {
        await expect(activateChain({ tagName: "alice", domain: "zelf" }, "blockdag")).rejects.toMatchObject({
            clientCode: "BDAG_DEPRECATED",
            status: 410,
            details: { chain: "blockdag" },
        });
        await expect(activateChain({ tagName: "alice", domain: "zelf" }, "bdag")).rejects.toMatchObject({
            clientCode: "BDAG_DEPRECATED",
        });
    });
});

describe("BDAG names", () => {
    test("new leases and available-name offers are closed; an occupied name still resolves", () => {
        expect(() => assertDomainOfferedForNewNames(priced("bdag"))).toThrow(/410:BDAG_DEPRECATED/);
        expect(() => assertDomainAcceptsNewUse("zelf")).not.toThrow();
        expect(() => applyAvailableNameOffer({ available: true }, { tagName: "newname", domainConfig: priced("bdag"), duration: "1" })).toThrow(
            /410:BDAG_DEPRECATED/
        );

        const occupied = { available: false, tagObject: { publicData: { tagName: "alice.bdag" } } };
        expect(applyAvailableNameOffer(occupied, { tagName: "alice", domainConfig: priced("bdag") })).toBe(occupied);
    });

    test("the public domain list omits bdag even when the license still has plan prices", () => {
        const offered = filterOfferedDomains({
            zelf: priced("zelf"),
            bdag: priced("bdag"),
        });
        expect(Object.keys(offered)).toEqual(["zelf"]);
    });
});

describe("BDAG payments and campaigns", () => {
    test("ZelfBlockDagPay confirmation is refused for the network and for a .bdag name", async () => {
        await expect(verifySmartContractPayment("alice", "zelf", "token", "0xabc", "BLOCKDAG_SC")).rejects.toMatchObject({
            clientCode: "BDAG_DEPRECATED",
            details: { network: "BLOCKDAG_SC" },
        });
        await expect(verifySmartContractPayment("alice", "bdag", "token", "0xabc", "ETH_SC")).rejects.toMatchObject({
            clientCode: "BDAG_DEPRECATED",
            details: { domain: "bdag" },
        });
    });

    test("new social-campaign claims are closed", async () => {
        await expect(Social.getReward("alice", "bdag", {})).rejects.toMatchObject({ clientCode: "BDAG_DEPRECATED" });
        await expect(Social.provideEmail("a@example.com", "alice", "bdag", {})).rejects.toMatchObject({ clientCode: "BDAG_DEPRECATED" });
    });
});

describe("BDAG watcher and balances", () => {
    test("blockdag stays a known network and is not watched", () => {
        expect(isSupportedNetwork("blockdag")).toBe(true);
        expect(isWatchedNetwork("blockdag")).toBe(false);
        expect(WATCHED_NETWORKS).not.toContain("blockdag");
        expect(WATCHED_NETWORKS).toContain("ethereum");
    });

    test("a hung BDAG node becomes an empty slot and does not fail the other balances", async () => {
        const blockdag = require("../../Repositories/BlockDAG/modules/blockdag.module");
        const etherscan = require("../../Repositories/etherscan/modules/etherscan.module");
        const avalanche = require("../../Repositories/Avalanche/modules/avalanche-scrapping.module");
        const { getTagWalletBalances } = require("../../Repositories/Tags/modules/tag-wallet-balances.module");

        const balance = jest.spyOn(blockdag, "fetchBdagBalance").mockImplementation(() => new Promise(() => {}));
        const eth = jest.spyOn(etherscan, "getBalance").mockResolvedValue({ balance: "1000000000000000000" });
        const avax = jest.spyOn(avalanche, "getBalance").mockResolvedValue({ balance: "2" });

        try {
            const result = await getTagWalletBalances(
                { ethAddress: "0x787389C8ec43D94362648310316F4348A4dE8C83" },
                { bdagTimeoutMs: 30 }
            );
            expect(result.eth.value).toBe("1");
            expect(result.avax.value).toBe("2");
            expect(result.bdag).toMatchObject({ unit: "BDAG", value: null, error: "network_timeout" });
        } finally {
            balance.mockRestore();
            eth.mockRestore();
            avax.mockRestore();
        }
    });
});
