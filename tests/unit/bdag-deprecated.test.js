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
const { CODE, MESSAGE, STATUS, assertDomainAcceptsNewUse, deprecatedUseError } = require("../../Core/deprecated-networks");
const { activateChain, chainStatus } = require("../../Repositories/ZelfID/modules/zelf-id-chain-activation.module");
const { applyAvailableNameOffer, assertDomainOfferedForNewNames } = require("../../Repositories/ZelfID/modules/zelf-id-plan.module");
const { Domain, filterOfferedDomains } = require("../../Repositories/Tags/modules/domain.class");
const { WATCHED_NETWORKS, isWatchedNetwork } = require("../../Repositories/TxNotifications/modules/networks");
const { paymentConfirmationValidation, smartContractPaymentConfirmationValidation } = require("../../Repositories/Tags/middlewares/my-tags.middleware");
const { verifyPaymentConfirmation } = require("../../Repositories/Tags/modules/my-tags.module");

const priced = (name) =>
    new Domain({
        name,
        status: "active",
        tags: {
            payment: { planPricing: { premium: { "6-15": { 1: 12 } } } },
            storage: { keyPrefix: "tagName" },
        },
    });

const holderOptions = (publicData) => ({
    plan: "free",
    domainConfig: null,
    skipTagLookup: true,
    skipSubscriptionLookup: true,
    tagPublicData: {
        plan: "free",
        type: "mainnet",
        zelfName: "alice.zelf",
        tagName: "alice",
        ethAddress: "0xabc",
        ...publicData,
    },
});

describe("BDAG new-use blocks", () => {
    test("410 BDAG_DEPRECATED keeps the holder message and chain field", () => {
        const error = deprecatedUseError({ chain: "blockdag" });
        const handled = errorHandler(error);
        expect(handled).toEqual({ status: STATUS, code: CODE, message: MESSAGE });
        expect({ message: handled.message, code: handled.code, ...error.details }).toEqual({
            code: "BDAG_DEPRECATED",
            message: MESSAGE,
            chain: "blockdag",
        });
    });

    test("a first BlockDAG activation is refused and an address already on the name is not", async () => {
        const alice = { tagName: "alice", domain: "zelf" };
        await expect(activateChain(alice, "blockdag", holderOptions({ ethAddress: "" }))).rejects.toMatchObject({
            clientCode: "BDAG_DEPRECATED",
            status: 410,
            details: { chain: "blockdag" },
        });

        const held = await activateChain(alice, "bdag", holderOptions());
        expect(held).toMatchObject({ chain: "blockdag", activated: true, alreadyActive: true });

        const status = await chainStatus(alice, holderOptions());
        const blockdag = status.chains.find((row) => row.chain === "blockdag");
        expect(blockdag).toMatchObject({ active: true, allowed: true, deprecated: true, addressPresent: true });
    });

    test("an unregistered .bdag name is not offered and is omitted from the public domain list", () => {
        expect(() => applyAvailableNameOffer({ available: true }, { tagName: "newname", domainConfig: priced("bdag"), duration: "1" })).toThrow(
            /410:BDAG_DEPRECATED/
        );
        const occupied = { available: false, tagObject: { publicData: { tagName: "alice.bdag" } } };
        expect(applyAvailableNameOffer(occupied, { tagName: "alice", domainConfig: priced("bdag") })).toBe(occupied);

        const offered = filterOfferedDomains({ zelf: priced("zelf"), bdag: priced("bdag") });
        expect(Object.keys(offered)).toEqual(["zelf"]);
    });
});

describe("existing BDAG use stays on v4 behaviour", () => {
    test("a priced bdag license still passes the plan gate; the new-name guard is separate", () => {
        expect(() => assertDomainOfferedForNewNames(priced("bdag"))).not.toThrow();
        expect(() => assertDomainAcceptsNewUse("bdag")).toThrow(/410:BDAG_DEPRECATED/);
        expect(() => assertDomainAcceptsNewUse("zelf")).not.toThrow();
    });

    test("BDAG and BLOCKDAG_SC remain payable", async () => {
        const native = {
            request: { body: { tagName: "alice", domain: "zelf", network: "BDAG", token: "not-a-jwt" } },
            status: 200,
            body: null,
        };
        await paymentConfirmationValidation(native, async () => {
            throw new Error("should not confirm");
        });
        expect(native.status).toBe(409);
        expect(native.body.code).not.toBe("BDAG_DEPRECATED");
        expect(String(native.body.validationError)).not.toMatch(/must be one of/i);

        const contract = {
            request: {
                body: {
                    tagName: "alice",
                    domain: "zelf",
                    network: "BLOCKDAG_SC",
                    token: "not-a-jwt",
                    txHash: `0x${"ab".repeat(32)}`,
                },
            },
            status: 200,
            body: null,
        };
        await smartContractPaymentConfirmationValidation(contract, async () => {
            throw new Error("should not confirm");
        });
        expect(contract.status).toBe(409);
        expect(contract.body.code).not.toBe("BDAG_DEPRECATED");
        expect(String(contract.body.validationError)).not.toMatch(/must be one of/i);
    });

    test("a .bdag renewal confirmation is not closed before the payment token is checked", async () => {
        try {
            await verifyPaymentConfirmation("alice", "bdag", "BDAG", "not-a-jwt");
            throw new Error("expected the token check to fail");
        } catch (error) {
            expect(error.clientCode).not.toBe("BDAG_DEPRECATED");
            expect(String(error.message)).not.toContain("BDAG_DEPRECATED");
        }
    });

    test("the tx watcher still watches blockdag", () => {
        expect(isWatchedNetwork("blockdag")).toBe(true);
        expect(WATCHED_NETWORKS).toContain("blockdag");
    });
});
