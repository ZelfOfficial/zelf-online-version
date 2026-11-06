const Model = require("../models/social-campaign-record.model");
const config = require("../../../Core/config");
const axios = require("axios");
const crypto = require("crypto");
const { generateOTPEmailHTML } = require("../templates/otp-email.template");
const TagsSearchModule = require("../../Tags/modules/tags-search.module");
const domain = "mg.zelf.world";
const MyTagsModule = require("../../Tags/modules/my-tags.module");
const { getDomainConfig } = require("../../Tags/config/supported-domains");

/**
 * Generate a 6-digit OTP code
 * @returns {string} 6-digit OTP code
 */
const generateOTP = () => {
	return crypto.randomInt(100000, 999999).toString();
};

/**
 * Send OTP email to user with HTML content
 * @param {string} email - User email address
 * @param {string} otp - OTP code to send
 * @param {string} language - Language code ('en' or 'es'), defaults to 'en'
 * @returns {Promise<Object>} Email sending result
 */
const sendOTPEmail = async (email, otp, language = "en") => {
	try {
		const isSpanish = language === "es" || language === "es-ES" || language === "es-MX";

		const subject = isSpanish ? "Código de Verificación de Email - Campaña Social" : "Email Verification Code - Social Campaign";

		const _to = config.env === "production" ? email : config.email_providers.mailgun.proxyEmail;

		const htmlContent = generateOTPEmailHTML(otp, language);

		const formData = new URLSearchParams();
		formData.append("from", "Zelf <noreply@mg.zelf.world>");
		formData.append("to", _to);
		formData.append("subject", subject);
		formData.append("html", htmlContent);

		try {
			if (config.debug.sendEmail) {
				console.log("Email data:", formData.toString());
				console.log(`[DEV] OTP for ${email}: ${otp}`);
			}

			const response = await axios.post(`https://api.mailgun.net/v3/${domain}/messages`, formData, {
				auth: {
					username: "api",
					password: config.email_providers.mailgun.apiKey,
				},
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
				},
			});

			if (config.debug.sendEmail) {
				console.log("Email response:", response.data);
			}

			// Fallback: log the OTP for development
			if (process.env.NODE_ENV !== "production") {
				console.log(`[DEV] OTP for ${email}: ${otp}`);
			}

			return response.data;
		} catch (exception) {
			console.error({
				emailException: exception,
				emailData: formData.toString(),
			});

			// Fallback: log the OTP for development
			if (process.env.NODE_ENV !== "production") {
				console.log(`[DEV] OTP for ${email}: ${otp}`);
			}

			return null;
		}
	} catch (error) {
		console.error("Error sending OTP email:", error);
		// Fallback: log the OTP for development
		if (process.env.NODE_ENV !== "production") {
			console.log(`[DEV] OTP for ${email}: ${otp}`);
		}
		throw new Error("Failed to send OTP email");
	}
};

/**
 * Step 1: Provide social email
 * Generates and sends OTP to the provided email
 * Updates existing record instead of deleting to preserve X and LinkedIn validation flags
 * @param {string} email - User email address
 * @param {string} tagName - Tag name
 * @param {string} domain - Domain
 * @param {Object} authUser - Authenticated user from JWT
 * @returns {Promise<Object>} Response with success status
 */
const provideEmail = async (email, tagName, domain, authUser) => {
	// Check if there's an existing record for this email, tagName, and domain
	const existingSocialRecord = await Model.findOne({
		email,
		tagName,
		domain,
	});

	// If record exists and is already verified, don't allow resend
	if (existingSocialRecord && existingSocialRecord.verified) throw new Error("400:social_record_already_verified");

	// If there's an existing record, check rate limiting (1 minute cooldown)
	if (existingSocialRecord) {
		const timeSinceLastUpdate = Date.now() - existingSocialRecord.updatedAt.getTime();
		const oneMinute = 60 * 1000;

		if (timeSinceLastUpdate < oneMinute) {
			throw new Error("429:please_wait_before_requesting_a_new_otp_code");
		}

		// Update existing record instead of deleting
		// Generate new OTP
		const otp = generateOTP();

		// Update the existing record with new OTP and reset attempts
		// Preserve followedX and followedLinkedin flags
		existingSocialRecord.otp = otp; // Will be hashed by pre-save hook
		existingSocialRecord.attempts = 0; // Reset attempts for new OTP
		existingSocialRecord.verified = false; // Ensure it's not verified
		existingSocialRecord.expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes from now
		// Keep followedX and followedLinkedin as they are

		await existingSocialRecord.save();

		// Detect language from authUser or default to English
		const language = authUser?.language || authUser?.lang || "en";

		// Send OTP via email
		await sendOTPEmail(email, otp, language);

		return {
			success: true,
			message: "OTP code has been sent to your email",
			email: email,
			tagName: tagName,
			domain: domain,
			followedX: existingSocialRecord.followedX,
			followedLinkedin: existingSocialRecord.followedLinkedin,
		};
	}

	// No existing record, create a new one
	const otp = generateOTP();

	const socialRecord = new Model({
		email: email,
		otp: otp, // Will be hashed by pre-save hook
		verified: false,
		attempts: 0,
		tagName,
		domain,
		followedX: false,
		followedLinkedin: false,
		expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes from now
	});

	await socialRecord.save();

	// Detect language from authUser or default to English
	const language = authUser?.language || authUser?.lang || "en";

	// Send OTP via email
	await sendOTPEmail(email, otp, language);

	return {
		success: true,
		message: "OTP code has been sent to your email",
		email: email,
		tagName: tagName,
		domain: domain,
		followedX: false,
		followedLinkedin: false,
	};
};

