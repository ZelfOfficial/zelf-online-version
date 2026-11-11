const jwt = require("jsonwebtoken");
const config = require("../../../Core/config");
const { signToken, TOKEN_TYPES } = require("../../../Core/jwt-claims");
const moment = require("moment");
const IPFSModule = require("../../IPFS/modules/ipfs.module");
const zelfProofModule = require("../../ZelfProof/modules/zelf-proof.module");
const { generateMnemonic } = require("../../Wallet/modules/helpers");
const axios = require("axios");
const ClientModule = require("../../Client/modules/client.module");
const Mailgun = require("../../../Core/mailgun");
const { createEthWallet } = require("../../Wallet/modules/eth");
const { createSolanaWallet } = require("../../Wallet/modules/solana");

const LAWYER_TYPE = "lawyer";
const LAWYER_ACCOUNT_TYPE = "lawyer_account";

/**
 * Get lawyers for a domain (domain admin view)
 * @param {Object} params - { domain }
 * @param {Object} authUser - JWT user
 * @returns {Array}
 */
const get = async (params = {}, authUser = {}) => {
	const { domain = "zelf", status } = params;

	const records = await IPFSModule.get({ key: "lawyerDomain", value: domain });

	const lawyers = records.filter((r) => {
		if (r.publicData?.type !== LAWYER_TYPE) return false;
		if (status && r.publicData?.lawyerStatus !== status) return false;
		return true;
	});

	return lawyers;
};

/**
 * Search lawyers (public)
 * @param {Object} params - q, domain, city, country, maxRate, license, professionalId, walletAddress, zelfName
 * @returns {Object} - { count, data }
 */
const search = async (params = {}) => {
	const { q, domain = "zelf", license, professionalId, walletAddress, zelfName, city, country, maxRate } = params;

	// Exact match searches first
	if (zelfName) {
		const records = await IPFSModule.get({ key: "lawyerZelfName", value: zelfName });
		const filtered = records.filter((r) => r.publicData?.type === LAWYER_TYPE);
		return { count: filtered.length, data: filtered };
	}

	if (license) {
		const records = await IPFSModule.get({ key: "lawyerLicenseNumber", value: license });
		const filtered = records.filter((r) => r.publicData?.type === LAWYER_TYPE);
		return { count: filtered.length, data: filtered };
	}

	if (walletAddress) {
		const records = await IPFSModule.get({ key: "lawyerWalletAddress", value: walletAddress.toLowerCase() });
		const filtered = records.filter((r) => r.publicData?.type === LAWYER_TYPE);
		return { count: filtered.length, data: filtered };
	}

	if (professionalId) {
		const records = await IPFSModule.get({ key: "lawyerProfessionalId", value: professionalId });
		const filtered = records.filter((r) => r.publicData?.type === LAWYER_TYPE);
		return { count: filtered.length, data: filtered };
	}

	// Domain-wide fetch with optional text filtering
	const allRecords = await IPFSModule.get({ key: "lawyerDomain", value: domain });

	let lawyers = allRecords.filter((r) => r.publicData?.type === LAWYER_TYPE && r.publicData?.lawyerStatus === "active");

	if (q) {
		const regex = new RegExp(q, "i");
		lawyers = lawyers.filter((r) => {
			const pd = r.publicData || {};
			return (
				regex.test(pd.lawyerName || "") ||
				regex.test(pd.lawyerSpecialization || "") ||
				regex.test(pd.lawyerEducation || "") ||
				regex.test(pd.lawyerZelfName || "") ||
				regex.test(r.name || "")
			);
		});
	}

	if (city) {
		const cityRegex = new RegExp(city, "i");
		lawyers = lawyers.filter((r) => cityRegex.test(r.publicData?.lawyerCity || ""));
	}

	if (country) {
		const countryRegex = new RegExp(country, "i");
		lawyers = lawyers.filter((r) => countryRegex.test(r.publicData?.lawyerCountry || ""));
	}

	if (maxRate) {
		const max = Number(maxRate);
		lawyers = lawyers.filter((r) => {
			const rate = Number(r.publicData?.lawyerHourlyRate || 0);
			return rate <= max;
		});
	}

	return { count: lawyers.length, data: lawyers.slice(0, 50) };
};

/**
 * Get lawyer by zelfName (public)
 * @param {string} zelfName
 * @returns {Object|null}
 */
