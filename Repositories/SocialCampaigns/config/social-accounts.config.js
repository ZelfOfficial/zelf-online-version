/**
 * Configuration for social media accounts that users need to follow
 * Used for validation of X (Twitter) and LinkedIn follows
 */
module.exports = {
	x: {
		// X (Twitter) accounts that users need to follow
		accounts: [
			{
				username: "@blockdag8990",
				displayName: "Liza",
				description: "Liza's X (Twitter) account",
			},
			// Add more X accounts here as needed
		],
		// Validation criteria
		criteria: {
			// Minimum one account must be followed
			minFollows: 1,
			// Keywords to look for in screenshot
			keywords: ["Follow", "Following", "@blockdag8990", "blockdag8990"],
		},
	},
	linkedin: {
		// LinkedIn accounts/companies that users need to follow
		accounts: [
			{
				username: "liza-van-den-berg-0938263b",
				displayName: "Liza Van den Berg",
				profileUrl: "https://www.linkedin.com/in/liza-van-den-berg-0938263b/",
				description: "Liza Van den Berg's LinkedIn profile - Global Community Manager / HR / Operations at BlockDAG Network",
			},
			// Add more LinkedIn accounts here as needed
		],
		// Validation criteria
		criteria: {
			// Minimum one account must be followed
			minFollows: 1,
			// Keywords to look for in screenshot
			keywords: ["Follow", "Following", "Liza Van den Berg", "liza-van-den-berg"],
		},
	},
};
