const WebhookRouter = require("../modules/webhook-router.module");

const Stripe = require("stripe");

const configuration = require("../../../Core/config");

const stripe = new Stripe(configuration.stripe.secretKey, {
    apiVersion: "2023-10-16",
});

/**
 * Turn a "this is not a Zelf event" handler result into the Stripe acknowledgement.
 * Processing failures are thrown and must not be passed here: Stripe should retry those.
 * @param {object|null|undefined} result
 * @returns {{ received: true, ignored: true, reason: string }|null}
 */
const ignoredAcknowledgement = (result) => {
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;

    if (result.ignored === true) {
        return { received: true, ignored: true, reason: String(result.reason || "not_zelf") };
    }

    // Listed in the router but not implemented, or a type no Zelf handler accepts.
    if (result.status === "unhandled" || result.not_implemented === true || result.unhandledEvent) {
        return { received: true, ignored: true, reason: "unhandled_event_type" };
    }

    if (result.reason === "unhandled_zelf_id_lease_event") {
        return { received: true, ignored: true, reason: "unhandled_event_type" };
    }

    return null;
};

/**
 * Handle Stripe webhook events
 */
const handleWebhook = async (ctx) => {
    try {
        // Use the verified event from middleware instead of raw request body
        const event = ctx.webhookEvent;

        // Route webhook to appropriate handler based on source
        const result = await WebhookRouter.routeWebhook(event);
        const ignored = ignoredAcknowledgement(result);

        if (ignored) {
            console.warn(`[stripe webhook] ignored ${event?.type || "unknown"} ${event?.id || "unknown"} ${ignored.reason}`);

            ctx.status = 200;
            ctx.body = ignored;

            return;
        }

        ctx.status = 200;
        ctx.body = { received: true, processed: result };
    } catch (error) {
        console.error("Error processing webhook:", error);

        ctx.status = 400;
        ctx.body = { error: "Webhook processing failed" };
    }
};

/**
 * Handle Stripe checkout result (success/failure)
 * @param {Object} ctx - Koa context
 */
const handleStripeResult = async (ctx) => {
    try {
        const { success, canceled, session_id } = ctx.query;

        let sessionData = null;
        let subscriptionData = null;
        let customerData = null;
        let errorMessage = null;

        // If we have a session ID, retrieve the session details
        if (session_id) {
            try {
                sessionData = await stripe.checkout.sessions.retrieve(session_id, {
                    expand: ["subscription", "customer", "subscription.latest_invoice"],
                });

                if (sessionData.subscription) {
                    subscriptionData = sessionData.subscription;
                }

                if (sessionData.customer) {
                    customerData = sessionData.customer;
                }
            } catch (stripeError) {
                console.error("Error retrieving Stripe session:", stripeError);
                errorMessage = "Unable to retrieve session details";
            }
        }

        // Generate the HTML response
        const html = generateResultHTML({
            success: success === "true",
            canceled: canceled === "true",
            sessionId: session_id,
            sessionData,
            subscriptionData,
            customerData,
            errorMessage,
        });

        ctx.type = "html";
        ctx.body = html;
    } catch (error) {
        console.error("Error handling Stripe result:", error);

        const errorHtml = generateErrorHTML(error.message);

        ctx.type = "html";
        ctx.body = errorHtml;
        ctx.status = 500;
    }
};

/**
 * Generate HTML for the result page
 * @param {Object} data - Result data
 * @returns {string} HTML string
 */
