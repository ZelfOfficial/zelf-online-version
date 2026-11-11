const IpfsMiddleware = require("../../Repositories/IPFS/middlewares/ipfs.middleware");
const BlockdagMiddleware = require("../../Repositories/BlockDAG/middlewares/blockdag-nft.middleware");

const ipfsCtx = (query, params = {}) => ({
    state: { user: { clientId: "client-1" } },
    request: { query },
    params,
    status: 200,
    body: null,
});

const publicCtx = (query = {}, params = {}) => ({
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

describe("public BlockDAG NFT list validation", () => {
    it("rejects a non-string owner or collection filter", async () => {
        const collections = publicCtx({ owner: ["0xabc"] });
        const next = jest.fn();

        await BlockdagMiddleware.listCollectionsValidation(collections, next);

        expect(collections.status).toBe(400);
        expect(collections.body.code).toBe("INVALID_PARAM");
        expect(collections.body.param).toBe("owner");

        const items = publicCtx({ collection: { address: "0xabc" } });
        await BlockdagMiddleware.listItemsValidation(items, next);

        expect(items.body).toEqual({ success: false, error: "INVALID_PARAM", code: "INVALID_PARAM", param: "collection" });
        expect(next).not.toHaveBeenCalled();
    });

    it("allows listing without an owner filter", async () => {
        const ctx = publicCtx({ limit: "25" });
        const next = jest.fn();

        await BlockdagMiddleware.listCollectionsValidation(ctx, next);
        await BlockdagMiddleware.listItemsValidation(ctx, next);

        expect(next).toHaveBeenCalledTimes(2);
        expect(ctx.status).toBe(200);
    });

    it("requires a string cid or search query", async () => {
        const missingCid = publicCtx({});
        const next = jest.fn();

        await BlockdagMiddleware.itemByQueryValidation(missingCid, next);
        expect(missingCid.body.code).toBe("MISSING_REQUIRED_PARAM");
        expect(missingCid.body.param).toBe("cid");

        const badQuery = publicCtx({ q: "a" });
        await BlockdagMiddleware.searchCollectionsValidation(badQuery, next);
        expect(badQuery.body.code).toBe("INVALID_PARAM");

        const missingQuery = publicCtx({});
        await BlockdagMiddleware.searchCollectionsValidation(missingQuery, next);
        expect(missingQuery.body.code).toBe("MISSING_REQUIRED_PARAM");

        const ok = publicCtx({ q: "art" });
        await BlockdagMiddleware.searchCollectionsValidation(ok, next);
        expect(next).toHaveBeenCalledTimes(1);
    });

    it("requires the collection id when listing its items", async () => {
        const ctx = publicCtx({}, { id: "" });
        const next = jest.fn();

        await BlockdagMiddleware.collectionItemsValidation(ctx, next);

        expect(next).not.toHaveBeenCalled();
        expect(ctx.body.code).toBe("MISSING_REQUIRED_PARAM");
        expect(ctx.body.param).toBe("id");
    });
});
