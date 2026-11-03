const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { resolveLifiApiKey } = require("../../Core/config");
const PlanLimits = require("../../Repositories/ZelfKeys/modules/zelf-key-plan-limits.module");
const Chains = require("../../Repositories/ZelfID/modules/zelf-id-chain-activation.module");
const SwapUsage = require("../../Repositories/ZelfID/models/zelf-id-swap-usage.model");
const Activation = require("../../Repositories/ZelfID/models/zelf-id-chain-activation.model");

jest.setTimeout(120000);

const alice = { tagName: "alice", domain: "zelf" };
const capped = {
    zelfkeys: {
        planLimits: {
            free: { swapsPerMonth: 1 },
            premium: { swapsPerMonth: 3, nonEvmChains: true },
        },
    },
};

const entitlement = (extra = {}) => ({
    plan: "free",
    domainConfig: capped,
    skipTagLookup: true,
    skipSubscriptionLookup: true,
    tagPublicData: { plan: "free", type: "mainnet", zelfName: "alice.zelf", tagName: "alice", ethAddress: "0xabc" },
    now: "2026-11-03T12:00:00.000Z",
    ...extra,
});

let memoryServer;

beforeAll(async () => {
    memoryServer = await MongoMemoryServer.create();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await mongoose.connect(memoryServer.getUri());
    await SwapUsage.init();
    await Activation.init();
});

afterAll(async () => {
    await mongoose.disconnect();
    if (memoryServer) await memoryServer.stop();
});

beforeEach(async () => {
    await SwapUsage.deleteMany({});
    await Activation.deleteMany({});
});

describe("license plan limit shape", () => {
    test("config defaults keep password caps and leave swaps unlimited", () => {
        expect(PlanLimits.limitsForPlan("free", null)).toEqual({
            passwords: 5,
            zotp: 3,
            swapsPerMonth: null,
            nonEvmChains: false,
        });
        expect(PlanLimits.limitsForPlan("premium", null)).toMatchObject({
            passwords: 100,
            zotp: 20,
            swapsPerMonth: null,
            nonEvmChains: true,
        });
        expect(PlanLimits.limitsForPlan("unlimited", null)).toMatchObject({
            passwords: null,
            zotp: null,
            swapsPerMonth: null,
            nonEvmChains: true,
        });
    });

    test("a license replaces only the fields it sets", () => {
        const domainConfig = {
            zelfkeys: { planLimits: { free: { swapsPerMonth: 4 }, premium: { nonEvmChains: false } } },
        };
        expect(PlanLimits.limitsForPlan("free", domainConfig)).toEqual({
            passwords: 5,
            zotp: 3,
            swapsPerMonth: 4,
            nonEvmChains: false,
        });
        expect(PlanLimits.limitsForPlan("premium", domainConfig).nonEvmChains).toBe(false);
        expect(PlanLimits.limitsForPlan("premium", domainConfig).passwords).toBe(100);
        expect(PlanLimits.limitsForPlan("premium", domainConfig).swapsPerMonth).toBeNull();
    });

    test("null in the license means an unlimited count", () => {
        const domainConfig = { zelfkeys: { planLimits: { free: { passwords: null, swapsPerMonth: null } } } };
        const limits = PlanLimits.limitsForPlan("free", domainConfig);
        expect(limits.passwords).toBeNull();
        expect(limits.swapsPerMonth).toBeNull();
        expect(limits.zotp).toBe(3);
    });

    test("upgrade lists the plans that raise each cap", () => {
        const domainConfig = { zelfkeys: { planLimits: { free: { swapsPerMonth: 2 }, premium: { swapsPerMonth: 2 } } } };
        expect(PlanLimits.upgradePlans("free", domainConfig).swaps).toEqual(["unlimited"]);
        expect(PlanLimits.upgradePlans("free", null).nonEvmChains).toEqual(["premium", "unlimited"]);
        expect(PlanLimits.upgradePlans("unlimited", null)).toEqual({
            passwords: [],
            zotp: [],
            swaps: [],
            nonEvmChains: [],
        });
    });

    test("period keys are UTC months", () => {
        expect(PlanLimits.periodKeyFromDate("2026-11-30T23:30:00-05:00")).toBe("2026-12");
        expect(PlanLimits.periodKeyFromDate("2026-12-01T00:30:00+02:00")).toBe("2026-11");
    });
});

