const mongoose = require("mongoose");

let MongoConnection = null;

const config = require("./config");
// Option 1: Passing parameters separately
let pool = null;

const initMongoDB = () => {
    mongoose.Promise = global.Promise;

    // Construct the MongoDB URI with poolSize parameter if needed
    let uri = config.db.uri;
    // if (config.env === "production") {
    // const poolSizeParam = `poolSize=${config.db.poolSize}`;

    // uri += uri.includes("?") ? `&${poolSizeParam}` : `?${poolSizeParam}`;
    // }


    mongoose.connect(uri);

    MongoConnection = mongoose.connection;

    // Unique indexes that guard money paths are built explicitly (autoIndex may be off in production).
    MongoConnection.once("open", () => {
        require("../Repositories/ZelfID/modules/zelf-ids-revenue-cat-events.module")
            .ensureIndexes()
            .catch((error) => console.error("RevenueCatProcessedEvent index creation failed:", error?.message || error));
        require("../Repositories/ZelfID/modules/zelf-id-monthly-access.module")
            .ensureIndexes()
            .catch((error) => console.error("Monthly access index creation failed:", error?.message || error));
    });

    return MongoConnection;
};

/**
 * Disconnects from the DB gracefully
 * @return {Promise}
 */
const disconnect = () => {
    // return sequelize.close();
};

module.exports = {
    initMongoDB,
    MongoConnection,
    disconnect,
    getPool: () => {
        return pool;
    },
};
