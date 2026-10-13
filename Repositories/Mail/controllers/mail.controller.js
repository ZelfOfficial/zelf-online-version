// Legacy stub: no longer echoes the payload back.
const webhookHandler = async (ctx) => {
	ctx.body = { data: { received: true } };
};

module.exports = {
	webhookHandler,
};
