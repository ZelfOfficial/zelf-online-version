const config = require("../../../Core/config");
const Controller = require("../controllers/face.controller");
const Middleware = require("../middlewares/face.middleware");

const base = "/face";

module.exports = (server) => {
    const PATH = config.basePath(base);

    server.post(`${PATH}/nonce`, Middleware.nonceIssueValidation, Controller.issueNonce);
};
