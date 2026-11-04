const formData = require("form-data");
const axios = require("axios");
const config = require("./config");
const ejs = require("../Utilities/ejs.module");

const domain = config.email_providers.mailgun.domain;

const sendRequest = async (data) => {
	try {
		const form = new formData();
		Object.keys(data).forEach((key) => {
			form.append(key, data[key]);
		});

		const auth = `api:${config.email_providers.mailgun.apiKey || "key-yourkeyhere"}`;
		const headers = {
			...form.getHeaders(),
			Authorization: `Basic ${Buffer.from(auth).toString("base64")}`,
		};

		const response = await axios.post(`${config.email_providers.mailgun.apiBase}/v3/${domain}/messages`, form, {
			headers,
		});

		console.log("✅ Email sent:", response.data);
		return response.data;
	} catch (error) {
		throw error;
	}
};

/**
 * Send custom email with EJS template
 * @param {string} to - Recipient email
 * @param {string} contentTemplate - Template name (e.g., 'staff_invitation')
 * @param {object} data - Template data
 * @param {string} userLanguage - Language code
 * @returns {Promise<object|null>}
 */
const sendCustomEmail = async (to, contentTemplate, data = {}, userLanguage = "en") => {
	try {
		const { templateData, html } = await ejs.renderMail(contentTemplate, data, userLanguage);

		const _to = config.env === "production" ? to : config.email_providers.mailgun.proxyEmail;
		// const _to = to;

		const emailData = {
			from: "Zelf <noreply@mg.zelf.world>",
			to: _to,
			subject: templateData.subject,
			html,
		};

		if (config.debug.sendEmail) console.log("📧 Sending email:", { to: emailData.to, subject: emailData.subject });

		const response = await sendRequest(emailData);

		return response;
	} catch (exception) {
		console.error("❌ sendCustomEmail error:", {
			exception: exception.message || exception,
			details: exception.response?.data || exception.details,
			to,
			contentTemplate,
		});
		return null;
	}
};

/**
 * Send email with Mailgun template (legacy)
 * @param {string} to
 * @param {string} subject
 * @param {string} template
 * @param {object} extraParams
 * @returns {Promise<object|null>}
 */
const sendEmail = async (to, subject, template, extraParams = {}) => {
	if (!subject || !template) {
		return null;
	}

	// const _to = config.env === "production" ? to : config.email_providers.mailgun.proxyEmail;
	const _to = to;

	const emailData = {
		from: "Zelf <noreply@mg.zelf.world>",
		to: _to,
		subject,
		template,
	};

	// Handle recipient variables if provided
	if (extraParams["recipient-variables"]) {
		if (config.env === "development") {
			const keys = Object.keys(extraParams["recipient-variables"]);

			for (let index = 0; index < keys.length; index++) {
				const key = keys[index];
				extraParams["recipient-variables"][_to] = extraParams["recipient-variables"][key];
			}
		}

		emailData["recipient-variables"] = JSON.stringify(extraParams["recipient-variables"]);
	}

	try {
		if (config.debug.sendEmail) console.log("📧 Sending template email:", emailData);

		const response = await sendRequest(emailData);

		return response;
	} catch (exception) {
		console.error("❌ sendEmail error:", {
			exception: exception.message || exception,
			details: exception.response?.data || exception.details,
			emailData,
		});
		return null;
	}
};

module.exports = {
	sendEmail,
	sendCustomEmail,
};
