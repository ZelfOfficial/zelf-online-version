#!/usr/bin/env node
/**
 * WhatsApp send test — direct Meta Graph API or Verifik relay on Zelf.
 *
 * Direct Meta (default Verifik WABA):
 *   WHATSAPP_API_TOKEN=... WHATSAPP_API_PHONE_IDENTIFIER=111417608275326 \
 *   node scripts/test-whatsapp-send.js [recipient] [otp]
 *
 * Relay — default sender (whatsAppIdentifier null):
 *   VERIFIK_WHATSAPP_RELAY_API_KEY=... \
 *   node scripts/test-whatsapp-send.js --relay [recipient] [otp]
 *
 * Relay — TCC sender (whatsAppIdentifier 624749820726878):
 *   VERIFIK_WHATSAPP_RELAY_API_KEY=... TCC_WHATSAPP_API_KEY=... \
 *   node scripts/test-whatsapp-send.js --relay --tcc [recipient] [otp]
 */

const os = require("os");
const https = require("https");

const args = process.argv.slice(2);
const useRelay = args.includes("--relay");
const useTcc = args.includes("--tcc");
const positional = args.filter((arg) => !arg.startsWith("--"));

const defaultPhoneId = process.env.WHATSAPP_API_PHONE_IDENTIFIER || "111417608275326";
const tccPhoneId = "624749820726878";
const phoneId = useTcc ? tccPhoneId : defaultPhoneId;
const token = useTcc ? process.env.TCC_WHATSAPP_API_KEY : process.env.WHATSAPP_API_TOKEN;
const relayApiKey = process.env.VERIFIK_WHATSAPP_RELAY_API_KEY;
const relayBaseUrl = (process.env.ZELF_WHATSAPP_URL || "https://v4.zelf.world").replace(/\/$/, "");
const to = (positional[0] || "50765342766").replace(/\D/g, "");
const otp = positional[1] || `${Math.floor(100000 + Math.random() * 900000)}`;

const httpsGet = (url) =>
	new Promise((resolve, reject) => {
		https
			.get(url, (res) => {
				let data = "";
				res.on("data", (chunk) => (data += chunk));
				res.on("end", () => resolve(data.trim()));
			})
			.on("error", reject);
	});

const httpsPostJson = (url, headers, body) =>
	new Promise((resolve, reject) => {
		const payload = JSON.stringify(body);
		const req = https.request(
			url,
			{
				method: "POST",
				headers: {
					...headers,
					"Content-Type": "application/json",
					"Content-Length": Buffer.byteLength(payload),
				},
			},
			(res) => {
				let data = "";
				res.on("data", (chunk) => (data += chunk));
				res.on("end", () => {
					try {
						resolve({ status: res.statusCode, body: data ? JSON.parse(data) : {} });
					} catch (parseError) {
						resolve({ status: res.statusCode, body: { raw: data } });
					}
				});
			}
		);
		req.on("error", reject);
		req.write(payload);
		req.end();
	});

const buildTemplatePayload = () => ({
	to,
	template: "authentication",
	language: "es",
	components: [
		{
			type: "body",
			parameters: [{ type: "text", text: `${otp}` }],
		},
		{
			type: "button",
			sub_type: "url",
			index: "0",
			parameters: [{ type: "text", text: `${otp}` }],
		},
	],
});

const run = async () => {
	if (useRelay) {
		if (!relayApiKey) {
			console.error("Missing VERIFIK_WHATSAPP_RELAY_API_KEY");
			process.exit(1);
		}
	} else if (!token) {
		console.error(useTcc ? "Missing TCC_WHATSAPP_API_KEY" : "Missing WHATSAPP_API_TOKEN");
		process.exit(1);
	}

	let outboundIp = "unknown";

	try {
		outboundIp = await httpsGet("https://ifconfig.me/ip");
	} catch (ipError) {
		outboundIp = `lookup failed: ${ipError.message}`;
	}

	console.log(
		JSON.stringify(
			{
				mode: useRelay ? "relay" : "direct-meta",
				sender: useTcc ? "tcc" : "verifik-default",
				host: os.hostname(),
				outboundIp,
				phoneId: useRelay && !useTcc ? null : phoneId,
				relayUrl: useRelay ? `${relayBaseUrl}/api/whatsapp/messages` : undefined,
				to,
				otp,
				tokenPrefix: token ? token.slice(0, 12) : undefined,
			},
			null,
			2
		)
	);

	const templatePayload = buildTemplatePayload();

	try {
		let response;

		if (useRelay) {
			response = await httpsPostJson(
				`${relayBaseUrl}/api/whatsapp/messages`,
				{ "X-API-Key": relayApiKey },
				{
					...templatePayload,
					whatsAppIdentifier: useTcc ? Number(tccPhoneId) : null,
				}
			);
		} else {
			response = await httpsPostJson(
				`https://graph.facebook.com/v22.0/${phoneId}/messages`,
				{ Authorization: `Bearer ${token}` },
				{
					messaging_product: "whatsapp",
					...templatePayload,
					type: "template",
					template: {
						name: templatePayload.template,
						language: { code: templatePayload.language },
						components: templatePayload.components,
					},
				}
			);
		}

		if (response.status >= 200 && response.status < 300) {
			const messageId = useRelay
				? response.body?.data?.messages?.[0]?.id
				: response.body?.messages?.[0]?.id;

			console.log(
				JSON.stringify(
					{
						result: "OK",
						httpStatus: response.status,
						messageId,
						otp,
					},
					null,
					2
				)
			);
			return;
		}

		const metaError = response.body?.error;
		const relayError = response.body?.validationError || response.body?.message;

		console.error(
			JSON.stringify(
				{
					result: "FAIL",
					httpStatus: response.status,
					code: metaError?.code,
					message: metaError?.message || relayError || response.body?.error,
					isTransient: metaError?.is_transient,
					fbtraceId: metaError?.fbtrace_id,
					body: response.body,
				},
				null,
				2
			)
		);
		process.exit(1);
	} catch (error) {
		console.error(JSON.stringify({ result: "FAIL", message: error.message }, null, 2));
		process.exit(1);
	}
};

run();
