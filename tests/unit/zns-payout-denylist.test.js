/**
 * ZNS payout denylist. Blocked receivers must fail with 403:PAYOUT_ADDRESS_BLOCKED
 * before any Solana connection or transfer. An empty list leaves the transfer path unchanged.
 */
const solanaWeb3Actual = jest.requireActual("@solana/web3.js");

jest.mock("../../Core/config", () => {
    const web3 = jest.requireActual("@solana/web3.js");
    const sender = web3.Keypair.generate();

    return {
        solana: {
            useKit: false,
            rpcUrl: "http://127.0.0.1:9",
            sender: JSON.stringify(Array.from(sender.secretKey)),
            tokenMintAddress: web3.Keypair.generate().publicKey.toBase58(),
            devModeTokens: false,
        },
    };
});

jest.mock("../../Core/solana-tx", () => ({
    sendWithRetry: jest.fn(async () => "sig-should-not-send"),
}));

jest.mock("@solana/web3.js", () => {
    const actual = jest.requireActual("@solana/web3.js");

    return {
        ...actual,
        Connection: jest.fn(() => ({
            getSlot: jest.fn(async () => 1),
            getAccountInfo: jest.fn(async () => {
                throw new Error("rpc-past-denylist");
            }),
        })),
    };
});

const { sendWithRetry } = require("../../Core/solana-tx");
const solanaWeb3 = require("@solana/web3.js");
const {
    parsePayoutDenylist,
    isPayoutAddressBlocked,
    assertPayoutAddressAllowed,
} = require("../../Repositories/ZelfNameService/modules/zns-payout-denylist");
const ZNSTokenModule = require("../../Repositories/ZelfNameService/modules/zns-token.module");
const ZNSTokenKitModule = require("../../Repositories/ZelfNameService/modules/zns-token.module.kit");

const MIXED = "SoLanaAddress111";
const OTHER = "OtherWallet222";

const withDenylist = async (value, run) => {
    const previous = process.env.ZNS_PAYOUT_DENYLIST;

    if (value === undefined) delete process.env.ZNS_PAYOUT_DENYLIST;
    else process.env.ZNS_PAYOUT_DENYLIST = value;

    try {
        return await run();
    } finally {
        if (previous === undefined) delete process.env.ZNS_PAYOUT_DENYLIST;
        else process.env.ZNS_PAYOUT_DENYLIST = previous;
    }
};

beforeEach(() => {
    solanaWeb3.Connection.mockClear();
    sendWithRetry.mockClear();
});

describe("ZNS_PAYOUT_DENYLIST parsing", () => {
    test("trims entries and drops empty segments", () => {
        expect(parsePayoutDenylist("  WalletA , WalletB ,,  ")).toEqual(["WalletA", "WalletB"]);
        expect(parsePayoutDenylist("")).toEqual([]);
        expect(parsePayoutDenylist(undefined)).toEqual([]);
        expect(parsePayoutDenylist(" , , ")).toEqual([]);
    });

    test("matches exactly after trim and keeps Solana case", () => {
        const env = { ZNS_PAYOUT_DENYLIST: ` ${MIXED} , ${OTHER} ` };

        expect(isPayoutAddressBlocked(MIXED, env)).toBe(true);
        expect(isPayoutAddressBlocked(`  ${MIXED}  `, env)).toBe(true);
        expect(isPayoutAddressBlocked(OTHER, env)).toBe(true);
        expect(isPayoutAddressBlocked(MIXED.toLowerCase(), env)).toBe(false);
        expect(isPayoutAddressBlocked(`${MIXED}x`, env)).toBe(false);
        expect(isPayoutAddressBlocked("", env)).toBe(false);
        expect(isPayoutAddressBlocked(null, env)).toBe(false);
    });

    test("an empty denylist blocks nothing", () => {
        expect(isPayoutAddressBlocked(MIXED, {})).toBe(false);
        expect(isPayoutAddressBlocked(MIXED, { ZNS_PAYOUT_DENYLIST: "" })).toBe(false);
        expect(isPayoutAddressBlocked(MIXED, { ZNS_PAYOUT_DENYLIST: "   " })).toBe(false);
        expect(isPayoutAddressBlocked(MIXED, { ZNS_PAYOUT_DENYLIST: ",," })).toBe(false);
    });

    test("assert throws 403:PAYOUT_ADDRESS_BLOCKED and otherwise returns", () => {
        const env = { ZNS_PAYOUT_DENYLIST: MIXED };

        expect(() => assertPayoutAddressAllowed(OTHER, env)).not.toThrow();
        expect(() => assertPayoutAddressAllowed(MIXED.toLowerCase(), env)).not.toThrow();

        try {
            assertPayoutAddressAllowed(` ${MIXED} `, env);
            throw new Error("expected the denylist to reject the address");
        } catch (error) {
            expect(error.message).toBe("403:PAYOUT_ADDRESS_BLOCKED");
            expect(error.status).toBe(403);
            expect(error.code).toBe("PAYOUT_ADDRESS_BLOCKED");
            expect(error.clientCode).toBe("PAYOUT_ADDRESS_BLOCKED");
        }
    });
});

describe("giveTokensAfterPurchase", () => {
    test.each([
        ["default module", ZNSTokenModule],
        ["kit module", ZNSTokenKitModule],
    ])("%s rejects a listed address before any transfer", async (_label, tokenModule) => {
        await withDenylist(` ${MIXED} , ${OTHER} `, async () => {
            const connectionsBefore = solanaWeb3.Connection.mock.calls.length;

            await expect(tokenModule.giveTokensAfterPurchase(10, MIXED)).rejects.toMatchObject({
                message: "403:PAYOUT_ADDRESS_BLOCKED",
                status: 403,
                code: "PAYOUT_ADDRESS_BLOCKED",
            });

            expect(solanaWeb3.Connection.mock.calls.length).toBe(connectionsBefore);
            expect(sendWithRetry).not.toHaveBeenCalled();
        });
    });

    test.each([
        ["default module", ZNSTokenModule],
        ["kit module", ZNSTokenKitModule],
    ])("%s still enters the transfer path when the denylist is empty", async (_label, tokenModule) => {
        await withDenylist(undefined, async () => {
            const connectionsBefore = solanaWeb3.Connection.mock.calls.length;

            await expect(tokenModule.giveTokensAfterPurchase(10, solanaWeb3Actual.Keypair.generate().publicKey.toBase58())).rejects.toThrow(
                "rpc-past-denylist"
            );

            expect(solanaWeb3.Connection.mock.calls.length).toBeGreaterThan(connectionsBefore);
            expect(sendWithRetry).not.toHaveBeenCalled();
        });
    });

    test("a different case is not treated as the same address", async () => {
        await withDenylist(MIXED.toLowerCase(), async () => {
            await expect(ZNSTokenModule.giveTokensAfterPurchase(10, MIXED)).rejects.not.toMatchObject({
                code: "PAYOUT_ADDRESS_BLOCKED",
            });
        });
    });
});
