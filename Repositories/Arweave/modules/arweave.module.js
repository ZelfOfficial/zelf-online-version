const { TurboFactory, USD, WinstonToTokenAmount, productionTurboConfiguration } = require("@ardrive/turbo-sdk");
const Arweave = require("arweave");
const fs = require("fs");
const path = require("path");
const config = require("../../../Core/config");
const {
	resolveContentUrl,
	buildExplorerUrl,
	postGraphql,
	fetchTxAsBase64Png,
} = require("./arweave-gateway.module");

const owner = config.arwave.env === "development" ? config.arwave.hold.owner : config.arwave.owner;

const zelfNameRegistration = async (zelfProofQRCode, zelfNameObject) => {
	const { zelfProof, hasPassword, publicData } = zelfNameObject;

	const env = config.arwave.env;

	/**
	 * Generate a key from the arweave wallet.
	 */

	const jwk = {
		kty: "RSA",
		n: env === "development" ? config.arwave.hold.n : config.arwave.n,
		e: env === "development" ? config.arwave.hold.e : config.arwave.e,
		d: env === "development" ? config.arwave.hold.d : config.arwave.d,
		p: env === "development" ? config.arwave.hold.p : config.arwave.p,
		q: env === "development" ? config.arwave.hold.q : config.arwave.q,
		dp: env === "development" ? config.arwave.hold.dp : config.arwave.dp,
		dq: env === "development" ? config.arwave.hold.dq : config.arwave.dq,
		qi: env === "development" ? config.arwave.hold.qi : config.arwave.qi,
		kid: "2011-04-29",
	};

	/**
	 * Use the arweave key to create an authenticated turbo client
	 */
	const turboAuthClient = TurboFactory.authenticated({
		privateKey: jwk,
		...productionTurboConfiguration,
	});

	// Convert base64 string to a buffer
	const base64Data = zelfProofQRCode.replace(/^data:image\/\w+;base64,/, "");

	const buffer = Buffer.from(base64Data, "base64");

	const fileSize = buffer.length;

	const tempFilePath = path.join(__dirname, `${zelfNameObject.zelfName}.png`);

	fs.writeFileSync(tempFilePath, buffer);

	const tags = [
		{
			name: "Content-Type",
			value: "image/png",
		},
		{
			name: "zelfProof",
			value: zelfProof,
		},
	];

	if (hasPassword) {
		tags.push({
			name: "hasPassword",
			value: hasPassword,
		});
	}

	const publicKeys = Object.keys(publicData);

	for (let index = 0; index < publicKeys.length; index++) {
		const publicKey = publicKeys[index];

		if (publicKey === "zelfProof" || publicKey === "hasPassword") {
			continue;
		}

		tags.push({
			name: publicKey,
			value: `${publicData[publicKey]}`,
		});
	}

	// if the size is greater than 100kb, we need to skip the upload
	if (fileSize > 100 * 1024) {
		console.info("skipping upload because the file size is greater than 100kb", {
			fileInKb: fileSize / 1024,
			fileInMb: fileSize / 1024 / 1024,
		});

		return {
			skipped: true,
		};
	}

	const uploadResult = await turboAuthClient.uploadFile({
		fileStreamFactory: () => fs.createReadStream(tempFilePath),
		fileSizeFactory: () => fileSize,
		dataItemOpts: {
			tags,
		},
	});

	// Clean up the temporary file after upload
	fs.unlinkSync(tempFilePath);

	return {
		...uploadResult,
		url: await resolveContentUrl(uploadResult.id),
		explorerUrl: buildExplorerUrl(uploadResult.id),
	};
};

const search = async (queryParams = {}) => {
	if (!queryParams.key || !queryParams.value) return null;

	const tagsToSearch = `[{ name: "${queryParams.key}", values: "${queryParams.value}" }]`;

	const queryString = `
    {
 		transactions(
			tags: ${tagsToSearch},
			owners: ["${owner}"]
		) {
			edges {
				node {
					id
					owner {
						address
					}
					data {
						size
						type
					}
					tags {
						name
						value
					}
				}
			}
		}
	}
  `;

	const searchResults = await postGraphql(queryString);

	if (!searchResults || !searchResults.length) {
		return {
			...queryParams,
			available: true,
		};
	}

	return searchResults;
};

const arweaveIDToBase64 = async (id) => {
	try {
		return await fetchTxAsBase64Png(id);
	} catch (exception) {
		console.error({ VWEx: exception });

		return exception?.message;
	}
};

/**
 * Generate Arweave wallet from mnemonic
 * @param {string} mnemonic
 */
// Lazy load dependencies to ensure they are available
let bip39, crypto;
try {
	bip39 = require("bip39");
	crypto = require("crypto");
} catch (e) {
	console.warn("Dependencies missing for Arweave wallet generation", e);
}

/**
 * Generate Arweave wallet from mnemonic
 * Uses deterministic RNG seeded by mnemonic to generate RSA key via node-forge
 * @param {string} mnemonic
 */
const generateWalletFromMnemonic = async (mnemonic) => {
	let forge;
	try {
		forge = require("node-forge");
	} catch (e) {
		throw new Error("node-forge dependency missing. Please install it to allow deterministic RSA generation.");
	}

	if (!bip39) throw new Error("bip39 dependency missing");

	// 1. Generate Seed from Mnemonic
	const seed = await bip39.mnemonicToSeed(mnemonic);

	// 2. Setup Deterministic PRNG using node-forge
	// Use the seed to power a sha256 hash chain that feeds the PRNG
	let state = seed;

	// Custom PRNG wrapper for Forge
	const customPrng = {
		getBytesSync: (size) => {
			let res = "";
			// We need 'size' bytes
			while (res.length < size) {
				const hasher = crypto.createHash("sha256");
				hasher.update(state);
				state = hasher.digest();
				res += state.toString("binary");
			}
			return res.substring(0, size);
		},
	};

	// 3. Generate RSA Key
	// This is synchronous in forge and might be slow for 4096 bits.
	// Test timeout is set to 60s which should be enough.
	// We use 2048 bits (~2s) to meet performance requirements.
	const keyPair = forge.pki.rsa.generateKeyPair({
		bits: 2048,
		prng: customPrng,
		workers: -1, // forcing main thread to ensure our PRNG is used
	});

	// 4. Construct JWK
	const { privateKey } = keyPair;

	// Helper to convert BigInteger to Base64URL
	const toB64Url = (bigInt) => {
		// forge BigInt to hex
		let hex = bigInt.toString(16);
		if (hex.length % 2 !== 0) hex = "0" + hex;
		const buf = Buffer.from(hex, "hex");
		return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
	};

	const n = toB64Url(privateKey.n);
	const e = toB64Url(privateKey.e);
	const d = toB64Url(privateKey.d);
	const p = toB64Url(privateKey.p);
	const q = toB64Url(privateKey.q);
	const dp = toB64Url(privateKey.dP);
	const dq = toB64Url(privateKey.dQ);
	const qi = toB64Url(privateKey.qInv);

	const jwk = {
		kty: "RSA",
		n,
		e,
		d,
		p,
		q,
		dp,
		dq,
		qi,
	};

	// 5. Generate Address
	const arweave = Arweave.init({
		host: "arweave.net",
		port: 443,
		protocol: "https",
	});

	const address = await arweave.wallets.jwkToAddress(jwk);

	return {
		address,
		privateKey: jwk, // Return the full JWK as private key
	};
};

module.exports = {
	zelfNameRegistration,
	search,
	arweaveIDToBase64,
	generateWalletFromMnemonic,
};
