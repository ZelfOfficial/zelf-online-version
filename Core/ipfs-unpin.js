/**
 * Unpin public Pinata files.
 *
 * Pinata SDK 2.5 deletes with files.public.delete(fileIds). A CID is resolved
 * to those file ids first. A missing file or a failed delete is reported, not ignored.
 */

const DELETE_OK = /^(ok|no content|200|204)$/i;

const unpinError = (code, message, extra) => {
    const error = new Error(message || code);
    error.code = code;
    if (extra) error.details = extra;
    return error;
};

const logFailure = (cid, error) => {
    console.error("ipfs_unpin_failed", {
        cid,
        code: error.code || null,
        message: error.message,
    });
};

const listFileIds = async (client, cid) => {
    const ids = [];
    let pageToken = null;

    for (let page = 0; page < 10; page++) {
        let query = client.files.public.list().cid(cid);
        if (typeof query.limit === "function") query = query.limit(100);
        if (pageToken && typeof query.pageToken === "function") query = query.pageToken(pageToken);

        const response = await query;
        const files = Array.isArray(response?.files) ? response.files : [];
        for (const file of files) {
            if (file && file.id) ids.push(String(file.id));
        }

        pageToken = response?.next_page_token || null;
        if (!pageToken || files.length === 0) break;
    }

    return ids;
};

const failedDeletes = (ids, deleted) => {
    if (!Array.isArray(deleted) || deleted.length !== ids.length) {
        return [{ id: null, status: "IPFS_UNPIN_FAILED" }];
    }
    return deleted
        .filter((item) => !DELETE_OK.test(String(item?.status || "").trim()))
        .map((item) => ({ id: item?.id || null, status: item?.status || null }));
};

/**
 * @param {object} client Pinata SDK instance
 * @param {string[]|string} cids
 * @returns {Promise<object[]>}
 */
const unpinPublicCids = async (client, cids) => {
    if (typeof client?.files?.public?.list !== "function" || typeof client?.files?.public?.delete !== "function") {
        const error = unpinError("IPFS_UNPIN_UNAVAILABLE", "IPFS_UNPIN_UNAVAILABLE");
        logFailure(null, error);
        throw error;
    }

    const list = (Array.isArray(cids) ? cids : [cids]).map((cid) => (cid == null ? "" : String(cid).trim())).filter(Boolean);
    const results = [];

    for (const cid of list) {
        try {
            const ids = await listFileIds(client, cid);
            if (!ids.length) throw unpinError("IPFS_CID_NOT_FOUND", "IPFS_CID_NOT_FOUND");

            const deleted = await client.files.public.delete(ids);
            const failed = failedDeletes(ids, deleted);
            if (failed.length) throw unpinError("IPFS_UNPIN_FAILED", "IPFS_UNPIN_FAILED", failed);
            results.push(deleted);
        } catch (error) {
            if (!error.code) error.code = "IPFS_UNPIN_FAILED";
            logFailure(cid, error);
            throw error;
        }
    }

    return results;
};

module.exports = {
    unpinPublicCids,
};
