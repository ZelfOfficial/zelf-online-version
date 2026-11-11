const StaffModule = require("../modules/staff.module");
const { errorHandler } = require("../../../Core/http-handler");

/**
 * Get staff members for the authenticated owner
 */
const get = async (ctx) => {
	try {
		const data = await StaffModule.get(ctx.request.query, ctx.state.user);
		ctx.body = data;
	} catch (error) {
		const _exception = errorHandler(error, ctx);
		ctx.status = _exception.status || 500;
		ctx.body = {
			code: _exception.code,
			message: _exception.message,
		};
	}
};

/**
 * Generate staff invitation
 */
const generateInvitation = async (ctx) => {
	try {
		const data = await StaffModule.generateInvitation(ctx.request.body, ctx.state.user);
		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);

		ctx.status = _exception.status || 500;

		ctx.body = {
			code: _exception.code,
			message: _exception.message,
		};
	}
};

/**
 * Update staff role
 */
const updateRole = async (ctx) => {
	try {
		const data = await StaffModule.updateRole(ctx.request.body, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);
		ctx.status = _exception.status || 500;
		ctx.body = {
			code: _exception.code,
			message: _exception.message,
		};
	}
};

/**
 * Remove staff member
 */
const remove = async (ctx) => {
	try {
		const data = await StaffModule.remove(ctx.request.body, ctx.state.user);
		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);
		ctx.status = _exception.status || 500;
		ctx.body = {
			code: _exception.code,
			message: _exception.message,
		};
	}
};

/**
 * Save Passkey Metadata
 */
const savePasskey = async (ctx) => {
	try {
		const data = await StaffModule.savePasskey(ctx.request.body);
		ctx.body = data;
	} catch (error) {
		const _exception = errorHandler(error, ctx);
		ctx.status = _exception.status || 500;
		ctx.body = {
			code: _exception.code,
			message: _exception.message,
		};
	}
};

/**
 * Get Passkey Metadata
 */
const getPasskey = async (ctx) => {
	try {
		const { identifier } = ctx.request.query;
		if (!identifier) throw new Error("400:missing_identifier");

		const data = await StaffModule.getPasskey(identifier);
		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);
		ctx.status = _exception.status || 500;
		ctx.body = {
			code: _exception.code,
			message: _exception.message,
		};
	}
};

/**
 * Get Passkey IPFS Details
 */
const getPasskeyIpfsDetails = async (ctx) => {
	try {
		const { identifier, keyType } = ctx.request.query;
		if (!identifier) throw new Error("400:missing_identifier");
		if (!keyType) throw new Error("400:missing_key_type");

		const data = await StaffModule.getPasskeyIpfsDetails(identifier, keyType);
		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);
		ctx.status = _exception.status || 500;
		ctx.body = {
			code: _exception.code,
			message: _exception.message,
		};
	}
};

/**
 * Delete Passkey
 */
const deletePasskey = async (ctx) => {
	try {
		const data = await StaffModule.deletePasskey(ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);
		ctx.status = _exception.status || 500;
		ctx.body = {
			code: _exception.code,
			message: _exception.message,
		};
	}
};

/**
 * Update staff profile
 */
const updateProfile = async (ctx) => {
	try {
		const data = await StaffModule.updateProfile(ctx.request.body, ctx.state.user);

		ctx.body = { data };
	} catch (error) {
		const _exception = errorHandler(error, ctx);
		ctx.status = _exception.status || 500;
		ctx.body = {
			code: _exception.code,
			message: _exception.message,
		};
	}
};

module.exports = {
	get,
	generateInvitation,
	updateRole,
	remove,
	savePasskey,
	getPasskey,
	getPasskeyIpfsDetails,
	deletePasskey,
	updateProfile,
};
