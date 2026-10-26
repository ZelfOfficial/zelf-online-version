/**
 * Confirm/grant failures stay fail-closed. Mongo connectivity is a 503.
 * Other unexpected failures are logged and returned as a generic code.
 */

const MONGO_CONNECTIVITY = /force closed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|server selection|topology was destroyed|Client must be connected|not connected to|connection .*closed|buffering timed out|MongoNetworkError/i;

const isMongoConnectivityError = (error, depth = 0) => {
    if (!error || depth > 4) return false;
    const name = String(error.name || "");
    if (/Mongo(Network|ServerSelection|NotConnected)Error/.test(name)) return true;
    if (MONGO_CONNECTIVITY.test(String(error.message || ""))) return true;
    return isMongoConnectivityError(error.cause, depth + 1);
};

const isClientError = (error) => {
    if (!error) return false;
    if (error.clientCode) return true;
    const message = String(error.message || "");
    const match = /^(\d{3}):/.exec(message.trim());
    if (!match) return false;
    const status = Number(match[1]);
    return status >= 400 && status < 500;
};

const unavailable = () => {
    const error = new Error("503:QUOTE_STORE_UNAVAILABLE");
    error.clientCode = "QUOTE_STORE_UNAVAILABLE";
    error.clientMessage = "QUOTE_STORE_UNAVAILABLE";
    error.status = 503;
    return error;
};

const genericFailure = () => {
    const error = new Error("500:SERVICE_UNAVAILABLE");
    error.clientCode = "SERVICE_UNAVAILABLE";
    error.clientMessage = "SERVICE_UNAVAILABLE";
    error.status = 500;
    return error;
};

/**
 * @param {Error} error
 * @returns {Error}
 */
const mapGrantError = (error) => {
    if (isClientError(error) && !isMongoConnectivityError(error)) return error;
    if (isMongoConnectivityError(error)) {
        console.error("[zelf-id-grant] QUOTE_STORE_UNAVAILABLE", error);
        return unavailable();
    }
    const status = Number(error?.status);
    if (Number.isFinite(status) && status >= 400 && status < 500) return error;
    console.error("[zelf-id-grant] grant_failed", error);
    return genericFailure();
};

const guardGrant = (fn) => async (...args) => {
    try {
        return await fn(...args);
    } catch (error) {
        throw mapGrantError(error);
    }
};

module.exports = {
    guardGrant,
    isMongoConnectivityError,
    mapGrantError,
};
