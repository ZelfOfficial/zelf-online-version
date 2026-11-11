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

const V4_HUMAN_AUTHN_DECRYPT = "https://v4.zelf.world/api/human-authn/decrypt";

const decrypt = async (ctx) => {
	ctx.status = 410;
	ctx.body = {
		code: "ENDPOINT_MOVED_TO_V4",
		message: `This endpoint has moved. Use ${V4_HUMAN_AUTHN_DECRYPT}`,
		newEndpoint: V4_HUMAN_AUTHN_DECRYPT,
	};
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
