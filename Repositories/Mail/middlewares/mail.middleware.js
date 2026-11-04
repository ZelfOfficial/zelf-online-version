const { mailgunSignatureValidator } = require("./mailgun-signature.middleware");

// Legacy /mail/webhook stub: previously accepted anything. Now requires a valid Mailgun signature.
const webhookValidator = mailgunSignatureValidator;

module.exports = {
	webhookValidator,
};