/**
 * Step 2: Validate OTP
 * Validates the OTP code for the provided email
 * Checks expiration manually since TTL index was removed
 * @param {string} email - User email address
 * @param {string} otp - OTP code to validate
 * @param {string} tagName - Tag name
 * @param {string} domain - Domain
 * @param {Object} authUser - Authenticated user from JWT
 * @returns {Promise<Object>} Response with validation result
 */
const validateOTP = async (email, otp, tagName, domain, authUser) => {
	// Find the OTP record for this email, tagName, and domain
	const socialRecord = await Model.findOne({
		email: email,
		tagName,
		domain,
	});

	if (!socialRecord) throw new Error("404:social_record_not_found");

	if (socialRecord.verified) throw new Error("400:social_record_already_verified");

	// Check if OTP has expired (manual check since no TTL index)
	const now = new Date();
	if (socialRecord.expiresAt && now > socialRecord.expiresAt) {
		throw new Error("400:otp_code_expired");
	}

	// Check if maximum attempts exceeded
	if (socialRecord.attempts >= socialRecord.maxAttempts) {
		// Instead of deleting, extend expiration to allow resend after cooldown
		// This preserves the record for X and LinkedIn validations
		socialRecord.expiresAt = new Date(Date.now() + 10 * 60 * 1000); // Extend by 10 minutes
		await socialRecord.save();

		throw new Error("429:maximum_validation_attempts_exceeded");
	}

	// Increment attempts
	socialRecord.attempts += 1;

	// Validate OTP using bcrypt comparison
	const isOTPValid = await socialRecord.compareOTP(otp);

	if (!isOTPValid) {
		await socialRecord.save();

		throw new Error("400:invalid_otp_code");
	}

	// OTP is valid - mark as verified
	socialRecord.verified = true;

	await socialRecord.save();

	return {
		success: true,
		message: "Email validated successfully",
		email: socialRecord.email,
		tagName: socialRecord.tagName,
		domain: socialRecord.domain,
		followedX: socialRecord.followedX,
		xUsername: socialRecord.xUsername,
		followedLinkedin: socialRecord.followedLinkedin,
		linkedInUsername: socialRecord.linkedInUsername,
	};
};

/**
 * Step 3: Validate X (Twitter) follow
 * Analyzes screenshot using Gemini AI to verify user followed required X account
 * @param {string} email - User email address
 * @param {string} tagName - Tag name
 * @param {string} domain - Domain
 * @param {string} screenshot - Base64 encoded screenshot image
 * @param {string} xUsername - X (Twitter) username that user claims to follow
 * @param {Object} authUser - Authenticated user from JWT
 * @returns {Promise<Object>} Response with validation result
 */