const generateResultHTML = ({ success, canceled, sessionId, sessionData, subscriptionData, customerData, errorMessage }) => {
    const baseUrl = configuration.base_url;

    if (errorMessage) {
        return generateErrorHTML(errorMessage);
    }

    if (canceled) {
        return `
		<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Subscription Canceled - Zelf</title>
			<style>${getCommonStyles()}</style>
		</head>
		<body>
			<div class="container">
				<div class="result-card canceled">
					<div class="icon-container">
						<svg class="icon canceled-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
							<path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
					</div>
					<h1>Subscription Canceled</h1>
					<p class="subtitle">Your subscription setup was canceled. No charges have been made.</p>
				</div>
			</div>
		</body>
		</html>
		`;
    }

    if (success && subscriptionData) {
        const planName = subscriptionData.metadata?.plan || "Premium";
        const amount = subscriptionData.plan?.amount ? (subscriptionData.plan.amount / 100).toFixed(2) : "N/A";
        const currency = subscriptionData.plan?.currency?.toUpperCase() || "USD";
        const interval = subscriptionData.plan?.interval || "month";
        const customerEmail = customerData?.email || "N/A";
        const nextBilling = subscriptionData.current_period_end ? new Date(subscriptionData.current_period_end * 1000).toLocaleDateString() : "N/A";
        const source = subscriptionData.metadata?.source || (sessionData && sessionData.metadata?.source);

        // Get invoice details
        const latestInvoice = subscriptionData.latest_invoice;
        const invoiceNumber = latestInvoice?.number || "N/A";
        const invoiceDate = latestInvoice?.created ? new Date(latestInvoice.created * 1000).toLocaleDateString() : "N/A";
        const invoicePdfUrl = latestInvoice?.invoice_pdf;
        const invoiceAmount = latestInvoice?.amount_paid ? (latestInvoice.amount_paid / 100).toFixed(2) : amount;

        // Extension redirect JavaScript for extension/app sources
        const extensionRedirectScript =
            source === "extension" || source === "ios" || source === "android"
                ? `
		<script>
			(function() {
				// Try to communicate with extension
				if (typeof chrome !== 'undefined' && chrome.runtime) {
					// Try to send message to extension
					try {
						// Listen for extension messages
						window.addEventListener('message', function(event) {
							if (event.data && event.data.type === 'EXTENSION_REDIRECT') {
								window.close();
							}
						});

						// Post message to extension context
						window.postMessage({ type: 'PAYMENT_SUCCESS', source: '${source}' }, '*');
					} catch (e) {
						console.error('Extension communication not available');
					}
				}

				// Fallback: Show close button after delay
				setTimeout(function() {
					const closeBtn = document.getElementById('close-window-btn');
					if (closeBtn) {
						closeBtn.style.display = 'inline-block';
					}
				}, 2000);
			})();
		</script>`
                : "";

        const extensionCloseButton =
            source === "extension" || source === "ios" || source === "android"
                ? `<button id="close-window-btn" onclick="window.close()" class="button secondary" style="display: none; margin-top: 16px;">
				Close Window & Return to Extension
			</button>`
                : "";

        return `
		<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Subscription Successful - Zelf</title>
			<style>${getCommonStyles()}</style>
			${extensionRedirectScript}
		</head>
		<body>
			<div class="container">
				<div class="result-card success">
					<div class="icon-container">
						<svg class="icon success-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
							<path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
					</div>
					<h1>Subscription Successful!</h1>
					<p class="subtitle">Welcome to ${planName} plan! Your subscription is now active.</p>
					
					<div class="details">
						<div class="detail-row">
							<span class="label">Plan:</span>
							<span class="value">${planName} Plan</span>
						</div>
						<div class="detail-row">
							<span class="label">Amount Paid:</span>
							<span class="value">$${invoiceAmount} ${currency}</span>
						</div>
						<div class="detail-row">
							<span class="label">Recurring:</span>
							<span class="value">$${amount} ${currency}/${interval}</span>
						</div>
						<div class="detail-row">
							<span class="label">Email:</span>
							<span class="value">${customerEmail}</span>
						</div>
						<div class="detail-row">
							<span class="label">Invoice #:</span>
							<span class="value">${invoiceNumber}</span>
						</div>
						<div class="detail-row">
							<span class="label">Invoice Date:</span>
							<span class="value">${invoiceDate}</span>
						</div>
						<div class="detail-row">
							<span class="label">Next Billing:</span>
							<span class="value">${nextBilling}</span>
						</div>
						<div class="detail-row">
							<span class="label">Status:</span>
							<span class="value status-active">Active</span>
						</div>
					</div>
					
					<div class="actions">
						${
                            invoicePdfUrl
                                ? `<a href="${invoicePdfUrl}" target="_blank" class="button primary invoice-button">
							<svg class="button-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
								<polyline points="14,2 14,8 20,8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
								<line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
								<line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
								<polyline points="10,9 9,9 8,9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
							</svg>
							See Invoice PDF
						</a>`
                                : `<span class="button disabled">Invoice PDF not available</span>`
                        }
						${extensionCloseButton}
					</div>
					
					<div class="footer-note">
						<p>🎉 You now have full access to all premium features!</p>
						<p>A confirmation email has been sent to your email address.</p>
						${source === "extension" || source === "ios" || source === "android" ? "<p>You can close this window and return to the extension.</p>" : ""}
					</div>
				</div>
			</div>
		</body>
		</html>
		`;
    }

    // Fallback for success without subscription data
    if (success) {
        const source = sessionData?.metadata?.source;
        const extensionRedirectScript =
            source === "extension" || source === "ios" || source === "android"
                ? `
		<script>
			(function() {
				if (typeof chrome !== 'undefined' && chrome.runtime) {
					try {
						window.addEventListener('message', function(event) {
							if (event.data && event.data.type === 'EXTENSION_REDIRECT') {
								window.close();
							}
						});
						window.postMessage({ type: 'PAYMENT_SUCCESS', source: '${source}' }, '*');
					} catch (e) {
						console.error('Extension communication not available');
					}
				}
				setTimeout(function() {
					const closeBtn = document.getElementById('close-window-btn');
					if (closeBtn) {
						closeBtn.style.display = 'inline-block';
					}
				}, 2000);
			})();
		</script>`
                : "";
        const extensionCloseButton =
            source === "extension" || source === "ios" || source === "android"
                ? `<button id="close-window-btn" onclick="window.close()" class="button secondary" style="display: none; margin-top: 16px;">
				Close Window & Return to Extension
			</button>`
                : "";

        return `
		<!DOCTYPE html>
		<html lang="en">
		<head>
			<meta charset="UTF-8">
			<meta name="viewport" content="width=device-width, initial-scale=1.0">
			<title>Payment Successful - Zelf</title>
			<style>${getCommonStyles()}</style>
			${extensionRedirectScript}
		</head>
		<body>
			<div class="container">
				<div class="result-card success">
					<div class="icon-container">
						<svg class="icon success-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
							<path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
						</svg>
					</div>
					<h1>Payment Successful!</h1>
					<p class="subtitle">Your subscription has been activated successfully.</p>
					
					<div class="actions">
						<a href="${baseUrl}/zelf-keys/billing" class="button primary">View Subscription</a>
						${extensionCloseButton}
					</div>
					${
                        source === "extension" || source === "ios" || source === "android"
                            ? '<div class="footer-note"><p>You can close this window and return to the extension.</p></div>'
                            : ""
                    }
				</div>
			</div>
		</body>
		</html>
		`;
    }

    // Default fallback
    return generateErrorHTML("Invalid request parameters");
};