const getByZelfName = async (zelfName) => {
	const records = await IPFSModule.get({ key: "lawyerZelfName", value: zelfName });
	const filtered = records.filter((r) => r.publicData?.type === LAWYER_TYPE);

	if (!filtered.length) return null;

	const lawyer = filtered[0];

	try {
		const jsonResponse = await axios.get(lawyer.url);
		lawyer.profile = jsonResponse.data;
	} catch (error) {
		console.error("Error fetching lawyer JSON:", error.message);
	}

	return lawyer;
};

/**
 * Get current lawyer profile (authenticated)
 * @param {Object} authUser - JWT user
 * @returns {Object}
 */
const getMyProfile = async (authUser) => {
	const records = await IPFSModule.get({ key: "lawyerEmail", value: authUser.email });
	const lawyerRecord = records.find((r) => r.publicData?.accountType === LAWYER_ACCOUNT_TYPE);

	if (!lawyerRecord) throw new Error("404:lawyer_not_found");

	try {
		const jsonResponse = await axios.get(lawyerRecord.url);
		lawyerRecord.profile = jsonResponse.data;
	} catch (error) {
		console.error("Error fetching lawyer JSON:", error.message);
	}

	return lawyerRecord;
};

/**
 * Generate invitation for a lawyer to join a domain
 * @param {Object} data - { lawyerEmail, lawyerPhone, lawyerName, faceBase64, masterPassword, domain }
 * @param {Object} authUser - JWT user (domain admin)
 * @returns {Object}
 */
const generateInvitation = async (data, authUser) => {
	const { lawyerEmail, lawyerPhone, lawyerCountryCode, lawyerName, faceBase64, masterPassword, domain = "zelf" } = data;

	const clientAccount = await ClientModule.get({ email: authUser.email });
	if (!clientAccount) throw new Error("404:client_not_found");

	const accountJSON = await axios.get(clientAccount.url);

	let decryptedAccount;
	try {
		decryptedAccount = await zelfProofModule.decrypt({
			zelfProof: accountJSON.data.zelfProof,
			faceBase64,
			verifierKey: config.zelfEncrypt.serverKey,
			password: masterPassword || undefined,
		});
	} catch (error) {
		if (error.message?.includes("LIVENESS")) throw new Error(`400:${error.message}`);
		throw error;
	}

	if (!decryptedAccount) throw new Error("409:verification_failed");

	const zkProof = decryptedAccount.metadata.zkProof;
	const apiKey = decryptedAccount.metadata.apiKey;
	const company = clientAccount.publicData.accountCompany || "Zelf";
	const ownerName = accountJSON.data.name || authUser.name || "Admin";

	// Check for existing lawyer
	const existingRecords = await IPFSModule.get({ key: "lawyerEmail", value: lawyerEmail });
	const activeLawyer = existingRecords.find((r) => r.publicData?.accountType === LAWYER_ACCOUNT_TYPE);
	if (activeLawyer) throw new Error("403:lawyer_already_exists");

	const invitationToken = signToken(
		{
			type: "lawyer_invitation",
			ownerEmail: authUser.email,
			ownerCompany: company,
			domain,
			lawyerEmail,
			lawyerPhone,
			lawyerCountryCode,
			lawyerName,
			zkProof,
			apiKey,
			exp: moment().add(24, "hours").unix(),
		},
		config.JWT_SECRET,
		{ typ: TOKEN_TYPES.lawyerInvitation },
	);

	const invitationData = {
		ownerEmail: authUser.email,
		lawyerEmail,
		lawyerPhone,
		lawyerCountryCode,
		lawyerName,
		domain,
		status: "pending",
		createdAt: new Date().toISOString(),
		expiresAt: moment().add(24, "hours").toISOString(),
	};

	const jsonData = JSON.stringify(invitationData, null, 2);
	const base64Data = Buffer.from(jsonData).toString("base64");

	// Cleanup old pending invitations
	const pendingInvitations = existingRecords.filter((r) => r.publicData?.invitationStatus === "pending");
	if (pendingInvitations.length > 0) {
		await IPFSModule.unPinFiles(pendingInvitations.map((r) => r.id)).catch((e) => console.warn("Failed to unpin:", e.message));
	}

	await IPFSModule.insert(
		{
			base64: base64Data,
			metadata: {
				invitationType: "lawyer_invitation",
				lawyerDomain: domain,
				lawyerEmail,
				lawyerName,
				invitationStatus: "pending",
			},
			name: `${lawyerEmail}.lawyer-invitation`,
			pinIt: true,
		},
		{ pro: true },
	);

	const inviteLink = `${config.stripe?.frontendUrl || "https://dashboard.zelf.world"}/auth/accept-lawyer-invite?token=${invitationToken}`;

	try {
		await Mailgun.sendCustomEmail(
			lawyerEmail,
			"staff_invitation",
			{
				recipientName: lawyerName,
				staffName: lawyerName,
				ownerName,
				companyName: company,
				inviteLink,
				role: "lawyer",
				subject: `You've been invited as a Lawyer on ${domain}`,
				greeting: `Hello ${lawyerName},`,
				sincerely: "Best regards,",
				projectName: "Zelf",
			},
			"en",
		);
	} catch (emailError) {
		console.error("Error sending lawyer invitation email:", emailError);
	}

	return {
		invitationToken,
		expiresAt: invitationData.expiresAt,
		lawyerEmail,
		lawyerName,
		domain,
	};
};

