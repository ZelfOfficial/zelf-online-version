const crypto = require("crypto");
const config = require("../../../Core/config");
const { signToken, TOKEN_TYPES } = require("../../../Core/jwt-claims");
const moment = require("moment");
const IPFSModule = require("../../IPFS/modules/ipfs.module");
const zelfProofModule = require("../../ZelfProof/modules/zelf-proof.module");
const { generateMnemonic } = require("../../Wallet/modules/helpers");
const OfflineProofModule = require("../../../Core/offline-proof");
const axios = require("axios");
const sharp = require("sharp");
const { createEthWallet } = require("../../Wallet/modules/eth");
const { createSolanaWallet } = require("../../Wallet/modules/solana");
const { createBTCWallet } = require("../../Wallet/modules/btc");
const { generateSuiWalletFromMnemonic } = require("../../Wallet/modules/sui");
const IpfsLookupCache = require("../../../Core/ipfs-lookup-cache");

/**
 *
 * @param {Object} params
 * @param {Object} authUser
 * @returns
 */
const get = async (params = {}, authUser = {}) => {
	if (params.email) {
		return IpfsLookupCache.getOrLoad(IpfsLookupCache.keys.clientEmail(params.email), async () => {
			const emailRecord = await IPFSModule.get({ key: "accountEmail", value: params.email, limit: 1 });

			if (emailRecord.length) return emailRecord[0];

			const staffRecord = await IPFSModule.get({ key: "staffEmail", value: params.email, limit: 1 });

			return staffRecord.length ? staffRecord[0] : null;
		});
	}

	if (params.phone) {
		return IpfsLookupCache.getOrLoad(IpfsLookupCache.keys.clientPhone(params.phone), async () => {
			const phoneRecord = await IPFSModule.get({ key: "accountPhone", value: params.phone, limit: 1 });

			if (phoneRecord.length) return phoneRecord[0];

			const staffRecord = await IPFSModule.get({ key: "staffPhone", value: params.phone, limit: 1 });

			return staffRecord.length ? staffRecord[0] : null;
		});
	}

	// If no specific email/phone, return all client accounts with pagination
	const allClientAccounts = await IPFSModule.get({ key: "accountType", value: "client_account" });

	// Handle pagination if provided
	const page = params.page || 1;
	const limit = params.limit || 10;
	const offset = (page - 1) * limit;

	const paginatedResults = allClientAccounts;

	return {
		data: paginatedResults,
		pagination: {
			page,
			limit,
			total: allClientAccounts.length,
			totalPages: Math.ceil(allClientAccounts.length / limit),
			hasNext: offset + limit < allClientAccounts.length,
			hasPrev: page > 1,
		},
	};
};

/**
 * Staff Zelf record by `staffEmail` IPFS index only — does not use `accountEmail` first.
 * Needed so license/tag flows decrypt the staff zelfProof, not an org owner client that shares the same email lookup.
 * @param {string} email - Staff login email (matches staff invitation / staffEmail index)
 * @returns {Object|null}
 */
const getByStaffEmail = async (email) => {
	if (!email || !String(email).trim()) return null;

	const trimmed = String(email).trim();

	return IpfsLookupCache.getOrLoad(IpfsLookupCache.keys.clientStaffEmail(trimmed), async () => {
		const records = await IPFSModule.get({ key: "staffEmail", value: trimmed, limit: 1 });

		return records?.length ? records[0] : null;
	});
};

/**
 *
 * @param {Object} params
 * @param {Object} authUser
 * @returns
 */
const show = async (params = {}, authUser = {}) => {
	// Use IPFS-based approach instead of MongoDB
	// If specific email or phone is provided, get that specific account
	if (params.email) {
		const emailRecord = await IPFSModule.get({ key: "accountEmail", value: params.email });

		return emailRecord.length ? emailRecord[0] : null;
	}

	if (params.phone) {
		const phoneRecord = await IPFSModule.get({ key: "accountPhone", value: params.phone });

		return phoneRecord.length ? phoneRecord[0] : null;
	}

	// If no specific identifier, return all client accounts
	const allClientAccounts = await IPFSModule.get({ key: "accountType", value: "client_account" });

	// Handle pagination if provided
	const page = params.page || 1;
	const limit = params.limit || 10;
	const offset = (page - 1) * limit;

	const paginatedResults = allClientAccounts.slice(offset, offset + limit);

	return {
		data: paginatedResults,
		pagination: {
			page,
			limit,
			total: allClientAccounts.length,
			totalPages: Math.ceil(allClientAccounts.length / limit),
			hasNext: offset + limit < allClientAccounts.length,
			hasPrev: page > 1,
		},
	};
};

