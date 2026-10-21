const Stripe = require("stripe");
const config = require("../../../Core/config");
const { retrieveCheckoutSession } = require("../../Stripe/modules/stripe-checkout-session.module");
const { getMyLicense } = require("../../License/modules/license.module");
const IpfsLookupCache = require("../../../Core/ipfs-lookup-cache");

const loadSubscriptionRecords = async (domain) => {
    if (!domain) return [];

    const records = await IpfsLookupCache.getOrLoad(IpfsLookupCache.keys.subscription(domain), async () => {
        const IPFSModule = require("../../IPFS/modules/ipfs.module");
        const found = await IPFSModule.get({
            key: "subscriptionDomain",
            value: domain,
            limit: 1,
        });

        return found?.length ? found : null;
    });

    return records || [];
};

/**
 * Get Stripe client
 */
const getStripeClient = () => {
    const apiKey = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY;
    if (!apiKey) throw new Error("500:stripe_key_missing");
    return new Stripe(apiKey, { apiVersion: "2024-06-20" });
};

/**
 * List subscription plans from Stripe filtered by metadata and ordered by price
 * - planType must equal "license"
 * - zelfPlan in [zelfBasic, ZelfGold, zelfBusiness, zelfStartUp, zelfEnterprise]
 * Sorted by unit_amount ascending, and limited to 0-4999 (cents) inclusive
 */
const listSubscriptionPlans = async () => {
    const stripe = getStripeClient();

    // 1) List active products (paged)
    const products = [];
    let prodStartingAfter;
    let prodHasMore = true;
    while (prodHasMore) {
        const page = await stripe.products.list({ active: true, limit: 100, starting_after: prodStartingAfter });
        products.push(...(page.data || []));
        prodHasMore = Boolean(page.has_more);
        prodStartingAfter = prodHasMore && page.data?.length ? page.data[page.data.length - 1].id : undefined;
    }

    // 2) Filter products by metadata (planType license OR code includes 'enroll'), zelfPlan in allowed
    const allowedZelfPlans = new Set(["zelfBasic", "zelfGold", "zelfBusiness", "zelfStartUp", "zelfEnterprise"]);

    const filteredProducts = products.filter((p) => {
        const planType = p?.metadata?.planType;
        const zelfPlan = p?.metadata?.zelfPlan || p?.metadata?.plan;

        if (!planType || !zelfPlan) return false;

        const codeIncludesEnroll = typeof p?.metadata?.code === "string" && p.metadata.code.includes("enroll");

        return (planType === "license" || codeIncludesEnroll) && zelfPlan && allowedZelfPlans.has(zelfPlan);
    });

    for (const product of filteredProducts) {
        const pricesList = await stripe.prices.list({
            product: product.id,
            active: true,
            limit: 100,
        });

        if (!pricesList || pricesList.data.length === 0) continue;

        product.prices = pricesList.data;
    }

    return filteredProducts;
};

/**
 * Get a single subscription plan by product ID
 */
const getSubscriptionPlan = async (productId) => {
    if (!productId) throw new Error("400:product_id_required");
    const stripe = getStripeClient();

    const allowedZelfPlans = new Set(["zelfBasic", "zelfGold", "zelfBusiness", "zelfStartUp", "zelfEnterprise"]);

    const product = await stripe.products.retrieve(productId);

    if (!product) throw new Error("404:plan_not_found");

    if (!allowedZelfPlans.has(product.metadata.zelfPlan)) throw new Error("404:plan_not_found");

    const pricesList = await stripe.prices.list({
        product: product.id,
        active: true,
        limit: 100,
    });

    if (!pricesList || pricesList.data.length === 0) throw new Error("404:plan_not_found");

    product.prices = pricesList.data;

    return product;
};

/**
 * Create a Stripe checkout session for subscription
 * @param {string} productId - Stripe product ID
 * @param {string} priceId - Stripe price ID
 * @param {string} customerEmail - Customer email (optional)
 * @returns {Promise<Object>} - Stripe checkout session
 */