/**
 * Validate a lawyer invitation token
 * @param {string} token
 * @returns {Object}
 */
const validateInvitation = async (token) => {
	try {
		const decoded = jwt.verify(token, config.JWT_SECRET);
		if (decoded.type !== "lawyer_invitation") throw new Error("401:invalid_invitation_type");

		const existingRecords = await IPFSModule.get({ key: "lawyerEmail", value: decoded.lawyerEmail });
		const isAlreadyRegistered = existingRecords.some((r) => r.publicData?.accountType === LAWYER_ACCOUNT_TYPE);

		return { ...decoded, isAlreadyRegistered };
	} catch (error) {
		if (error.message?.includes("invalid_invitation_type")) throw error;
		throw new Error("401:invalid_or_expired_invitation");
	}
};

/**
 * Create lawyer account from invitation
 * @param {Object} data - { invitationToken, faceBase64, masterPassword }
 * @returns {Object}
 */
const createFromInvitation = async (data) => {
	const { invitationToken, faceBase64, masterPassword } = data;

	let invitation;
	try {
		invitation = jwt.verify(invitationToken, config.JWT_SECRET);
	} catch (error) {
		throw new Error("401:invalid_or_expired_invitation");
	}

	if (invitation.type !== "lawyer_invitation") throw new Error("401:invalid_invitation_type");

	const existingRecords = await IPFSModule.get({ key: "lawyerEmail", value: invitation.lawyerEmail });
	const activeLawyer = existingRecords.find((r) => r.publicData?.accountType === LAWYER_ACCOUNT_TYPE);
	if (activeLawyer) throw new Error("403:lawyer_already_exists");

	const mnemonic = generateMnemonic(12);

	let zelfProof;

	const eth = createEthWallet(mnemonic);
	const solana = await createSolanaWallet(mnemonic);

	try {
		const encResult = await zelfProofModule.encrypt({
			publicData: {
				role: "lawyer",
				ethAddress: eth.address,
				solanaAddress: solana.address,
			},
			faceBase64,
			metadata: {
				mnemonic,
			},
			password: masterPassword,
			identifier: invitation.lawyerEmail,
			requireLiveness: true,
			tolerance: "REGULAR",
		});
		zelfProof = encResult.zelfProof;
	} catch (error) {
		if (error.message?.includes("LIVENESS")) throw new Error(`400:${error.message}`);
		throw error;
	}


	const lawyerData = {
		email: invitation.lawyerEmail,
		phone: invitation.lawyerPhone,
		countryCode: invitation.lawyerCountryCode,
		name: invitation.lawyerName,
		company: invitation.ownerCompany,
		domain: invitation.domain,
		ownerEmail: invitation.ownerEmail,
		walletAddress: eth.address.toLowerCase(),
		zelfProof,
		createdAt: new Date().toISOString(),
		version: "1.0.0",
		hasPassword: masterPassword ? "true" : "false",
		accountType: "lawyer",
		status: "active",
	};

	const jsonData = JSON.stringify(lawyerData, null, 2);
	const base64Data = Buffer.from(jsonData).toString("base64");

	// Pinata allows max 9 key-values per pin.
	const lawyerAccount = await IPFSModule.insert(
		{
			base64: base64Data,
			metadata: {
				type: LAWYER_TYPE,
				accountType: LAWYER_ACCOUNT_TYPE,
				lawyerEmail: invitation.lawyerEmail,
				lawyerName: invitation.lawyerName,
				lawyerDomain: invitation.domain,
				lawyerWalletAddress: eth.address.toLowerCase(),
				lawyerStatus: "active",
			},
			name: `${invitation.lawyerEmail}.lawyer`,
			pinIt: true,
		},
		{ pro: true },
	);

	if (!lawyerAccount) {
		throw new Error("500:Failed to create lawyer account. Please try again.");
	}

	lawyerAccount.publicData = lawyerAccount.keyvalues;
	delete lawyerAccount.keyvalues;

	// Cleanup invitations
	const invitationsToDelete = existingRecords.filter((r) => r.publicData?.invitationStatus === "pending" || r.name?.endsWith(".lawyer-invitation"));
	if (invitationsToDelete.length > 0) {
		await IPFSModule.unPinFiles(invitationsToDelete.map((r) => r.id)).catch((e) => console.warn("Failed to unpin invitations:", e.message));
	}

	return {
		zelfProof,
		lawyerAccount,
		ipfsHash: lawyerAccount.cid,
		wallet: {
			ethAddress: eth.address,
			solanaAddress: solana.address,
		},
		token: signToken(
			{
				email: invitation.lawyerEmail,
				domain: invitation.domain,
				ownerEmail: invitation.ownerEmail,
				accountType: "lawyer",
				walletAddress: eth.address.toLowerCase(),
				exp: moment().add(30, "day").unix(),
			},
			config.JWT_SECRET,
			{ typ: TOKEN_TYPES.lawyer },
		),
	};
};

