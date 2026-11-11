const IpfsMiddleware = require("../../Repositories/IPFS/middlewares/ipfs.middleware");

const ipfsCtx = (query, params = {}) => ({
    state: { user: { clientId: "client-1" } },
    request: { query },
    params,
    status: 200,
    body: null,
});

describe("IPFS list query validation", () => {
    it("rejects a search with no filter", async () => {
        const ctx = ipfsCtx({});
        const next = jest.fn();

        await IpfsMiddleware.getValidation(ctx, next);

        expect(next).not.toHaveBeenCalled();
        expect(ctx.status).toBe(400);
        expect(ctx.body.code).toBe("MISSING_REQUIRED_PARAM");
    });

    it("rejects a non-string zelfName or key", async () => {
        const ctx = ipfsCtx({ zelfName: ["alice.zelf"] });
        const next = jest.fn();

        await IpfsMiddleware.getValidation(ctx, next);

        expect(next).not.toHaveBeenCalled();
        expect(ctx.status).toBe(400);
        expect(ctx.body).toEqual({ error: "INVALID_PARAM", code: "INVALID_PARAM", param: "zelfName" });
    });

    it("rejects key without value", async () => {
        const ctx = ipfsCtx({ key: "owner" });
        const next = jest.fn();

        await IpfsMiddleware.getValidation(ctx, next);

        expect(next).not.toHaveBeenCalled();
        expect(ctx.body).toEqual({ error: "MISSING_REQUIRED_PARAM", code: "MISSING_REQUIRED_PARAM", param: "value" });
    });

    it("accepts a string name, cid, or key and value", async () => {
        const next = jest.fn();

        const byName = ipfsCtx({ zelfName: "alice.zelf" });
        await IpfsMiddleware.getValidation(byName, next);
        expect(byName.status).toBe(200);

        const byCid = ipfsCtx({ cid: "bafybeigdyrzt" });
        await IpfsMiddleware.getValidation(byCid, next);

        const byKey = ipfsCtx({ key: "owner", value: "0xabc" });
        await IpfsMiddleware.getValidation(byKey, next);

        expect(next).toHaveBeenCalledTimes(3);
    });

    it("rejects a missing cid on the single-file route", async () => {
        const ctx = ipfsCtx({}, { cid: "" });
        const next = jest.fn();

        await IpfsMiddleware.showValidation(ctx, next);

        expect(next).not.toHaveBeenCalled();
        expect(ctx.body.code).toBe("MISSING_REQUIRED_PARAM");
        expect(ctx.body.param).toBe("cid");
    });
});
