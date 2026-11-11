const Module = require("../modules/human-authn.module");
const OnboardingModule = require("../modules/human-authn-onboarding.module");

const recordPlayStep = async (ctx, step, payload = {}) => {
	if (!ctx.state.user) {
		return;
	}

	try {
		await OnboardingModule.recordStep(ctx.state.user, step, payload);
	} catch (error) {
		console.error(`Failed to record HumanAuthn onboarding step ${step}:`, error.message);
	}
};

const encrypt = async (ctx) => {
	try {
		const data = await Module.encrypt(ctx.request.body, ctx.state.user);

		await recordPlayStep(ctx, "playCreate", {
			zelfID: data.zelfID,
			identifier: ctx.request.body.identifier || ctx.request.body.record_id || ctx.request.body._id,
		});

		ctx.body = { ...data };
	} catch (error) {
		console.error(error);

		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

const encryptQRCode = async (ctx) => {
	try {
		const data = await Module.encryptQRCode(ctx.request.body, ctx.state.user);

		ctx.body = { ...data };
	} catch (error) {
		console.error(error);

		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

const decrypt = async (ctx) => {
	try {
		const data = await Module.decrypt(ctx.request.body, ctx.state.user);

		await recordPlayStep(ctx, "playDecrypt");

		ctx.body = { ...data };
	} catch (error) {
		if (error.code === "INVALID_ZELFPROOF") {
			ctx.state.invalidZelfproof = true;
			console.error("INVALID_ZELFPROOF");
			ctx.status = 400;
			ctx.body = { error: error.message, code: "INVALID_ZELFPROOF" };
			return;
		}

		console.error(error);

		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

const preview = async (ctx) => {
	try {
		const data = await Module.preview(ctx.request.body, ctx.state.user);

		await recordPlayStep(ctx, "playPreview");

		ctx.body = { ...data };
	} catch (error) {
		console.error({ error });

		ctx.status = error.status || 500;

		ctx.body = { error: error.message };
	}
};

module.exports = {
	encrypt,
	encryptQRCode,
	decrypt,
	preview,
};
