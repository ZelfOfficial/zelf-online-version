const Module = require("../modules/inbound-mail.module");

const fail = (ctx, error) => {
	const [code, msg] = String(error?.message || "").split(":");
	const status = Number(code);
	ctx.status = status >= 400 && status < 600 ? status : 500;
	ctx.body = { error: status ? msg : "internal_error" };
	if (!status) console.error("[mail-inbound]", error?.message);
};

const receive = async (ctx) => {
	try {
		ctx.body = { data: await Module.receive(ctx.request.body || {}, ctx.request.files || {}) };
	} catch (e) {
		fail(ctx, e);
	}
};

const list = async (ctx) => {
	try {
		ctx.body = { data: await Module.list(ctx.query) };
	} catch (e) {
		fail(ctx, e);
	}
};

const get = async (ctx) => {
	try {
		ctx.body = { data: await Module.get(ctx.params.id) };
	} catch (e) {
		if (e?.name === "CastError") e = new Error("404:not_found");
		fail(ctx, e);
	}
};

const update = async (ctx) => {
	try {
		ctx.body = { data: await Module.markAction(ctx.params.id, ctx.request.body || {}, ctx.state.inboundActor) };
	} catch (e) {
		if (e?.name === "CastError") e = new Error("404:not_found");
		fail(ctx, e);
	}
};

module.exports = { receive, list, get, update };
