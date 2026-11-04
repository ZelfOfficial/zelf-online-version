const config = require("../../Core/config");
const Middleware = require("../../Repositories/Lifi/middlewares/lifi.middleware");
const Module = require("../../Repositories/Lifi/modules/lifi.module");

jest.setTimeout(120000);

const PLACEHOLDER_KEY = "present-for-route-check";
const EVM_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SOL_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
const POLYGON_NATIVE = "0x0000000000000000000000000000000000000000";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_NATIVE = "11111111111111111111111111111111";

const quoteQuery = (overrides) => ({
    fromAddress: EVM_ADDRESS,
    fromAmount: "1000000",
    fromChain: "137",
    fromToken: POLYGON_USDC,
    slippage: "0.005",
    toAddress: EVM_ADDRESS,
    toChain: "137",
    toToken: POLYGON_NATIVE,
    ...overrides,
});

const run = async (validation, ctx) => {
    let continued = false;
    await validation(ctx, async () => {
        continued = true;
    });
    return continued;
};

describe("POST /api/lifi/execute-advanced-step-transaction step shape", () => {
    let saved;

    beforeAll(() => {
        saved = {
            url: config.lifi.url,
            apiKey: config.lifi.apiKey,
            integrator: config.lifi.integrator,
        };
        config.lifi.url = saved.url || "https://li.quest/v1";
        config.lifi.integrator = saved.integrator || "zelf-test";
        if (!saved.apiKey) config.lifi.apiKey = PLACEHOLDER_KEY;
    });

    afterAll(() => {
        config.lifi.url = saved.url;
        config.lifi.apiKey = saved.apiKey;
        config.lifi.integrator = saved.integrator;
    });

    const validateExecute = (body) => {
        const ctx = { request: { body }, status: undefined, body: undefined };
        return run(Middleware.executeAdvancedStepTransactionValidation, ctx).then((continued) => ({ ctx, continued }));
    };

    /**
     * Quotes do not need a key. A placeholder key would be sent as x-lifi-api-key and rejected.
     * A real LIFI_API_KEY / LIFI_KEY from the environment is sent.
     */
    const callLifi = async (fn) => {
        const previous = config.lifi.apiKey;
        if (previous === PLACEHOLDER_KEY) config.lifi.apiKey = undefined;
        try {
            return await fn();
        } finally {
            config.lifi.apiKey = previous;
        }
    };

    const quoteAndExecute = async (query) => {
        const requestQuery = { ...query };
        const quoteCtx = { query: requestQuery, request: { query: requestQuery }, status: undefined, body: undefined };
        const quoteContinued = await run(Middleware.getQuoteValidation, quoteCtx);
        expect(quoteContinued).toBe(true);

        const step = await callLifi(() => Module.getQuote(quoteCtx.query));
        const { ctx, continued } = await validateExecute(step);
        expect(continued).toBe(true);
        expect(ctx.request.body).toEqual(step);

        const executed = await callLifi(() =>
            Module.executeAdvancedStepTransaction({ ...step, integrator: "someone-else", referrer: "other-app" })
        );
        return { step, executed };
    };

    test("rejects a step that is not a LI.FI quote", async () => {
        const missing = await validateExecute({});
        expect(missing.continued).toBe(false);
        expect(missing.ctx.status).toBe(400);
        expect(missing.ctx.body.validationError).toMatch(/missing id/);

        const characterType = await validateExecute({ type: "s" });
        expect(characterType.continued).toBe(false);
        expect(characterType.ctx.status).toBe(400);
        expect(characterType.ctx.body.validationError).toMatch(/type must be one of/);

        const quoted = await callLifi(() => Module.getQuote(quoteQuery({ slippage: 0.005 })));
        const addressToken = JSON.parse(JSON.stringify(quoted));
        addressToken.action.fromToken = addressToken.action.fromToken.address;
        addressToken.action.toToken = addressToken.action.toToken.address;
        const tokenString = await validateExecute(addressToken);
        expect(tokenString.continued).toBe(false);
        expect(tokenString.ctx.body.validationError).toMatch(/fromToken/);

        const emptyToken = JSON.parse(JSON.stringify(quoted));
        emptyToken.action.fromToken = {};
        const tokenObject = await validateExecute(emptyToken);
        expect(tokenObject.continued).toBe(false);
        expect(tokenObject.ctx.body.validationError).toMatch(/fromToken/);

        const badDuration = JSON.parse(JSON.stringify(quoted));
        badDuration.estimate.executionDuration = { seconds: 30 };
        const duration = await validateExecute(badDuration);
        expect(duration.continued).toBe(false);
        expect(duration.ctx.body.validationError).toMatch(/executionDuration/);

        const withReferrer = JSON.parse(JSON.stringify(quoted));
        withReferrer.referrer = "other-app";
        const referrer = await validateExecute(withReferrer);
        expect(referrer.continued).toBe(false);
        expect(referrer.ctx.body.validationError).toMatch(/referrer/);

        const wideSlippage = JSON.parse(JSON.stringify(quoted));
        wideSlippage.action.slippage = 2;
        const slippage = await validateExecute(wideSlippage);
        expect(slippage.continued).toBe(false);
        expect(slippage.ctx.body.validationError).toMatch(/slippage/);
    });

    test("does not require fromChain and does not treat zero as missing", async () => {
        await expect(
            Module.executeAdvancedStepTransaction({
                id: "1",
                tool: "sushiswap",
                type: "lifi",
                action: { fromAmount: "1", svmMaxSupportedTransactionVersion: 0, destinationGasConsumption: "" },
            })
        ).rejects.toThrow(/action\.fromToken/);

        await expect(
            Module.executeAdvancedStepTransaction({
                id: "1",
                tool: "sushiswap",
                type: "lifi",
                fromChain: "",
                action: { fromAmount: "1" },
            }).catch((error) => {
                expect(error.message).not.toMatch(/fromChain/);
                throw error;
            })
        ).rejects.toThrow(/Missing required parameters/);
    });

    test("Polygon USDC to native: quote data is accepted by execute and is not broadcast", async () => {
        const { step, executed } = await quoteAndExecute(quoteQuery());

        expect(step.type).toBe("lifi");
        expect(step.fromChain).toBeUndefined();
        expect(step.integrator).toBe(config.lifi.integrator);
        expect(step.action.fromToken).toMatchObject({ address: POLYGON_USDC, symbol: "USDC" });
        expect(typeof step.action.fromToken).toBe("object");
        expect(typeof step.estimate.executionDuration).toBe("number");
        expect(Array.isArray(step.estimate.feeCosts)).toBe(true);
        expect(step.transactionRequest).toBeTruthy();

        expect(executed.integrator).toBe(config.lifi.integrator);
        expect(executed.referrer).toBeUndefined();
        expect(typeof executed.transactionRequest.data).toBe("string");
        expect(executed.transactionRequest.data.length).toBeGreaterThan(2);
        expect(executed.transactionRequest).not.toHaveProperty("signedTransaction");
    });

    test("Solana USDC to native: quote data is accepted by execute, including zero fields", async () => {
        const { step, executed } = await quoteAndExecute(
            quoteQuery({
                fromAddress: SOL_ADDRESS,
                fromChain: "1151111081099710",
                fromToken: SOLANA_USDC,
                toAddress: SOL_ADDRESS,
                toChain: "1151111081099710",
                toToken: SOLANA_NATIVE,
            })
        );

        expect(step.type).toBe("lifi");
        expect(step.action.svmMaxSupportedTransactionVersion).toBe(0);
        expect(step.action.destinationGasConsumption).toBe("");
        expect(step.action.fromToken.address).toBe(SOLANA_USDC);
        expect(typeof step.estimate.executionDuration).toBe("number");
        expect(step.integrator).toBe(config.lifi.integrator);

        const olderAppShape = JSON.parse(JSON.stringify(step));
        delete olderAppShape.integrator;
        delete olderAppShape.transactionRequest;
        olderAppShape.fromChain = "1151111081099710";
        const { continued, ctx } = await validateExecute(olderAppShape);
        expect(continued).toBe(true);
        expect(ctx.request.body.fromChain).toBe("1151111081099710");
        expect(ctx.request.body.transactionRequest).toBeUndefined();

        expect(executed.integrator).toBe(config.lifi.integrator);
        expect(executed.referrer).toBeUndefined();
        expect(executed.transactionRequest.data).toEqual(expect.any(String));
    });

    test("quote query rejects a caller-supplied integrator", async () => {
        const query = quoteQuery({ integrator: "other-app" });
        const ctx = { query, request: { query }, status: undefined, body: undefined };
        const continued = await run(Middleware.getQuoteValidation, ctx);
        expect(continued).toBe(false);
        expect(ctx.status).toBe(400);
        expect(ctx.body.validationError).toMatch(/integrator/);
    });
});
