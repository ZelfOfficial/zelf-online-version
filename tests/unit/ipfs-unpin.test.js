const { unpinPublicCids } = require("../../Core/ipfs-unpin");

const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

const clientFor = (pages, deleteImpl) => {
    let pageIndex = 0;
    const query = {
        cid() {
            return query;
        },
        limit() {
            return query;
        },
        pageToken() {
            return query;
        },
        then(onFulfilled, onRejected) {
            const page = pages[Math.min(pageIndex, pages.length - 1)];
            pageIndex += 1;
            return Promise.resolve(page).then(onFulfilled, onRejected);
        },
    };
    const deleteFiles = jest.fn(
        deleteImpl || (async (ids) => ids.map((id) => ({ id, status: "OK" })))
    );
    return {
        unpin: jest.fn(),
        files: {
            public: {
                list: () => query,
                delete: deleteFiles,
            },
        },
    };
};

describe("ipfs unpin by file id", () => {
    test("looks up the file id for a CID and deletes that id", async () => {
        const client = clientFor([{ files: [{ id: "file-123", cid }], next_page_token: null }]);

        await unpinPublicCids(client, [cid]);

        expect(client.files.public.delete).toHaveBeenCalledWith(["file-123"]);
        expect(client.unpin).not.toHaveBeenCalled();
    });

    test("deletes every file id when the CID is listed on more than one page", async () => {
        const client = clientFor([
            { files: [{ id: "file-a", cid }], next_page_token: "next" },
            { files: [{ id: "file-b", cid }], next_page_token: null },
        ]);

        await unpinPublicCids(client, cid);

        expect(client.files.public.delete).toHaveBeenCalledWith(["file-a", "file-b"]);
    });

    test("logs and rejects when the CID is missing or the delete reports a failure", async () => {
        const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
        const missing = clientFor([{ files: [], next_page_token: null }]);

        await expect(unpinPublicCids(missing, cid)).rejects.toMatchObject({ code: "IPFS_CID_NOT_FOUND" });
        expect(missing.files.public.delete).not.toHaveBeenCalled();

        const failed = clientFor([{ files: [{ id: "file-123", cid }], next_page_token: null }], async (ids) =>
            ids.map((id) => ({ id, status: "HTTP error" }))
        );
        await expect(unpinPublicCids(failed, cid)).rejects.toMatchObject({ code: "IPFS_UNPIN_FAILED" });

        expect(errorLog).toHaveBeenCalled();
        expect(errorLog.mock.calls.some((call) => call[0] === "ipfs_unpin_failed")).toBe(true);
        errorLog.mockRestore();
    });

    test("does not call a missing unpin method", async () => {
        const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
        const client = { unpin: jest.fn() };

        await expect(unpinPublicCids(client, cid)).rejects.toMatchObject({ code: "IPFS_UNPIN_UNAVAILABLE" });
        expect(client.unpin).not.toHaveBeenCalled();
        errorLog.mockRestore();
    });
});