/**
 * client account creation
 * @param {Object} data
 * @returns
 * @author Miguel Trevino
 */
const create = async (data) => {
	// Clean country code to remove any flag emojis (e.g., "🇵🇦 +507" -> "+507")
	const cleanCountryCode = data.countryCode ? data.countryCode.replace(/^[^\d+]*/, "").trim() : data.countryCode;

	const emailRecord = await IPFSModule.get({ key: "accountEmail", value: data.email });

	if (emailRecord.length) throw new Error("403:email_already_exists");

	const phoneRecord = await IPFSModule.get({ key: "accountPhone", value: data.phone });

	if (phoneRecord.length) throw new Error("403:phone_already_exists");

	const apiKey = `zk_${crypto.randomBytes(12).toString("hex").slice(0, 24)}`;

	const zkProof = await OfflineProofModule.createProof(apiKey);

	const mnemonic = generateMnemonic(12);

	const { zelfProof } = await zelfProofModule.encrypt({
		publicData: {
			email: data.email,
			company: data.company,
			countryCode: cleanCountryCode,
			phone: data.phone,
		},
		faceBase64: data.faceBase64,
		metadata: {
			apiKey,
			zkProof,
			mnemonic,
		},
		password: data.masterPassword || undefined,
		identifier: data.email,
		requireLiveness: true,
		tolerance: data.tolerance || "REGULAR",
		verifierKey: config.zelfEncrypt.serverKey,
	});

	// Create JSON data structure for IPFS storage
	const clientData = {
		email: data.email,
		company: data.company,
		countryCode: data.countryCode,
		phone: data.phone,
		language: data.language || "en",
		zelfProof,
		createdAt: new Date().toISOString(),
		version: "1.0.0",
		name: data.name,
		hasPassword: data.masterPassword ? "true" : "false",
	};

	// Convert to JSON string and then to base64
	const jsonData = JSON.stringify(clientData, null, 2);

	const base64Data = Buffer.from(jsonData).toString("base64");

	// Pin the JSON data to IPFS
	const zelfAccount = await IPFSModule.insert(
		{
			base64: base64Data,
			metadata: {
				accountEmail: data.email,
				accountPhone: data.phone,
				accountCompany: data.company,
				accountCountryCode: cleanCountryCode,
				accountType: "client_account",
				accountSubscriptionId: "free",
			},
			name: `${data.email}.account`,
			pinIt: true,
		},
		{ pro: true }
	);

	zelfAccount.publicData = zelfAccount.keyvalues;

	delete zelfAccount.keyvalues;

	zelfAccount.publicData.name = data.name;

	IpfsLookupCache.invalidateClient({ email: data.email, phone: data.phone });

	const eth = createEthWallet(mnemonic);
	const btc = createBTCWallet(mnemonic);
	const solana = await createSolanaWallet(mnemonic);
	const sui = await generateSuiWalletFromMnemonic(mnemonic);

	return {
		zelfProof,
		zelfAccount,
		ipfsHash: zelfAccount.cid,
		wallet: {
			ethAddress: eth.address,
			btcAddress: btc.address,
			solanaAddress: solana.address,
			suiAddress: sui.address,
		},
		token: signToken(
			{
				email: data.email,
				zkProof,
				exp: moment().add(1, "day").unix(),
			},
			config.JWT_SECRET,
			{ typ: TOKEN_TYPES.client }
		),
	};
};