/**
 * Authenticate lawyer
 * @param {Object} data - { email, faceBase64, masterPassword }
 * @returns {Object}
 */
const auth = async (data) => {
	const { email, faceBase64, masterPassword } = data;

	const records = await IPFSModule.get({ key: "lawyerEmail", value: email });
	const lawyerAccount = records.find((r) => r.publicData?.accountType === LAWYER_ACCOUNT_TYPE);

	if (!lawyerAccount) throw new Error("404:lawyer_not_found");

	const accountJSON = await axios.get(lawyerAccount.url);
	if (!accountJSON.data?.zelfProof) throw new Error("409:account_doesnt_contain_zelf_proof");

	const decryptedAccount = await zelfProofModule.decrypt({
		zelfProof: accountJSON.data.zelfProof,
		faceBase64,
		password: masterPassword || undefined,
	});

	if (!decryptedAccount) throw new Error("409:error_decrypting_zelf_account");

	return {
		zelfProof: accountJSON.data.zelfProof,
		lawyerAccount,
		ipfsHash: lawyerAccount.cid,
		zkProof: decryptedAccount.metadata.zkProof,
		apiKey: decryptedAccount.metadata.apiKey,
		token: signToken(
			{
				email,
				domain: accountJSON.data.domain || decryptedAccount.metadata.lawyerDomain,
				ownerEmail: decryptedAccount.metadata.ownerEmail,
				accountType: "lawyer",
				walletAddress: accountJSON.data.walletAddress,
				exp: moment().add(30, "day").unix(),
			},
			config.JWT_SECRET,
			{ typ: TOKEN_TYPES.lawyer },
		),
	};
};

/**
 * Update lawyer profile (specialization, license, bio, etc.)
 * @param {Object} data
 * @param {Object} authUser - JWT user
 * @returns {Object}
 */