describe("LI.FI API key", () => {
    test("accepts LIFI_KEY when LIFI_API_KEY is missing or blank", () => {
        expect(resolveLifiApiKey({ LIFI_API_KEY: "primary", LIFI_KEY: "alias" })).toBe("primary");
        expect(resolveLifiApiKey({ LIFI_API_KEY: "  ", LIFI_KEY: "alias" })).toBe("alias");
        expect(resolveLifiApiKey({ LIFI_KEY: "alias" })).toBe("alias");
        expect(resolveLifiApiKey({})).toBeUndefined();
    });
});

describe("monthly swap counter", () => {
    test("counts a successful execution and blocks the next one", async () => {
        const first = jest.fn().mockResolvedValue({ tx: "one" });
        const second = jest.fn().mockResolvedValue({ tx: "two" });

        const done = await PlanLimits.executeLimitedSwap({ authUser: alice, execute: first, ...entitlement() });
        expect(done.result).toEqual({ tx: "one" });
        expect(done.swaps).toEqual({ count: 1, limit: 1, periodKey: "2026-11", plan: "free" });
        expect(first).toHaveBeenCalledTimes(1);

        await expect(PlanLimits.executeLimitedSwap({ authUser: alice, execute: second, ...entitlement() })).rejects.toMatchObject({
            clientCode: "ERR_PLAN_LIMIT_REACHED",
            details: { kind: "swaps", count: 1, limit: 1, plan: "free", periodKey: "2026-11", tokenCost: null, extraSlots: 0 },
        });
        expect(second).not.toHaveBeenCalled();
        expect(await PlanLimits.readSwapCount("alice.zelf", "2026-11")).toBe(1);
    });

    test("a failed execution is not counted", async () => {
        const failing = jest.fn().mockRejectedValue(new Error("lifi down"));
        await expect(PlanLimits.executeLimitedSwap({ authUser: alice, execute: failing, ...entitlement() })).rejects.toThrow("lifi down");
        expect(await PlanLimits.readSwapCount("alice.zelf", "2026-11")).toBe(0);

        const retry = jest.fn().mockResolvedValue({ tx: "ok" });
        const done = await PlanLimits.executeLimitedSwap({ authUser: alice, execute: retry, ...entitlement() });
        expect(done.swaps.count).toBe(1);
        expect(retry).toHaveBeenCalledTimes(1);
    });

    test("a later UTC month starts again at zero", async () => {
        await PlanLimits.executeLimitedSwap({ authUser: alice, execute: async () => ({ tx: 1 }), ...entitlement() });
        const nextMonth = await PlanLimits.executeLimitedSwap({
            authUser: alice,
            execute: async () => ({ tx: 2 }),
            ...entitlement({ now: "2026-12-01T00:00:00.000Z" }),
        });
        expect(nextMonth.swaps).toMatchObject({ count: 1, periodKey: "2026-12" });
        expect(await PlanLimits.readSwapCount("alice.zelf", "2026-11")).toBe(1);
        expect(await PlanLimits.readSwapCount("alice.zelf", "2026-12")).toBe(1);
    });

    test("an unlimited cap still counts and does not block", async () => {
        const options = entitlement({ domainConfig: null, plan: "premium" });
        await PlanLimits.executeLimitedSwap({ authUser: alice, execute: async () => ({ tx: 1 }), ...options });
        const second = await PlanLimits.executeLimitedSwap({ authUser: alice, execute: async () => ({ tx: 2 }), ...options });
        expect(second.swaps).toMatchObject({ count: 2, limit: null, plan: "premium" });
    });

    test("a session without a Zelf name does not call LI.FI", async () => {
        const execute = jest.fn();
        await expect(
            PlanLimits.executeLimitedSwap({ authUser: { identifier: "device-only", domain: "zelf" }, execute, ...entitlement() }),
        ).rejects.toMatchObject({ clientCode: "ERR_ZELF_IDENTITY_REQUIRED" });
        expect(execute).not.toHaveBeenCalled();
        expect(await SwapUsage.countDocuments()).toBe(0);
    });

    test("parallel executions stop at the cap", async () => {
        const calls = [];
        const run = () =>
            PlanLimits.executeLimitedSwap({
                authUser: alice,
                execute: async () => {
                    calls.push(1);
                    return { tx: calls.length };
                },
                ...entitlement(),
            });
        const settled = await Promise.allSettled([run(), run(), run()]);
        const ok = settled.filter((row) => row.status === "fulfilled");
        const blocked = settled.filter((row) => row.status === "rejected");
        expect(ok).toHaveLength(1);
        expect(blocked).toHaveLength(2);
        blocked.forEach((row) => expect(row.reason.clientCode).toBe("ERR_PLAN_LIMIT_REACHED"));
        expect(calls).toHaveLength(1);
        expect(await PlanLimits.readSwapCount("alice.zelf", "2026-11")).toBe(1);
    });
});

