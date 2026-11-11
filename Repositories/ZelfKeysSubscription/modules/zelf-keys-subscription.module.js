const configuration = require("../../../Core/config");
const pinata = require("../../../Core/ipfs");
const SignerData = require("../../../config/0012589021.json");
const { calculateCryptoAmount } = require("../../../Utilities/crypto-price.module.js");
const { lockPriceData, verifyLockedPrice } = require("../../../Utilities/price-lock.module.js");

const { createEthWallet } = require("../../Wallet/modules/eth");
const { generateMnemonic } = require("../../Wallet/modules/helpers");
const ZelfProofModule = require("../../ZelfProof/modules/zelf-proof.module.js");

/**
 *
 * @param {string | Date} date
 * @returns {string} formatted date string
 */
const formatDateTime = (date) => {
	const pad = (n) => String(n).padStart(2, "0");

	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
		date.getSeconds()
	)}`;
};

/**
 *
 * @param {Date} date
 * @param {number} minutes
 * @returns {Date} date with added minutes
 */
const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60000);

/**
 *
 * @param {Date} date
 * @param {number} months
 * @returns {Date} date with added months
 */
const addMonths = (date, months) => {
	const d = new Date(date.getTime());

	d.setMonth(d.getMonth() + months);

	return d;
};

/**
 *
 * @param {string} str
 * @returns {Date | null} parsed date
 */
const parseDateTime = (str) => {
	if (!str) return null;

	const isoLike = str.includes("T") ? str : str.replace(" ", "T");
	const d = new Date(isoLike);

	return isNaN(d.getTime()) ? null : d;
};

/**
 *
 * @param {string} tagName
 * @param {string} extension
 * @returns {string} converted zelfKeys format
 */
const convertToZelfKeysFormat = (tagName, extension = ".zelfkeys") => {
	if (!tagName) return tagName;

	tagName = tagName.split(".")[0];

	return `${tagName}${extension}`;
};

/**
 *
 * @param {Object} user
 * @returns {Object} subscription data
 */
const getActiveSubscription = async (user) => {
	const { tagName } = user;

	const zelfKeysTag = convertToZelfKeysFormat(tagName, ".zelfkeys");
	const subscriptionData = await searchSubscriptionInIPFS(zelfKeysTag);

	if (!subscriptionData) {
		return { success: false, message: "no_active_subscription_found", subscription: null };
	}

	return subscriptionData;
};

/**
 *
 * @returns {Object} available plans
 */
const getAvailablePlans = async () => {
	const plans = Object.entries(configuration.zelfKeysPlans).map(([key, plan]) => ({
		id: key,
		name: plan.name,
		description: plan.description,
		price: plan.price,
		currency: plan.currency,
		interval: plan.interval,
	}));

	return { success: true, plans };
};

/**
 *
 * @param {Object} body
 * @param {Object} authUser
 * @returns {Object} crypto payment data
 */
const createCryptoPayment = async (body, authUser) => {
	const { planId } = body;
	const { tagName } = authUser;

	const plans = configuration.zelfKeysPlans;
	const selectedPlan = plans[planId];

	if (!selectedPlan) throw new Error("invalid_plan_selected");

	const zkPayTag = convertToZelfKeysFormat(tagName, ".zkpay");
	const recordsFound = await pinata.filter("zkPay", zkPayTag);
	const existingZkPay = recordsFound && Array.isArray(recordsFound) && recordsFound.length ? recordsFound[0] : null;

	const priceCalculation = await calculateCryptoAmount(selectedPlan.price, "AVAX");
	const isDemoMode = configuration.cryptoPayments.demoMode;
	const demoMultiplier = configuration.cryptoPayments.demoMultiplier;
	const demoUsdAmount = isDemoMode ? selectedPlan.price * demoMultiplier : selectedPlan.price;
	const demoPriceCalculation = isDemoMode ? await calculateCryptoAmount(demoUsdAmount, "AVAX") : priceCalculation;

	const priceLockData = {
		avaxAmount: isDemoMode ? demoPriceCalculation.cryptoAmount : priceCalculation.cryptoAmount,
		avaxPrice: priceCalculation.cryptoPrice,
		currency: "AVAX",
		isDemoMode,
		paymentAddress: existingZkPay?.publicData?.avalancheAddress,
		planId,
		usdAmount: isDemoMode ? demoUsdAmount : selectedPlan.price,
		tagName: tagName,
		zkPayTag,
	};

	const lockedPriceToken = lockPriceData(priceLockData, 30);

	if (existingZkPay) {
		const returnData = {
			amount: isDemoMode ? demoPriceCalculation.cryptoAmount : priceCalculation.cryptoAmount,
			avaxPrice: priceCalculation.cryptoPrice,
			currency: "AVAX",
			expiresAt: formatDateTime(addMinutes(new Date(), 30)),
			isDemoMode,
			lockedPriceToken,
			originalAmount: { usd: selectedPlan.price, avax: priceCalculation.cryptoAmount },
			paymentAddress: existingZkPay.publicData?.avalancheAddress,
			success: true,
			usdAmount: isDemoMode ? demoUsdAmount : selectedPlan.price,
		};

		return {
			...returnData,
			zkPay: {
				ipfs_pin_hash: existingZkPay.ipfs_pin_hash,
				name: existingZkPay.name,
				publicData: existingZkPay.publicData,
				url: existingZkPay.url,
			},
		};
	}

	const zkPay = await _storePaymentAddress(tagName, zkPayTag);

	const returnData = {
		amount: priceLockData.avaxAmount,
		avaxPrice: priceLockData.avaxPrice,
		currency: "AVAX",
		expiresAt: formatDateTime(addMinutes(new Date(), 30)),
		isDemoMode: priceLockData.isDemoMode,
		lockedPriceToken,
		originalAmount: { usd: priceLockData.originalUsdAmount, avax: priceLockData.originalAvaxAmount },
		paymentAddress: zkPay.publicData.avalancheAddress,
		success: true,
		usdAmount: priceLockData.usdAmount,
	};

	return { ...returnData, zkPay };
};

/**
 *
 * @param {string} tagName
 * @param {string} zkPay
 * @returns {Object} payment address data
 */
const _storePaymentAddress = async (tagName, zkPay) => {
	const mnemonic = generateMnemonic(12);
	const wallet = createEthWallet(mnemonic);

	const zkPayData = {
		faceBase64: SignerData.faceBase64,
		identifier: zkPay,
		livenessLevel: "REGULAR",
		metadata: { mnemonic },
		os: "DESKTOP",
		password: SignerData.password,
		publicData: { avalancheAddress: wallet.address, zkPay, customerTag: tagName },
		requireLiveness: true,
	};

	const { zelfQR } = await ZelfProofModule.encryptQRCode(zkPayData);

	const ipfsResult = await pinata.pinFile(zelfQR, `${zkPay}`, "application/json", { ...zkPayData.publicData });

	return {
		url: ipfsResult.url,
		ipfs_pin_hash: ipfsResult.IpfsHash,
		name: ipfsResult.Name,
		publicData: ipfsResult.metadata,
		paymentAddress: wallet.address,
	};
};

/**
 *
 * @param {string} zelfKeysTag
 * @returns {Object} subscription data
 */
async function searchSubscriptionInIPFS(zelfKeysTag) {
	try {
		const files = await pinata.filter("tagName", zelfKeysTag);

		let activeSubscription = null;

		for (const element of files) {
			const keyValues = element.publicData;
			const isActiveOrCancelledActive = !keyValues.status || keyValues.status === "active" || keyValues.status === "cancelled_active";

			if (isActiveOrCancelledActive) {
				// For cancelled_active, ensure we haven't passed the end date
				if (keyValues.status === "cancelled_active" && keyValues.endDate) {
					const endDate = parseDateTime(keyValues.endDate);
					// Add a small buffer (e.g. 24 hours) to be generous/account for timezone issues, or strict?
					// Let's be strict but rely on the stored date.
					if (endDate && endDate < new Date()) {
						// Subscription has expired
						continue;
					}
				}

				activeSubscription = {
					id: element.id,
					url: element.url,
					ipfs_pin_hash: element.ipfs_pin_hash,
					name: element.name,
					...keyValues,
					stripeData: keyValues.stripeData ? JSON.parse(keyValues.stripeData) : null,
					cryptoData: keyValues.cryptoData ? JSON.parse(keyValues.cryptoData) : null,
					revenueCatData: keyValues.revenueCatData ? JSON.parse(keyValues.revenueCatData) : null,
				};

				break;
			}
		}

		return activeSubscription;
	} catch (error) {
		console.error("Error searching subscription in IPFS:", error);
	}

	return null;
}

/**
 *
 * @param {Object} subscriptionData
 * @returns {Object} IPFS result
 */
async function storeSubscriptionInIPFS(subscriptionData) {
	const ipfsResult = await pinata.pinFile(
		Buffer.from(JSON.stringify(subscriptionData)).toString("base64"),
		`${subscriptionData.tagName}.json`,
		"application/json",
		subscriptionData
	);

	if (!ipfsResult) throw new Error("failed_to_store_subscription_in_ipfs");

	return ipfsResult;
}

/**
 *
 * @param {Object} body
 * @param {Object} user
 * @returns {Object} crypto payment confirmation result
 */
const confirmCryptoPayment = async (body, user) => {
	try {
		const { lockedPriceToken } = body;
		const { tagName } = user;

		if (!lockedPriceToken) return { success: false, paymentConfirmed: false, message: "locked_price_token_required" };

		let priceLockData;

		try {
			priceLockData = verifyLockedPrice(lockedPriceToken);
		} catch (e) {
			return { success: false, paymentConfirmed: false, message: "invalid_or_expired_payment_token" };
		}

		if (priceLockData.tagName !== tagName) {
			return { success: false, paymentConfirmed: false, message: "payment_token_does_not_belong_to_user" };
		}

		const expiresDate = parseDateTime(priceLockData.expiresAt);

		if (!expiresDate || Date.now() > expiresDate.getTime()) {
			return { success: false, paymentConfirmed: false, message: "payment_token_expired" };
		}

		const zkPayTag = priceLockData.zkPayTag;
		const recordsFound = await pinata.filter("zkPay", zkPayTag);
		const zkPayRecord = recordsFound && Array.isArray(recordsFound) && recordsFound.length ? recordsFound[0] : null;

		if (!zkPayRecord) return { success: false, paymentConfirmed: false, message: "payment_record_not_found" };

		const paymentAddress = zkPayRecord.publicData.avalancheAddress;
		const requiredAmount = priceLockData.avaxAmount;
		const transactionResult = await checkAvalancheTransactions(paymentAddress, requiredAmount);

		if (transactionResult.paymentFound) {
			const zelfKeysTag = convertToZelfKeysFormat(tagName, ".zelfkeys");
			const existingSubscription = await searchSubscriptionInIPFS(zelfKeysTag);

			if (existingSubscription) {
				return {
					success: true,
					paymentConfirmed: true,
					transactionHash: transactionResult.transactionHash,
					subscriptionCreated: false,
					message: "payment_confirmed_subscription_already_exists",
				};
			}

			const subscriptionData = {
				cryptoData: JSON.stringify({
					customer: tagName,
					status: "active",
					plan: priceLockData.planId,
					planName: priceLockData.planName,
					price: priceLockData.usdAmount,
					paymentMethod: "crypto",
					transactionHash: transactionResult.transactionHash,
					isDemoMode: priceLockData.isDemoMode || false,
				}),
				tagName: zelfKeysTag,
				startDate: formatDateTime(new Date()),
				endDate: formatDateTime(addMonths(new Date(), 1)),
				paymentMethod: "crypto",
				type: "subscription",
			};

			await storeSubscriptionInIPFS(subscriptionData);

			return {
				success: true,
				paymentConfirmed: true,
				transactionHash: transactionResult.transactionHash,
				subscriptionCreated: true,
				message: "payment_confirmed_subscription_activated",
			};
		}

		return { success: true, paymentConfirmed: false, message: "no_sufficient_payment_found_yet" };
	} catch (error) {
		return { success: false, paymentConfirmed: false, message: "error_checking_payment" };
	}
};

/**
 *
 * @param {string} address
 * @param {number} requiredAmount
 * @returns {Object} transaction check result
 */
const checkAvalancheTransactions = async (address, requiredAmount) => {
	try {
		try {
			const snowTraceResponse = await fetch(
				`https://api.snowtrace.io/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=10&sort=desc&apikey=YourApiKeyToken`
			);

			const snowTraceData = await snowTraceResponse.json();

			if (snowTraceData.status === "1" && snowTraceData.result) {
				for (const tx of snowTraceData.result) {
					const txAmount = parseFloat(tx.value) / Math.pow(10, 18);
					const txTimestamp = parseInt(tx.timeStamp);

					if (txAmount >= requiredAmount) {
						return {
							paymentFound: true,
							transactionHash: tx.hash,
							amount: txAmount,
							blockNumber: tx.blockNumber,
							timestamp: txTimestamp,
							source: "snowtrace_api",
						};
					}
				}
			}
		} catch (e) {}

		const balanceResponse = await fetch(configuration.avalanche.rpcUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", method: "eth_getBalance", params: [address, "latest"], id: 4 }),
		});

		const balanceData = await balanceResponse.json();

		if (balanceData.result) {
			const balanceWei = BigInt(balanceData.result);
			const balanceAvax = Number(balanceWei) / Math.pow(10, 18);

			if (balanceAvax >= requiredAmount) {
				return {
					paymentFound: true,
					transactionHash: `balance_check_${Date.now()}`,
					amount: balanceAvax,
					note: "Payment confirmed via balance check (demo mode)",
					source: "balance_check",
				};
			}
		}

		return { paymentFound: false, message: "no_sufficient_payment_transactions_found_today" };
	} catch (error) {
		return { paymentFound: false, error: error.message };
	}
};

module.exports = {
	getActiveSubscription,
	getAvailablePlans,
	createCryptoPayment,
	confirmCryptoPayment,
};