const update = async (data, authUser) => {
	const { name, email, countryCode, phone, company, faceBase64, masterPassword, accountPhoto } = data;

	const cleanCountryCode = countryCode ? countryCode.replace(/^[^\d+]*/, "").trim() : null;

	// validate if the email is taken and it's different from the current email
	const zelfAccount = await get({ email: authUser.email });

	const metadata = zelfAccount.publicData;

	// validate if the email is taken and it's different from the current email
	if (email && zelfAccount && metadata.accountEmail !== email) {
		const emailAccount = await get({ email });

		if (emailAccount) throw new Error("403:email_already_exists");
	}

	if (phone && zelfAccount && metadata.accountPhone !== phone) {
		const phoneAccount = await get({ phone });

		if (phoneAccount) throw new Error("403:phone_already_exists");
	}

	const accountJSON = await axios.get(zelfAccount.url);

	// Decrypt the current zelfAccount to validate biometrics
	const decryptedZelfAccount = await zelfProofModule.decrypt({
		zelfProof: accountJSON.data.zelfProof,
		faceBase64,
		verifierKey: config.zelfEncrypt.serverKey,
		password: masterPassword || undefined,
	});

	if (!decryptedZelfAccount) throw new Error("409:error_decrypting_zelf_account");

	// Handle accountPhoto upload if provided
	if (accountPhoto) {
		try {
			// accountPhoto should be base64 string
			const photoBuffer = Buffer.from(accountPhoto.replace(/^data:image\/\w+;base64,/, ""), "base64");

			// Compress and optimize image using sharp
			const compressedPhotoBuffer = await sharp(photoBuffer)
				.resize(800, 800, {
					fit: "inside",
					withoutEnlargement: true,
				})
				.jpeg({
					quality: 85,
					progressive: true,
				})
				.toBuffer();

			// Convert buffer to base64 for IPFS upload
			const compressedPhotoBase64 = compressedPhotoBuffer.toString("base64");

			// Upload compressed photo to IPFS
			const photoIpfsHash = await IPFSModule.insert(
				{
					base64: compressedPhotoBase64,
					name: `client-photo-${email || metadata.accountEmail}-${Date.now()}.jpg`,
					metadata: {
						type: "client_profile_photo",
						photoEmail: email || metadata.accountEmail,
						uploadedAt: new Date().toISOString(),
					},
					pinIt: true,
				},
				{ pro: true }
			);

			// update metadata
			metadata.accountPhoto = photoIpfsHash.id;
			metadata.accountPhotoUrl = photoIpfsHash.url;
		} catch (error) {
			console.error("Error uploading photo to IPFS:", error);
			throw new Error("Failed to upload photo to IPFS");
		}
	}

	// Unpin the previous IPFS record
	if (zelfAccount.id) {
		await IPFSModule.unPinFiles([zelfAccount.id]);
	}

	// Create updated client data (same structure as create method)
	const updatedClientData = {
		email: email || metadata.accountEmail,
		company: company || metadata.accountCompany,
		countryCode: cleanCountryCode || metadata.accountCountryCode,
		phone: phone || metadata.accountPhone,
		language: metadata.language || "en",
		zelfProof: accountJSON.data.zelfProof, // Keep the same zelfProof
		createdAt: metadata.createdAt || new Date().toISOString(),
		version: "1.0.0",
		name: name || metadata.accountName,
		hasPassword: metadata.hasPassword || "false",
		accountPhoto: metadata.accountPhoto,
		accountPhotoUrl: metadata.accountPhotoUrl,
	};

	// Convert to JSON string and then to base64
	const jsonData = JSON.stringify(updatedClientData, null, 2);

	const base64Data = Buffer.from(jsonData).toString("base64");

	// Create new IPFS record with updated data (same metadata structure as create)
	const newIpfsRecord = await IPFSModule.insert(
		{
			base64: base64Data,
			metadata: {
				accountEmail: updatedClientData.email,
				accountPhone: updatedClientData.phone,
				accountCompany: updatedClientData.company,
				accountCountryCode: updatedClientData.countryCode,
				accountType: "client_account",
				accountSubscriptionId: "free",
				accountName: updatedClientData.name,
				accountPhotoUrl: updatedClientData.accountPhotoUrl,
			},
			name: `${updatedClientData.email}.account`,
			pinIt: true,
		},
		{ pro: true }
	);

	IpfsLookupCache.invalidateClient({
		email: updatedClientData.email,
		previousEmail: metadata.accountEmail,
		phone: updatedClientData.phone,
		previousPhone: metadata.accountPhone,
	});

	// Return updated zelfAccount data
	return {
		zelfProof: accountJSON.data.zelfProof,
		zelfAccount: {
			...zelfAccount,
			ipfsHash: newIpfsRecord.IpfsHash,
			url: newIpfsRecord.url,
			publicData: newIpfsRecord.publicData,
		},
		ipfsHash: newIpfsRecord.IpfsHash,
		message: "Account updated successfully",
	};
};

