// Signed acknowledgement for the old Mailgun URL. Inbound mail is stored by POST /api/mail/inbound/jim.
const webhookHandler = async (ctx) => {
	ctx.status = 200;
	ctx.body = { data: { received: true, stored: false } };
};

module.exports = {
	webhookHandler,
};