const createCheckoutSession = async (productId, priceId, customerEmail = null) => {
    const stripe = getStripeClient();

    // Validate that the product and price exist and are active
    const product = await stripe.products.retrieve(productId);

    if (!product || !product.active) {
        throw new Error("404:product_not_found");
    }

    const price = await stripe.prices.retrieve(priceId);

    if (!price || !price.active) {
        throw new Error("404:price_not_found");
    }

    // Verify the price belongs to the product
    if (price.product !== productId) {
        throw new Error("400:price_product_mismatch");
    }

    // Create checkout session
    const sessionParams = {
        payment_method_types: ["card"],
        line_items: [
            {
                price: priceId,
                quantity: 1,
            },
        ],
        allow_promotion_codes: true,
        mode: "subscription",
        success_url: config.stripe.dashboard.success,
        cancel_url: config.stripe.dashboard.cancel,
        metadata: {
            customerEmail: customerEmail,
            priceId: priceId,
            productId: productId,
            source: "dashboard",
        },
        subscription_data: {
            metadata: {
                source: "dashboard",
            },
        },
    };

    // Add customer email if provided
    if (customerEmail) {
        sessionParams.customer_email = customerEmail;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    return session;
};

const getMySubscription = async (authToken) => {
    const { myLicense, zelfAccount } = await getMyLicense(authToken, true);

    if (!myLicense) throw new Error("404:license_not_found");

    const IPFSModule = require("../../IPFS/modules/ipfs.module");

    // Try to find the subscription record in IPFS
    const subscriptionRecords = await loadSubscriptionRecords(myLicense.domainConfig.name);

    let subscriptionId = myLicense.domainConfig?.stripe?.subscriptionId;
    let productId = myLicense.domainConfig?.stripe?.productId;
    let subscriptionIPFS = null;
    let product = null;
    let subscription = null;

    if (subscriptionRecords && subscriptionRecords.length > 0) {
        const subRecord = subscriptionRecords[0];
        // Fetch the JSON content
        const axios = require("axios");
        try {
            const jsonResponse = await axios.get(subRecord.url);
            subscriptionIPFS = jsonResponse.data;

            if (subscriptionIPFS.stripe?.subscriptionId) {
                subscriptionId = subscriptionIPFS.stripe.subscriptionId;
            }
            if (subscriptionIPFS.stripe?.productId) {
                productId = subscriptionIPFS.stripe.productId;
            }
        } catch (err) {
            console.error("Failed to fetch subscription JSON from IPFS", err);
        }
    }

    if (!subscriptionRecords || subscriptionRecords.length === 0) {
        const result = await migrateLegacySubscription(myLicense, IPFSModule);

        if (result) {
            subscriptionIPFS = result.subscriptionIPFS;
            subscriptionId = result.subscriptionId;
            productId = result.productId;
        }
    }

    if (!subscriptionId) {
        // If no subscription found, return minimal info or null
        return { myLicense, zelfAccount, subscription: null, product: null };
    }

    const stripe = getStripeClient();

    try {
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
    } catch (e) {
        console.warn("Stripe subscription not found:", subscriptionId);
        // If stripe fails, we might still want to return what we have?
    }

    if (productId || (subscription && subscription.plan && subscription.plan.product)) {
        try {
            product = await stripe.products.retrieve(productId || subscription.plan.product);
        } catch (e) {
            console.warn("Stripe product not found");
        }
    }

    return { myLicense, zelfAccount, subscription, product, subscriptionIPFS };
};

/**
 * Create a Stripe customer portal session for subscription management
 * @param {Object} authToken - Authentication token containing user info
 * @returns {Promise<Object>} - Stripe portal session
 */
const createPortalSession = async (authToken) => {
    const stripe = getStripeClient();

    // Get the user's license
    const { myLicense } = await getMyLicense(authToken, true);

    if (!myLicense) throw new Error("404:license_not_found");

    let customerId = myLicense.domainConfig?.stripe?.customerId;

    // Try to find the subscription record in IPFS to get the most recent/correct customer ID
    // because we now store subscription info in a separate record
    const subscriptionRecords = await loadSubscriptionRecords(myLicense.domainConfig.name);

    if (subscriptionRecords && subscriptionRecords.length > 0) {
        const subRecord = subscriptionRecords[0];
        const axios = require("axios");
        try {
            const jsonResponse = await axios.get(subRecord.url);
            const subscriptionIPFS = jsonResponse.data;
            if (subscriptionIPFS.stripe?.customerId) {
                customerId = subscriptionIPFS.stripe.customerId;
            }
        } catch (err) {
            console.error("Failed to fetch subscription JSON for portal session", err);
        }
    }

    if (!customerId) {
        throw new Error("400:no_customer_found");
    }

    // Create portal session
    const sessionParams = {
        customer: customerId,
        return_url: `${config.stripe.dashboard.origin}/settings/plan-billing`,
    };

    const session = await stripe.billingPortal.sessions.create(sessionParams);

    return session;
};

const verifySession = async (sessionId, authToken) => {
    const stripe = getStripeClient();

    // Get the user's license to verify ownership matches or at least log/track
    // In strictly safe env, we should check if session.customer_email matches user.email
    // But Stripe checkout might use a different email if user changed it.
    // For now, we trust the authenticated user providing a valid session ID from their flow.
    const { myLicense } = await getMyLicense(authToken, true);

    if (!myLicense) throw new Error("404:license_not_found");

    // 1. Retrieve the session
    const session = await retrieveCheckoutSession(stripe, sessionId);

    if (!session) throw new Error("404:session_not_found");

    if (session.payment_status !== "paid") throw new Error("400:session_not_paid");

    // 2. Retrieve subscription
    const subscription = await stripe.subscriptions.retrieve(session.subscription);
    if (!subscription) throw new Error("404:subscription_not_found");

    // 3. Retrieve customer
    const customer = await stripe.customers.retrieve(session.customer);
    if (!customer) throw new Error("404:customer_not_found");

    // 4. Construct payment data (mimicking webhook structure)
    const paymentData = {
        invoiceId: session.invoice, // sessions usually have an invoice if it's subscription
        subscriptionId: session.subscription,
        customerId: session.customer,
        customerEmail: customer.email,
        amountPaid: session.amount_total,
        paidAt: new Date(), // approximate if we don't fetch invoice
        currency: session.currency,
        status: "paid",
        subscription: subscription,
        customer: customer,
        priceId: session.line_items?.data?.[0]?.price?.id || subscription.items.data[0].price.id,
    };

    // If we need strict invoice data (like paid_at), we could fetch the invoice:
    if (session.invoice) {
        const invoice = await stripe.invoices.retrieve(session.invoice);
        paymentData.paidAt = new Date(invoice.status_transitions.paid_at * 1000);
        paymentData.amountPaid = invoice.amount_paid;
    }

    // 5. Save/Update subscription record in IPFS
    // We use the license found for the current user.
    // NOTE: saveSubscriptionRecord uses license.url to load data or creates default.
    const { saveSubscriptionRecord } = require("../../License/modules/license.module");
    const record = await saveSubscriptionRecord(myLicense, paymentData);

    IpfsLookupCache.invalidateLicense({
        emails: [authToken.email, authToken.ownerEmail, myLicense?.publicData?.licenseOwner],
        domains: [myLicense.domainConfig?.name, myLicense.publicData?.domain],
    });

    // 6. Mirror the webhook's monthly ZNS grant so checkout-redirect users get tokens even if
    // the invoice.payment_succeeded webhook is delayed or fails. Idempotent: the grant ledger
    // is keyed on invoice.id, so a later webhook will short-circuit on duplicate_invoice.
    let znsGrant = null;
    if (paymentData.invoiceId) {
        try {
            const { tryGrantMonthlyZnsForPaidInvoice } = require("./subscription-zns-grant.module");
            znsGrant = await tryGrantMonthlyZnsForPaidInvoice({
                invoiceId: paymentData.invoiceId,
                subscriptionId: paymentData.subscriptionId,
                customerEmail: paymentData.customerEmail,
                subscription: paymentData.subscription,
                amountPaid: paymentData.amountPaid,
                authUser: authToken,
            });
        } catch (err) {
            console.error("[verifySession] ZNS grant attempt failed:", err?.message || err);
        }
    }

    return { success: true, record, znsGrant };
};

const migrateLegacySubscription = async (myLicense, IPFSModule) => {
    const legacySubscriptionId = myLicense.domainConfig?.stripe?.subscriptionId;

    if (!legacySubscriptionId) return null;

    const stripe = getStripeClient();

    try {
        const subscriptionToMigrate = await stripe.subscriptions.retrieve(legacySubscriptionId);
        if (subscriptionToMigrate && subscriptionToMigrate.status === "active") {
            const customer = await stripe.customers.retrieve(subscriptionToMigrate.customer);

            // Mimic payment data
            const paymentData = {
                subscriptionId: subscriptionToMigrate.id,
                customerId: subscriptionToMigrate.customer,
                customerEmail: customer.email, // Best effort
                amountPaid: 0, // Unknown without invoice, but safe for record creation
                paidAt: new Date(subscriptionToMigrate.current_period_start * 1000),
                currency: subscriptionToMigrate.currency,
                status: "paid",
                subscription: subscriptionToMigrate,
                customer: customer,
                priceId: subscriptionToMigrate.items?.data[0]?.price?.id,
            };

            // Save new record
            const { saveSubscriptionRecord } = require("../../License/modules/license.module");
            await saveSubscriptionRecord(myLicense, paymentData);

            IpfsLookupCache.invalidateLicense({
                emails: [myLicense?.publicData?.licenseOwner, paymentData.customerEmail],
                domains: [myLicense.domainConfig.name],
            });

            // Re-fetch to return the new record immediately (optional, or just proceed)
            const newRecords = await IPFSModule.get({
                key: "subscriptionDomain",
                value: myLicense.domainConfig.name,
                limit: 1,
            });

            if (newRecords && newRecords.length > 0) {
                const subRecord = newRecords[0];
                const axios = require("axios");
                const jsonResponse = await axios.get(subRecord.url);
                const subscriptionIPFS = jsonResponse.data;
                let subscriptionId = null;
                let productId = null;

                if (subscriptionIPFS.stripe?.subscriptionId) {
                    subscriptionId = subscriptionIPFS.stripe.subscriptionId;
                }
                if (subscriptionIPFS.stripe?.productId) {
                    productId = subscriptionIPFS.stripe.productId;
                }

                return { subscriptionIPFS, subscriptionId, productId };
            }
        }
    } catch (err) {
        console.error("Migration failed", err);
    }
    return null;
};

module.exports = {
    listSubscriptionPlans,
    getSubscriptionPlan,
    createCheckoutSession,
    getMySubscription,
    createPortalSession,
    verifySession,
};