const destroy = async (data, authUser) => {
	const { faceBase64, masterPassword } = data;
	const zelfAccount = await get({ email: authUser.email });

	if (!zelfAccount) throw new Error("404:client_not_found");

	const accountJSON = await axios.get(zelfAccount.url);

	const decryptedZelfAccount = await zelfProofModule.decrypt({
		zelfProof: accountJSON.data.zelfProof,
		faceBase64,
		verifierKey: config.zelfEncrypt.serverKey,
		password: masterPassword || undefined,
	});

	if (!decryptedZelfAccount) throw new Error("409:error_decrypting_zelf_account");

	// now we can delete the zelfAccount
	const deletedFiles = await IPFSModule.unPinFiles([zelfAccount.id]);

	IpfsLookupCache.invalidateClient({
		email: authUser.email,
		phone: zelfAccount.publicData?.accountPhone,
	});

	return {
		message: "Client deleted successfully",
		deletedFiles,
		zelfAccount,
	};
};

/**
 * authenticate a client
 * @param {Object} data
 * @param {Object} authUser
 * @returns {Object}
 */
const auth = async (data, authUser) => {
	const { email, countryCode, phone, faceBase64, masterPassword } = data;

	const zelfAccount = await get({ email, countryCode, phone });

	if (!zelfAccount) throw new Error("404:client_not_found");

	const accountJSON = await axios.get(zelfAccount.url);

	if (!accountJSON.data?.zelfProof) throw new Error("409:account_doesnt_contain_zelf_proof");

	const decryptedZelfAccount = await zelfProofModule.decrypt({
		zelfProof: accountJSON.data.zelfProof,
		faceBase64,
		verifierKey: config.zelfEncrypt.serverKey,
		password: masterPassword || undefined,
	});

	if (!decryptedZelfAccount) throw new Error("409:error_decrypting_zelf_account");

	zelfAccount.publicData.name = accountJSON.data.name || accountJSON.data.staffName;

	// Determine account type based on metadata
	const isStaffAccount = accountJSON.data.accountType === "staff";

	const accountType = isStaffAccount ? "staff_account" : "client_account";

	const eth = createEthWallet(decryptedZelfAccount.metadata.mnemonic);
	const btc = createBTCWallet(decryptedZelfAccount.metadata.mnemonic);
	const solana = await createSolanaWallet(decryptedZelfAccount.metadata.mnemonic);
	const sui = await generateSuiWalletFromMnemonic(decryptedZelfAccount.metadata.mnemonic);

	const staffEmailOnly = isStaffAccount ? (accountJSON.data.staffEmail || data.email) : null;

	const clientEmailLine =
		accountJSON.data.email || accountJSON.data.clientEmail || data.email;

	const jwtPayload = {
		accountType,
		solanaAddress: solana.address,
		phone: accountJSON.data.phone || accountJSON.data.staffPhone || accountJSON.data.clientPhone || data.phone,
		countryCode: accountJSON.data.countryCode || accountJSON.data.staffCountryCode || accountJSON.data.clientCountryCode || data.countryCode,
		exp: moment().add(30, "day").unix(),
	};

	if (isStaffAccount) {
		if (staffEmailOnly) {
			jwtPayload.email = staffEmailOnly;
			jwtPayload.staffEmail = staffEmailOnly;
		}
		// Dashboard PermissionService / RBAC: staff default to "read" if omitted — must match invitation JSON or metadata
		const staffRole =
			accountJSON.data.role || decryptedZelfAccount?.metadata?.staffRole || decryptedZelfAccount?.metadata?.role;
		if (staffRole) {
			jwtPayload.role = staffRole;
		}
		const ownerEmailForStaff =
			accountJSON.data.ownerEmail ||
			accountJSON.data.staffOwnerEmail ||
			decryptedZelfAccount?.metadata?.ownerEmail;
		if (ownerEmailForStaff) {
			jwtPayload.ownerEmail = ownerEmailForStaff;
		}
	} else {
		jwtPayload.email = clientEmailLine;
	}

	return {
		wallet: {
			ethAddress: eth.address,
			btcAddress: btc.address,
			solanaAddress: solana.address,
			suiAddress: sui.address,
		},
		zelfProof: accountJSON.data.zelfProof,
		zelfAccount,
		ipfsHash: zelfAccount.cid,
		zkProof: decryptedZelfAccount.metadata.zkProof,
		apiKey: decryptedZelfAccount.metadata.apiKey,
		token: signToken(jwtPayload, config.JWT_SECRET, { typ: isStaffAccount ? TOKEN_TYPES.staff : TOKEN_TYPES.client }),
	};
};