const validateX = async (email, tagName, domain, screenshot, xUsername, authUser) => {
	const socialAccountsConfig = require("../config/social-accounts.config");

	const GeminiAI = require("./gemini-ai.module");

	// Find the social record
	const socialRecord = await Model.findOne({
		email,
		tagName,
		domain,
	});

	if (!socialRecord) throw new Error("404:social_record_not_found");

	if (!socialRecord.verified) throw new Error("400:email_must_be_verified_first");

	if (socialRecord.followedX) throw new Error("400:x_already_validated");

	// Get X accounts from config
	const xAccounts = socialAccountsConfig.x.accounts;

	if (!xAccounts || xAccounts.length === 0) throw new Error("500:x_accounts_not_configured");

	// Always validate against configured accounts from the screenshot
	// xUsername is optional - if provided, we'll use it for reference, but Gemini AI will detect from screenshot
	// The screenshot should show the user following @blockdag8990 (Liza's account)
	let accountsToValidate = xAccounts;

	// If xUsername is provided, verify it matches one of the configured accounts (optional validation)
	if (xUsername) {
		const normalizedXUsername = xUsername.toLowerCase().replace(/^@/, "");
		const matchingAccount = xAccounts.find(
			(acc) => acc.username?.toLowerCase().replace(/^@/, "") === normalizedXUsername || acc.displayName?.toLowerCase() === normalizedXUsername
		);

		if (!matchingAccount) {
			// If username doesn't match, still proceed - Gemini AI will validate from screenshot
			// But log a warning that the provided username doesn't match configured accounts
			console.warn(`Provided xUsername "${xUsername}" doesn't match configured accounts. Will validate from screenshot.`);
		} else {
			// If username matches, validate only that account
			accountsToValidate = [matchingAccount];
		}
	}

	// Use Gemini AI to validate the screenshot
	// Set SKIP_GEMINI_VALIDATION=true in environment to bypass AI validation (for testing)
	const skipGemini = process.env.SKIP_GEMINI_VALIDATION === "true";

	let analysisResult;
	let validatedAccount = accountsToValidate[0]; // Default to first account

	if (skipGemini) {
		// Mock successful response for testing/development
		analysisResult = {
			actionCompleted: true,
			confidence: 0.95,
			reason: "Mock validation - Gemini AI bypassed for testing",
		};
	} else {
		// Analyze screenshot with Gemini AI - check if user is following any of the configured accounts
		analysisResult = await GeminiAI.analyzeImageWithGemini(screenshot, "x", accountsToValidate);

		if (!analysisResult.actionCompleted) throw new Error("400:x_follow_not_verified");

		// Try to determine which account was validated (use first one for now, or enhance Gemini response)
		validatedAccount = accountsToValidate[0];
	}

	// Update record with X validation
	socialRecord.followedX = true;
	socialRecord.xUsername = validatedAccount.username || validatedAccount.displayName;
	await socialRecord.save();

	return {
		success: true,
		message: "X follow validated successfully",
		email: socialRecord.email,
		tagName: socialRecord.tagName,
		domain: socialRecord.domain,
		followedX: true,
		xUsername: socialRecord.xUsername,
		followedLinkedin: socialRecord.followedLinkedin,
		linkedInUsername: socialRecord.linkedInUsername,
		confidence: analysisResult.confidence,
	};
};

/**
 * Step 4: Validate LinkedIn follow
 * Analyzes screenshot using Gemini AI to verify user followed required LinkedIn account
 * @param {string} email - User email address
 * @param {string} tagName - Tag name
 * @param {string} domain - Domain
 * @param {string} screenshot - Base64 encoded screenshot image
 * @param {string} linkedInUsername - LinkedIn username or profile link
 * @param {Object} authUser - Authenticated user from JWT
 * @returns {Promise<Object>} Response with validation result
 */
