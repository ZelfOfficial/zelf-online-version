/**
 * Configuration for social media accounts that users need to follow
 * Used for validation of X (Twitter) and LinkedIn follows
 */
module.exports = {
	x: {
		// X (Twitter) accounts that users need to follow
		accounts: [],
		// Validation criteria
		criteria: {
			// Minimum one account must be followed
			minFollows: 1,
			keywords: ["Follow", "Following"],
		},
	},
	linkedin: {
		// LinkedIn accounts/companies that users need to follow
		accounts: [],
		// Validation criteria
		criteria: {
			// Minimum one account must be followed
			minFollows: 1,
			// Keywords to look for in screenshot
			keywords: ["Follow", "Following", "Liza Van den Berg", "liza-van-den-berg"],
		},
	},
};
