/**
 * Follow-to-claim campaigns. The BlockDAG follow campaign is closed.
 * New claims are rejected in social-campaigns.module.js.
 */
module.exports = {
	enabled: false,
	x: {
		accounts: [],
		criteria: {
			minFollows: 0,
			keywords: [],
		},
	},
	linkedin: {
		accounts: [],
		criteria: {
			minFollows: 0,
			keywords: [],
		},
	},
};