/**
 * Update client password
 * @param {Object} data
 * @param {Object} authUser
 * @returns {Object}
 */
const updatePassword = async (data, authUser) => {
	const { newPassword, confirmPassword, faceBase64, masterPassword } = data;

	// Verify passwords match (this should already be validated in middleware, but double-check)
	if (newPassword !== confirmPassword) {
		throw new Error("409:passwords_do_not_match");
	}

	// Get the current client account
	const zelfAccount = await get({ email: authUser.email });

	if (!zelfAccount) throw new Error("404:client_not_found");

	const accountJSON = await axios.get(zelfAccount.url);

	if (!accountJSON.data?.zelfProof) throw new Error("409:account_doesnt_contain_zelf_proof");

	const metadata = zelfAccount.publicData;

	// Decrypt the current zelfAccount to verify master password and get current data
	const decryptedZelfAccount = await zelfProofModule.decrypt({
		zelfProof: accountJSON.data.zelfProof,
		faceBase64,
		verifierKey: config.zelfEncrypt.serverKey,
		password: masterPassword,
	});

	if (!decryptedZelfAccount) throw new Error("409:verification_failed");

	// Update the password in the decrypted account data
	const updatedAccountData = {
		...decryptedZelfAccount,
		metadata: {
			...decryptedZelfAccount.metadata,
			hasPassword: "true",
		},
	};

	// Re-encrypt the account with the new password
	const { zelfProof } = await zelfProofModule.encrypt({
		publicData: {
			email: metadata.accountEmail,
			company: metadata.accountCompany,
			countryCode: metadata.accountCountryCode,
			phone: metadata.accountPhone,
		},
		metadata: decryptedZelfAccount.metadata,
		identifier: metadata.accountEmail,
		faceBase64,
		verifierKey: config.zelfEncrypt.serverKey,
		password: newPassword,
	});

	zelfAccount.publicData.name = accountJSON.data.name || accountJSON.data.staffName;

	// get the data from the JSON inside the zelfAccount.url
	const _jsonData = await axios.get(zelfAccount.url);

	const ZelfAccount_JSON = _jsonData.data;

	const newZelfAccountJSON = {
		...metadata,
		...ZelfAccount_JSON,
		zelfProof,
		hasPassword: "true",
	};

	// delete the previous ipfs record
	await IPFSModule.unPinFiles([zelfAccount.id]);

	// Convert to JSON string and then to base64
	const jsonData = JSON.stringify(newZelfAccountJSON, null, 2);

	const base64Data = Buffer.from(jsonData).toString("base64");

	// Create new IPFS record with updated data
	const newIpfsRecord = await IPFSModule.insert(
		{
			base64: base64Data,
			metadata,
			name: `${authUser.email}.account`,
			pinIt: true,
		},
		{ pro: true }
	);

	IpfsLookupCache.invalidateClient({
		email: authUser.email,
		phone: metadata.accountPhone,
	});

	// Return updated zelfAccount data
	return {
		zelfProof,
		zelfAccount: {
			...zelfAccount,
			ipfsHash: newIpfsRecord.IpfsHash,
			url: newIpfsRecord.url,
			publicData: newIpfsRecord.publicData,
		},
		ipfsHash: newIpfsRecord.IpfsHash,
		message: "Password updated successfully",
	};
};

module.exports = {
	get,
	getByStaffEmail,
	show,
	create,
	update,
	destroy,
	auth,
	updatePassword,
};
