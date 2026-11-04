const { Address } = require("@ton/core");

const invalidTonAddressError = () => {
	const error = new Error("invalid_ton_address");
	error.status = 409;
	return error;
};

const assertValidTonAddress = (value) => {
	const trimmed = String(value || "").trim();
	if (!trimmed) throw invalidTonAddressError();

	try {
		Address.parse(trimmed);
	} catch (_) {
		throw invalidTonAddressError();
	}

	return trimmed;
};

const toRawTonAddress = (value) => {
	try {
		return Address.parse(String(value || "").trim()).toRawString();
	} catch (_) {
		return null;
	}
};

/** True when two TON addresses (raw 0:… or friendly UQ/EQ) point to the same account. */
const sameTonAddress = (a, b) => {
	const ra = toRawTonAddress(a);
	const rb = toRawTonAddress(b);
	return ra != null && ra === rb;
};

module.exports = {
	assertValidTonAddress,
	sameTonAddress,
	toRawTonAddress,
};