const updateProfile = async (data, authUser) => {
	const { faceBase64, masterPassword, name, phone, countryCode, specialization, education, location, bio, hourlyRate, licenseNumber, professionalId, zelfName, contactEmail } =
		data;

	const records = await IPFSModule.get({ key: "lawyerEmail", value: authUser.email });

	const lawyerAccount = records.find((r) => r.publicData?.accountType === LAWYER_ACCOUNT_TYPE);

	if (!lawyerAccount) throw new Error("404:lawyer_not_found");

	const accountJSON = await axios.get(lawyerAccount.url);

	const decryptedAccount = await zelfProofModule.decrypt({
		zelfProof: accountJSON.data.zelfProof,
		faceBase64,
		password: masterPassword || undefined,
	});

	if (!decryptedAccount) throw new Error("409:error_decrypting_zelf_account");

	// Check uniqueness for zelfName and licenseNumber
	if (zelfName && zelfName !== lawyerAccount.publicData?.lawyerZelfName) {
		const existing = await IPFSModule.get({ key: "lawyerZelfName", value: zelfName });
		if (existing.length > 0) throw new Error("409:zelf_name_already_taken");
	}

	if (licenseNumber && licenseNumber !== lawyerAccount.publicData?.lawyerLicenseNumber) {
		const existing = await IPFSModule.get({ key: "lawyerLicenseNumber", value: licenseNumber });
		if (existing.length > 0) throw new Error("409:license_number_already_taken");
	}

	const updatedData = {
		...accountJSON.data,
		name: name || accountJSON.data.name,
		phone: phone !== undefined ? phone : accountJSON.data.phone,
		countryCode: countryCode !== undefined ? countryCode : accountJSON.data.countryCode,
		specialization: specialization || accountJSON.data.specialization,
		education: education || accountJSON.data.education,
		location: location || accountJSON.data.location,
		bio: bio || accountJSON.data.bio,
		hourlyRate: hourlyRate !== undefined ? hourlyRate : accountJSON.data.hourlyRate,
		licenseNumber: licenseNumber || accountJSON.data.licenseNumber,
		professionalId: professionalId || accountJSON.data.professionalId,
		zelfName: zelfName || accountJSON.data.zelfName,
		contactEmail: contactEmail || accountJSON.data.contactEmail,
		updatedAt: new Date().toISOString(),
	};

	const jsonStr = JSON.stringify(updatedData, null, 2);
	const base64Data = Buffer.from(jsonStr).toString("base64");

	await IPFSModule.unPinFiles([lawyerAccount.id]);

	// Pinata allows max 9 key-values per pin. Keep only keys used for queries.
	const newRecord = await IPFSModule.insert(
		{
			base64: base64Data,
			metadata: {
				type: LAWYER_TYPE,
				accountType: LAWYER_ACCOUNT_TYPE,
				lawyerEmail: authUser.email,
				lawyerDomain: updatedData.domain || lawyerAccount.publicData?.lawyerDomain || "zelf",
				lawyerZelfName: zelfName || lawyerAccount.publicData?.lawyerZelfName || "",
				lawyerWalletAddress: updatedData.walletAddress || lawyerAccount.publicData?.lawyerWalletAddress,
				lawyerLicenseNumber: licenseNumber || lawyerAccount.publicData?.lawyerLicenseNumber || "",
				lawyerProfessionalId: professionalId || lawyerAccount.publicData?.lawyerProfessionalId || "",
				lawyerName: name || lawyerAccount.publicData?.lawyerName || "",
			},
			name: `${authUser.email}.lawyer`,
			pinIt: true,
		},
		{ pro: true },
	);

	if (!newRecord) {
		throw new Error("500:Failed to update lawyer profile. Please try again.");
	}

	return {
		success: true,
		lawyerAccount: {
			...newRecord,
			publicData: newRecord.keyvalues || newRecord.publicData,
		},
		zelfProof: accountJSON.data.zelfProof,
	};
};

/**
 * Set preferred lawyers for a domain
 * @param {Object} data - { domain, preferredLawyerZelfNames[], defaultLawyerZelfName }
 * @param {Object} authUser
 * @returns {Object}
 */
const setPreferred = async (data, authUser) => {
	const { domain = "zelf", preferredLawyerZelfNames = [], defaultLawyerZelfName } = data;

	const prefsData = {
		domain,
		preferredLawyerZelfNames,
		defaultLawyerZelfName: defaultLawyerZelfName || (preferredLawyerZelfNames.length ? preferredLawyerZelfNames[0] : null),
		updatedBy: authUser.email,
		updatedAt: new Date().toISOString(),
	};

	// Unpin old preferences
	const existing = await IPFSModule.get({ key: "preferencesDomain", value: domain });
	const ownerPrefs = existing.filter((r) => r.publicData?.preferencesOwner === authUser.email);
	if (ownerPrefs.length > 0) {
		await IPFSModule.unPinFiles(ownerPrefs.map((r) => r.id)).catch((e) => console.warn(e.message));
	}

	const jsonStr = JSON.stringify(prefsData, null, 2);
	const base64Data = Buffer.from(jsonStr).toString("base64");

	const record = await IPFSModule.insert(
		{
			base64: base64Data,
			metadata: {
				type: "lawyer_preferences",
				preferencesDomain: domain,
				preferencesOwner: authUser.email,
			},
			name: `${authUser.email}.lawyer-preferences`,
			pinIt: true,
		},
		{ pro: true },
	);

	return { success: true, preferences: prefsData, ipfsHash: record.cid };
};