/**
 * Generate error HTML
 * @param {string} message - Error message
 * @returns {string} HTML string
 */
const generateErrorHTML = (message) => {
    const baseUrl = configuration.base_url;

    return `
	<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Error - Zelf</title>
		<style>${getCommonStyles()}</style>
	</head>
	<body>
		<div class="container">
			<div class="result-card error">
				<div class="icon-container">
					<svg class="icon error-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
						<path d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
					</svg>
				</div>
				<h1>Something went wrong</h1>
				<p class="subtitle">${message}</p>
			</div>
		</div>
	</body>
	</html>
	`;
};

/**
 * Get common CSS styles
 * @returns {string} CSS string
 */
const getCommonStyles = () => {
    return `
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}

		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', sans-serif;
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 20px;
		}

		.container {
			width: 100%;
			max-width: 600px;
		}

		.result-card {
			background: white;
			border-radius: 20px;
			padding: 48px 40px;
			text-align: center;
			box-shadow: 0 20px 60px rgba(0, 0, 0, 0.1);
			position: relative;
			overflow: hidden;
		}

		.result-card::before {
			content: '';
			position: absolute;
			top: 0;
			left: 0;
			right: 0;
			height: 4px;
			background: linear-gradient(135deg, #28a745 0%, #20c997 100%);
		}

		.result-card.canceled::before {
			background: linear-gradient(135deg, #6c757d 0%, #495057 100%);
		}

		.result-card.error::before {
			background: linear-gradient(135deg, #dc3545 0%, #c82333 100%);
		}

		.icon-container {
			margin-bottom: 24px;
		}

		.icon {
			width: 64px;
			height: 64px;
		}

		.success-icon {
			color: #28a745;
		}

		.canceled-icon {
			color: #6c757d;
		}

		.error-icon {
			color: #dc3545;
		}

		h1 {
			font-size: 32px;
			font-weight: 700;
			color: #1a1a1a;
			margin-bottom: 12px;
			letter-spacing: -0.5px;
		}

		.subtitle {
			font-size: 18px;
			color: #666;
			margin-bottom: 32px;
			line-height: 1.5;
		}

		.details {
			background: #f8f9fa;
			border-radius: 12px;
			padding: 24px;
			margin-bottom: 32px;
			text-align: left;
		}

		.detail-row {
			display: flex;
			justify-content: space-between;
			align-items: center;
			padding: 8px 0;
			border-bottom: 1px solid #e9ecef;
		}

		.detail-row:last-child {
			border-bottom: none;
		}

		.label {
			font-size: 14px;
			font-weight: 600;
			color: #666;
			text-transform: uppercase;
			letter-spacing: 0.5px;
		}

		.value {
			font-size: 16px;
			font-weight: 500;
			color: #1a1a1a;
		}

		.status-active {
			color: #28a745;
			font-weight: 600;
		}

		.actions {
			display: flex;
			gap: 16px;
			justify-content: center;
			margin-bottom: 24px;
		}

		.button {
			padding: 14px 28px;
			border-radius: 12px;
			text-decoration: none;
			font-size: 16px;
			font-weight: 600;
			transition: all 0.2s ease;
			display: inline-block;
		}

		.button.primary {
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			color: white;
			box-shadow: 0 4px 16px rgba(102, 126, 234, 0.3);
		}

		.button.primary:hover {
			transform: translateY(-2px);
			box-shadow: 0 6px 20px rgba(102, 126, 234, 0.4);
		}

		.button.secondary {
			background: #f8f9fa;
			color: #666;
			border: 2px solid #e9ecef;
		}

		.button.secondary:hover {
			background: #e9ecef;
			color: #495057;
		}

		.button.invoice-button {
			display: inline-flex;
			align-items: center;
			gap: 8px;
		}

		.button.invoice-button .button-icon {
			width: 20px;
			height: 20px;
		}

		.button.disabled {
			background: #e9ecef;
			color: #6c757d;
			cursor: not-allowed;
			opacity: 0.6;
		}

		.button.disabled:hover {
			transform: none;
			box-shadow: none;
		}

		.footer-note {
			font-size: 14px;
			color: #666;
			line-height: 1.6;
		}

		.footer-note p {
			margin-bottom: 8px;
		}

		.footer-note p:last-child {
			margin-bottom: 0;
		}

		@media (max-width: 768px) {
			.result-card {
				padding: 32px 24px;
			}

			h1 {
				font-size: 28px;
			}

			.subtitle {
				font-size: 16px;
			}

			.actions {
				flex-direction: column;
			}

			.button {
				padding: 12px 24px;
				font-size: 15px;
			}

			.details {
				padding: 20px;
			}

			.detail-row {
				flex-direction: column;
				align-items: flex-start;
				gap: 4px;
				padding: 12px 0;
			}
		}
	`;
};

module.exports = {
    handleWebhook,
    handleStripeResult,
    ignoredAcknowledgement,
};