describe("non-EVM chain activation", () => {
    const chainOptions = (extra = {}) =>
        entitlement({
            domainConfig: null,
            tagPublicData: {
                plan: "free",
                type: "mainnet",
                zelfName: "alice.zelf",
                tagName: "alice",
                ethAddress: "0xabc",
                solanaAddress: "So11111111111111111111111111111111111111112",
            },
            ...extra,
        });

    test("Free cannot activate a new non-EVM chain and can activate EVM", async () => {
        await expect(Chains.activateChain(alice, "sui", chainOptions())).rejects.toMatchObject({
            clientCode: "ERR_PLAN_LIMIT_REACHED",
            details: { kind: "nonEvmChain", chain: "sui", plan: "free", count: 0, limit: 0, tokenCost: null, extraSlots: 0 },
        });
        expect(await Activation.countDocuments()).toBe(0);

        const eth = await Chains.activateChain(alice, "ETH", chainOptions());
        expect(eth).toMatchObject({ chain: "ethereum", family: "evm", nonEvm: false, activated: true, plan: "free" });
    });

    test("an address already on the name stays active", async () => {
        const solana = await Chains.activateChain(alice, "sol", chainOptions());
        expect(solana).toMatchObject({ chain: "solana", alreadyActive: true, activated: true });
        expect(await Activation.countDocuments()).toBe(0);

        const status = await Chains.chainStatus(alice, chainOptions());
        expect(status.nonEvmChains).toBe(false);
        expect(status.upgrade).toEqual(["premium", "unlimited"]);
        const byName = Object.fromEntries(status.chains.map((row) => [row.chain, row]));
        expect(byName.solana).toMatchObject({ nonEvm: true, active: true, allowed: true, addressPresent: true });
        expect(byName.sui).toMatchObject({ nonEvm: true, active: false, allowed: false, addressPresent: false });
        expect(byName.ethereum).toMatchObject({ family: "evm", nonEvm: false, allowed: true, active: true });
    });

    test("Premium can activate Sui once and a second call is the same grant", async () => {
        const first = await Chains.activateChain(alice, "sui", chainOptions({ plan: "premium" }));
        expect(first).toMatchObject({ chain: "sui", activated: true, alreadyActive: false, plan: "premium" });
        const second = await Chains.activateChain(alice, "sui", chainOptions({ plan: "premium" }));
        expect(second.alreadyActive).toBe(true);
        expect(await Activation.countDocuments({ zelfName: "alice.zelf", chain: "sui" })).toBe(1);
    });

    test("an unknown chain is rejected", async () => {
        await expect(Chains.activateChain(alice, "cardano", chainOptions())).rejects.toMatchObject({
            clientCode: "ERR_CHAIN_UNKNOWN",
        });
    });

    test("sync of a new non-EVM address follows the same grant", async () => {
        const before = { tagName: "alice.zelf", domain: "zelf", type: "mainnet", plan: "free", ethAddress: "0xabc" };
        await expect(
            Chains.assertCanIntroduceNonEvmChains({
                before,
                after: { ...before, suiAddress: "0xsui" },
                domainConfig: null,
                authUser: {},
            }),
        ).rejects.toMatchObject({
            clientCode: "ERR_PLAN_LIMIT_REACHED",
            details: { kind: "nonEvmChain", chain: "sui" },
        });

        await expect(
            Chains.assertCanIntroduceNonEvmChains({
                before: { ...before, suiAddress: "0xold" },
                after: { ...before, suiAddress: "0xnew" },
                domainConfig: null,
                authUser: {},
            }),
        ).resolves.toMatchObject({ introduced: [] });

        await Chains.activateChain(alice, "sui", chainOptions({ plan: "premium" }));
        await expect(
            Chains.assertCanIntroduceNonEvmChains({
                before,
                after: { ...before, suiAddress: "0xsui" },
                domainConfig: null,
                authUser: {},
            }),
        ).resolves.toMatchObject({ introduced: ["sui"] });
    });
});
