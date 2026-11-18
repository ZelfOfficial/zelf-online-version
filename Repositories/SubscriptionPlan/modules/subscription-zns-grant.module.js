const config = require("../../../Core/config");
const ClientModule = require("../../Client/modules/client.module");
const DefaultLicenseValues = require("../../License/modules/default-license.values");
const SubscriptionZnsGrant = require("../models/subscription-zns-grant.model");
const ZNSTokenModule = require("../../ZelfNameService/modules/zns-token.module");
const { isPayoutAddressBlocked } = require("../../ZelfNameService/modules/zns-payout-denylist");

/**
 * Stale `pending` rows are retried after this window. They likely indicate a process
 * crash between create() and the transfer save() (or a previous transient transfer error).
 */
const STALE_PENDING_MS = 5 * 60 * 1000;

/**
 * Resolve the license plan and monthly ZNS token amount from a Stripe subscription.
 * Shared between webhook grants and the reconcile flow so pricing math stays in one place.
 *
 * @param {object} params
 * @param {object} params.subscription Stripe subscription (items.data[].price preferred expanded)
 * @param {number} [params.amountPaid] Fallback unit amount when subscription price is missing
 * @returns {{ plan: object, tokenAmount: number, rewardPrice: number, priceToMatch: number } | { skippedReason: string, priceToMatch?: number, planCode?: string }}
 */
const resolvePlanAndAmount = ({ subscription, amountPaid }) => {
	const subscriptionPrice = subscription?.items?.data?.[0]?.price?.unit_amount;
	const priceToMatch = subscriptionPrice !== undefined ? subscriptionPrice : amountPaid;

	const plan = DefaultLicenseValues.findPlanByPrice(priceToMatch);

	if (!plan) return { skippedReason: "plan_not_found", priceToMatch };

	const rewardPrice = Number(config.token?.rewardPrice);
	if (!Number.isFinite(rewardPrice) || rewardPrice <= 0) {
		return { skippedReason: "invalid_reward_price", planCode: plan.code };
	}

	const monthlyUsd = Number(plan.price) / 100;
	const tokenAmount = Math.ceil(monthlyUsd / rewardPrice);

	if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
		return { skippedReason: "zero_or_unconfigured_amount", planCode: plan.code };
	}

	return { plan, tokenAmount, rewardPrice, priceToMatch };
};

const normalizeEmail = (email) => (typeof email === "string" ? email.trim().toLowerCase() : "");

/**
 * Resolve the customer's dashboard Solana wallet for a monthly grant.
 *
 * Lookup order (first non-empty wins):
 *   1. `authUser.solanaAddress` when the JWT email matches the Stripe customer email.
 *      The dashboard JWT signs `solanaAddress` at login, so authenticated reconcile
 *      and verifySession flows can use it without persisting it elsewhere.
 *   2. `client.publicData.solanaAddress` from `ClientModule.get({ email })` — kept as a
 *      fallback for the webhook path (no JWT) and any future server-side persistence.
 *
 * @param {string} customerEmail Stripe / invoice customer email
 * @param {object} [authUser] Koa `ctx.state.user` payload (signed JWT) when available
 * @returns {Promise<{ solanaAddress: string, source: 'jwt' | 'client_record' } | { skippedReason: 'no_solana_wallet' }>}
 */
const resolvePayoutSolanaAddress = async (customerEmail, authUser) => {
	const targetEmail = normalizeEmail(customerEmail);

	if (authUser && typeof authUser === "object") {
		const jwtEmail = normalizeEmail(authUser.email);
		const jwtAddress = authUser.solanaAddress;
		if (
			jwtEmail &&
			targetEmail &&
			jwtEmail === targetEmail &&
			typeof jwtAddress === "string" &&
			jwtAddress.length > 0
		) {
			return { solanaAddress: jwtAddress, source: "jwt" };
		}
	}

	const client = await ClientModule.get({ email: customerEmail });
	const solanaAddress = client?.publicData?.solanaAddress;

	if (!solanaAddress || typeof solanaAddress !== "string") {
		return { skippedReason: "no_solana_wallet" };
	}

	return { solanaAddress, source: "client_record" };
};

/**
 * Mark a grant document as completed after a successful Solana transfer.
 * Centralized so retry and first-run paths persist the same fields.
 */