const validateLinkedIn = async (email, tagName, domain, screenshot, linkedInUsername, authUser) => {
	const socialAccountsConfig = require("../config/social-accounts.config");

	const GeminiAI = require("./gemini-ai.module");

	// Find the social record
	const socialRecord = await Model.findOne({
		email,
		tagName,
		domain,
	});

	if (!socialRecord) throw new Error("404:social_record_not_found");

	if (!socialRecord.verified) throw new Error("400:email_must_be_verified_first");

	if (socialRecord.followedLinkedin) throw new Error("400:linkedin_already_validated");

	// Get LinkedIn accounts from config
	const linkedInAccounts = socialAccountsConfig.linkedin.accounts;

	if (!linkedInAccounts || linkedInAccounts.length === 0) {
		throw new Error("500:linkedin_accounts_not_configured");
	}

	// Always validate against configured accounts from the screenshot
	// linkedInUsername is required - it's the user's LinkedIn username, not the account they're following
	// The screenshot should show the user following Liza Van den Berg's LinkedIn profile
	const accountsToValidate = linkedInAccounts;

	// Use Gemini AI to validate the screenshot
	// Set SKIP_GEMINI_VALIDATION=true in environment to bypass AI validation (for testing)
	const skipGemini = process.env.SKIP_GEMINI_VALIDATION === "true";

	let analysisResult;
	let validatedAccount = accountsToValidate[0]; // Default to first account

	if (skipGemini) {
		// Mock successful response for testing/development
		analysisResult = {
			actionCompleted: true,
			confidence: 0.95,
			reason: "Mock validation - Gemini AI bypassed for testing",
		};
	} else {
		// Analyze screenshot with Gemini AI - check if user is following any of the configured accounts
		analysisResult = await GeminiAI.analyzeImageWithGemini(screenshot, "linkedin", accountsToValidate);

		if (!analysisResult.actionCompleted) {
			throw new Error("400:linkedin_follow_not_verified");
		}

		// Try to determine which account was validated (use first one for now, or enhance Gemini response)
		validatedAccount = accountsToValidate[0];
	}

	// Update record with LinkedIn validation
	socialRecord.followedLinkedin = true;
	// Save the user's LinkedIn username (required), not the account they're following
	// Extract username from LinkedIn URL if provided as link
	let userLinkedInUsername = linkedInUsername.trim();
	if (userLinkedInUsername.includes("linkedin.com/in/")) {
		userLinkedInUsername = userLinkedInUsername.split("linkedin.com/in/")[1].split("/")[0].split("?")[0];
	} else if (userLinkedInUsername.includes("linkedin.com/company/")) {
		userLinkedInUsername = userLinkedInUsername.split("linkedin.com/company/")[1].split("/")[0].split("?")[0];
	}
	socialRecord.linkedInUsername = userLinkedInUsername;
	await socialRecord.save();

	return {
		success: true,
		message: "LinkedIn follow validated successfully",
		email: socialRecord.email,
		tagName: socialRecord.tagName,
		domain: socialRecord.domain,
		followedX: socialRecord.followedX,
		xUsername: socialRecord.xUsername,
		followedLinkedin: true,
		linkedInUsername: socialRecord.linkedInUsername,
		confidence: analysisResult.confidence,
	};
};

/**
 * Get social campaign record by tagName and domain for authenticated user
 * @param {string} tagName - Tag name
 * @param {string} domain - Domain
 * @param {Object} authUser - Authenticated user from JWT
 * @returns {Promise<Object>} Social campaign record
 */
const getRecord = async (tagName, domain, authUser) => {
	// Find the social record for the authenticated user
	const socialRecord = await Model.findOne({
		tagName,
		domain,
	});

	if (!socialRecord) throw new Error("404:social_record_not_found");

	// Return record data (excluding sensitive OTP hash)
	return {
		email: socialRecord.email,
		tagName: socialRecord.tagName,
		domain: socialRecord.domain,
		verified: socialRecord.verified,
		attempts: socialRecord.attempts,
		maxAttempts: socialRecord.maxAttempts,
		expiresAt: socialRecord.expiresAt,
		followedX: socialRecord.followedX,
		xUsername: socialRecord.xUsername,
		followedLinkedin: socialRecord.followedLinkedin,
		linkedInUsername: socialRecord.linkedInUsername,
		createdAt: socialRecord.createdAt,
		updatedAt: socialRecord.updatedAt,
		status: socialRecord.status || "pending",
	};
};

/**
 * Get reward by tagName and domain for authenticated user
 * @param {string} tagName - Tag name
 * @param {string} domain - Domain
 * @param {Object} authUser - Authenticated user from JWT
 * @returns {Promise<Object>} Reward
 */
const getReward = async (tagName, domain, authUser) => {
	const socialRecord = await Model.findOne({
		tagName,
		domain,
	});

	if (!socialRecord) throw new Error("404:social_record_not_found");

	if (socialRecord.status === "approved") throw new Error("400:social_record_approved");

	if (socialRecord.status === "rejected") throw new Error("400:social_record_rejected");

	const tagResult = await TagsSearchModule.searchTag(
		{
			tagName,
			domain,
			environment: "all",
			type: "both",
		},
		authUser
	);

	if (!tagResult.tagObject) throw new Error("404:tag_not_found");

	const domainConfig = getDomainConfig(domain);

	const { tagObject: updatedTagObject } = await MyTagsModule.addDurationToTag(
		{
			tagName,
			duration: 1,
			domain,
			domainConfig,
		},
		tagResult.tagObject
	);

	socialRecord.status = "approved";

	await socialRecord.save();

	return {
		tagObject: updatedTagObject,
		socialRecord,
	};
};

module.exports = {
	provideEmail,
	validateOTP,
	validateX,
	validateLinkedIn,
	getRecord,
	generateOTP,
	sendOTPEmail,
	getReward,
};
