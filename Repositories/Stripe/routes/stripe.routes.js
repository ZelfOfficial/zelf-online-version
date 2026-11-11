const config = require("../../../Core/config");
const { respondStripeMoved } = require("../stripe-moved");

const base = "/stripe";

module.exports = (server) => {
	const PATH = config.basePath(base);

	server.post(`${PATH}/webhook`, respondStripeMoved);
	server.get(`${PATH}/stripe/result`, respondStripeMoved);
};
