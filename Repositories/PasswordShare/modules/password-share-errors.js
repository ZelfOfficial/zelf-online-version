const { codedError } = require("../../../Core/http-handler");

/**
 * Throw an error `Core/http-handler` renders as `{ code, message }` with both
 * set to the same UPPER_SNAKE code. The message must not carry ciphertext,
 * the IV, or any other request body field.
 * @param {number} status
 * @param {string} code
 */
const fail = (status, code) => {
	const error = codedError(`${status}:${code}`);
	error.status = status;
	throw error;
};

module.exports = {
	fail,
};