/**
 * Get preferred lawyers for a domain
 * @param {Object} params - { domain }
 * @param {Object} authUser
 * @returns {Object}
 */
const getPreferred = async (params = {}, authUser = {}) => {
	const { domain = "zelf" } = params;

	const existing = await IPFSModule.get({ key: "preferencesDomain", value: domain });

	// User-specific preferences first, then domain-wide
	let prefs = existing.find((r) => r.publicData?.preferencesOwner === authUser.email);

	if (!prefs && existing.length > 0) {
		prefs = existing[0];
	}

	if (!prefs) {
		return { preferredLawyerZelfNames: [], defaultLawyerZelfName: null };
	}

	try {
		const jsonResponse = await axios.get(prefs.url);
		return jsonResponse.data;
	} catch (error) {
		console.error("Error fetching preferences:", error.message);
		return { preferredLawyerZelfNames: [], defaultLawyerZelfName: null };
	}
};

/**
 * Remove a lawyer (domain admin only)
 * @param {Object} data - { lawyerEmail, faceBase64, masterPassword }
 * @param {Object} authUser
 * @returns {Object}
 */
const remove = async (data, authUser) => {
	const { lawyerEmail, faceBase64, masterPassword } = data;

	const clientAccount = await ClientModule.get({ email: authUser.email });
	if (!clientAccount) throw new Error("404:client_not_found");

	const clientJSON = await axios.get(clientAccount.url);

	const decryptedClient = await zelfProofModule.decrypt({
		zelfProof: clientJSON.data.zelfProof,
		faceBase64,
		password: masterPassword || undefined,
	});

	if (!decryptedClient) throw new Error("409:verification_failed");

	const records = await IPFSModule.get({ key: "lawyerEmail", value: lawyerEmail });
	if (!records.length) throw new Error("404:lawyer_not_found");

	const lawyerAccount = records.find((r) => r.publicData?.accountType === LAWYER_ACCOUNT_TYPE);
	if (!lawyerAccount) throw new Error("404:lawyer_not_found");

	await IPFSModule.unPinFiles([lawyerAccount.id]);

	return { success: true, message: "Lawyer removed successfully", lawyerEmail };
};

/**
 * Get pending invitations for a domain
 * @param {Object} params - { domain }
 * @param {Object} authUser - JWT user
 * @returns {Array}
 */
const getInvitations = async (params = {}, authUser = {}) => {
	const { domain = "zelf" } = params;

	const records = await IPFSModule.get({ key: "lawyerDomain", value: domain });

	const invitations = records.filter((r) => {
		return r.publicData?.invitationType === "lawyer_invitation" && r.publicData?.invitationStatus === "pending";
	});

	return invitations;
};

/**
 * Get lawyers + pending invitations combined for a domain (admin view)
 * @param {Object} params - { domain, includeInvitations }
 * @param {Object} authUser - JWT user
 * @returns {Object} - { lawyers, invitations }
 */
const getAll = async (params = {}, authUser = {}) => {
	const { domain = "zelf", includeInvitations = true } = params;

	const records = await IPFSModule.get({ key: "lawyerDomain", value: domain });

	const lawyers = records.filter((r) => r.publicData?.type === LAWYER_TYPE);

	const invitations = includeInvitations
		? records.filter((r) => r.publicData?.invitationType === "lawyer_invitation" && r.publicData?.invitationStatus === "pending")
		: [];

	return { lawyers, invitations };
};

module.exports = {
	get,
	getAll,
	search,
	getByZelfName,
	getMyProfile,
	generateInvitation,
	validateInvitation,
	createFromInvitation,
	auth,
	updateProfile,
	setPreferred,
	getPreferred,
	getInvitations,
	remove,
};