const markGrantCompleted = async (grantDoc, signature) => {
	grantDoc.status = "completed";
	grantDoc.signature = signature;
	grantDoc.errorMessage = undefined;
	await grantDoc.save();
};

/**
 * Mark a grant document as failed and persist the error for later inspection.
 */
const markGrantFailed = async (grantDoc, error) => {
	grantDoc.status = "failed";
	grantDoc.errorMessage = error?.message || String(error);
	await grantDoc.save();
	return grantDoc.errorMessage;
};

/**
 * After Stripe invoice.payment_succeeded + subscription IPFS sync:
 * grant monthly ZNS to the customer's dashboard Solana wallet (once per invoice.id).
 *
 * Never throws — Stripe webhook handler must not fail on Solana/Mongo edge cases.
 *
 * If a row already exists, callers should use `retryGrantForExistingInvoice` to avoid
 * the unique-key path that returns `duplicate_invoice`.
 *
 * @param {object} params
 * @param {string} params.invoiceId
 * @param {string} params.subscriptionId
 * @param {string} params.customerEmail
 * @param {number} [params.amountPaid] invoice.amount_paid fallback for plan match (same as saveSubscriptionRecord)
 * @param {object} params.subscription Stripe Subscription object (items.data[].price expanded preferred)
 * @param {object} [params.authUser] Optional signed JWT payload (`ctx.state.user`); enables JWT-first wallet resolution
 *   for authenticated reconcile / verifySession callers. Webhook callers omit it on purpose.
 * @returns {Promise<object>}
 */
const tryGrantMonthlyZnsForPaidInvoice = async ({ invoiceId, subscriptionId, customerEmail, subscription, amountPaid, authUser }) => {
	const noop = (reason, extra = {}) => ({
		granted: false,
		skippedReason: reason,
		invoiceId,
		...extra,
	});

	if (!invoiceId || !subscriptionId || !customerEmail || !subscription) {
		return noop("missing_parameters");
	}

	try {
		const planResolution = resolvePlanAndAmount({ subscription, amountPaid });
		if (planResolution.skippedReason) {
			console.warn(
				"[subscription-zns] grant skipped:",
				planResolution.skippedReason,
				"invoice:",
				invoiceId,
				planResolution.priceToMatch !== undefined ? `priceToMatch=${planResolution.priceToMatch}` : ""
			);
			return noop(planResolution.skippedReason, {
				priceToMatch: planResolution.priceToMatch,
				planCode: planResolution.planCode,
			});
		}

		const { plan, tokenAmount } = planResolution;

		const walletResolution = await resolvePayoutSolanaAddress(customerEmail, authUser);
		if (walletResolution.skippedReason) {
			console.warn("[subscription-zns] skip grant — no solanaAddress for:", customerEmail, "invoice:", invoiceId);
			return noop(walletResolution.skippedReason, { planCode: plan.code });
		}

		const { solanaAddress } = walletResolution;

		if (isPayoutAddressBlocked(solanaAddress)) {
			return noop("PAYOUT_ADDRESS_BLOCKED", { planCode: plan.code });
		}

		let grantDoc;
		try {
			grantDoc = await SubscriptionZnsGrant.create({
				invoiceId,
				subscriptionId,
				customerEmail,
				planCode: plan.code,
				tokenAmount: Number(tokenAmount),
				status: "pending",
			});
		} catch (insertErr) {
			const dupCode = insertErr?.code === 11000 || insertErr?.cause?.code === 11000;
			if (dupCode) {
				return noop("duplicate_invoice", { planCode: plan.code });
			}
			console.error("[subscription-zns] Mongo insert failed:", insertErr?.message || insertErr);
			return noop("ledger_insert_failed", { planCode: plan.code });
		}

		try {
			const signature = await ZNSTokenModule.giveTokensAfterPurchase(Number(tokenAmount), solanaAddress);

			await markGrantCompleted(grantDoc, signature);

			console.info("[subscription-zns] granted", tokenAmount, "ZNS to", solanaAddress, "invoice:", invoiceId, "sig:", signature);

			return {
				granted: true,
				invoiceId,
				subscriptionId,
				planCode: plan.code,
				tokenAmount: Number(tokenAmount),
				signature,
				solanaAddress,
			};
		} catch (transferErr) {
			const errorMessage = await markGrantFailed(grantDoc, transferErr);

			console.error("[subscription-zns] transfer failed invoice:", invoiceId, errorMessage);

			return {
				granted: false,
				skippedReason: "transfer_failed",
				invoiceId,
				planCode: plan.code,
				errorMessage,
			};
		}
	} catch (err) {
		console.error("[subscription-zns] unexpected error invoice:", invoiceId, err?.message || err);
		return noop("unexpected_error", { message: err?.message });
	}
};

/**
 * Retry the on-chain transfer for an existing grant row that did not complete (failed or stale pending).
 *
 * Required because the ledger has a unique key on `invoiceId`: re-running
 * `tryGrantMonthlyZnsForPaidInvoice` would short-circuit with `duplicate_invoice`
 * and never re-attempt the transfer.
 *
 * @param {object} grantDoc Existing SubscriptionZnsGrant document
 * @param {object} options
 * @param {object} options.subscription Stripe subscription used to recompute the token amount in case the plan changed
 * @param {number} [options.amountPaid] invoice.amount_paid fallback for plan match
 * @param {object} [options.authUser] Optional signed JWT payload, same role as in `tryGrantMonthlyZnsForPaidInvoice`.
 * @returns {Promise<object>}
 */
const retryGrantForExistingInvoice = async (grantDoc, { subscription, amountPaid, authUser } = {}) => {
	const invoiceId = grantDoc.invoiceId;
	const noop = (reason, extra = {}) => ({
		granted: false,
		skippedReason: reason,
		invoiceId,
		previousStatus: grantDoc.status,
		...extra,
	});

	if (grantDoc.status === "completed" && grantDoc.signature) {
		return {
			granted: false,
			skippedReason: "already_completed",
			invoiceId,
			previousStatus: grantDoc.status,
			signature: grantDoc.signature,
		};
	}

	if (grantDoc.status === "pending") {
		const updatedAt = grantDoc.updatedAt ? new Date(grantDoc.updatedAt).getTime() : 0;
		const isStale = Date.now() - updatedAt >= STALE_PENDING_MS;
		if (!isStale) return noop("pending_too_recent");
	}

	let planCode = grantDoc.planCode;
	let tokenAmount = Number(grantDoc.tokenAmount);

	if (subscription) {
		const planResolution = resolvePlanAndAmount({ subscription, amountPaid });
		if (!planResolution.skippedReason) {
			planCode = planResolution.plan.code;
			tokenAmount = Number(planResolution.tokenAmount);

			if (grantDoc.planCode !== planCode || Number(grantDoc.tokenAmount) !== tokenAmount) {
				grantDoc.planCode = planCode;
				grantDoc.tokenAmount = tokenAmount;
			}
		}
	}

	if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
		return noop("zero_or_unconfigured_amount", { planCode });
	}

	const walletResolution = await resolvePayoutSolanaAddress(grantDoc.customerEmail, authUser);
	if (walletResolution.skippedReason) {
		return noop(walletResolution.skippedReason, { planCode });
	}

	const { solanaAddress } = walletResolution;

	if (isPayoutAddressBlocked(solanaAddress)) {
		await markGrantFailed(grantDoc, new Error("403:PAYOUT_ADDRESS_BLOCKED"));
		return noop("PAYOUT_ADDRESS_BLOCKED", { planCode });
	}

	grantDoc.status = "pending";
	grantDoc.errorMessage = undefined;
	await grantDoc.save();

	try {
		const signature = await ZNSTokenModule.giveTokensAfterPurchase(tokenAmount, solanaAddress);

		await markGrantCompleted(grantDoc, signature);

		console.info(
			"[subscription-zns] retry granted",
			tokenAmount,
			"ZNS to",
			solanaAddress,
			"invoice:",
			invoiceId,
			"sig:",
			signature
		);

		return {
			granted: true,
			retried: true,
			invoiceId,
			subscriptionId: grantDoc.subscriptionId,
			planCode,
			tokenAmount,
			signature,
			solanaAddress,
		};
	} catch (transferErr) {
		const errorMessage = await markGrantFailed(grantDoc, transferErr);

		console.error("[subscription-zns] retry transfer failed invoice:", invoiceId, errorMessage);

		return {
			granted: false,
			skippedReason: "transfer_failed",
			invoiceId,
			planCode,
			errorMessage,
		};
	}
};

module.exports = {
	tryGrantMonthlyZnsForPaidInvoice,
	retryGrantForExistingInvoice,
	resolvePlanAndAmount,
	resolvePayoutSolanaAddress,
	STALE_PENDING_MS,
};
