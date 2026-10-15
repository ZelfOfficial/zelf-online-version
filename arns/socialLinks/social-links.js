(function () {
	// Function to run when DOM is ready
	function init() {
		const isLocalhost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";

		const randomlocalhosts = [
			"liza_socials_zelf.arweave.net",
			"miguel_socials_zelf.arweave.net",
			"johan_socials_zelf.arweave.net",
		];

		const url = isLocalhost ? randomlocalhosts[Math.floor(Math.random() * randomlocalhosts.length)] : window.location.hostname;

		// Extract username from URL like "liza_socials_zelf.arweave.net"
		// The username is the first part before the first underscore
		const username = url.split("_")[0]?.toLowerCase() || "liza";

		// Social profiles mapping object
		const socialProfiles = {
			liza: {
				name: "Liza van den Berg",
				title: "HR and Operations",
				description: "Liza have been in IT recruitment, Sales and Business Development for 13 years as well as been involved in 2 start-ups.",
				profileImage: "https://arweave.net/8nHECUli24cVSaSW_14Tgc96h6CujiempFwrUGWLyRE",
				currency: "blockDAG",
				currencyIcon: "https://arweave.net/C3UN6v_nJT81_3dhsIw5dGP0kjPTfUu6LSDqRwmW0OQ",
				socialLinks: [
					{
						type: "linkedin",
						label: "Follow me on LinkedIn",
						url: "https://www.linkedin.com/in/liza-van-den-berg-0938263b/",
					},
					{
						type: "x",
						label: "Follow me on X",
						url: "https://x.com/blockdag8990",
					},
					{
						type: "email",
						label: "Email me",
						url: "mailto:liza@blockdag.network",
					},
				],
				promoItems: [
					{
						text: "Know more about BlockDAG",
						url: "https://blockdag.network",
						iconType: "world",
					},
					{
						text: "Win 1 year of BDAG name",
						url: "https://zelf.world/bdag-promo/",
						iconType: "world",
					},
					{
						text: "Buy BDAG @ $0.005!",
						url: "https://purchase3.blockdag.network/",
						iconType: "coin",
					},
					{
						text: "Know about Zelf",
						url: "https://zelf.world",
						iconType: "world",
					},
				],
			},
			miguel: {
				name: "Miguel",
				title: "Founder & CEO",
				description: "I'm the founder and CTO of Zelf | Verifik, building the future of decentralized identity and name services.",
				profileImage: "https://arweave.net/1YrzcQ1c2WlFKI0TptUuwCyAUOKVnX3VV9DrXeHNO40",
				currency: "blockDAG",
				currencyIcon: "https://arweave.net/C3UN6v_nJT81_3dhsIw5dGP0kjPTfUu6LSDqRwmW0OQ",
				socialLinks: [
					{
						type: "linkedin",
						label: "Follow me on LinkedIn",
						url: "https://www.linkedin.com/in/migueltrevinom/",
					},
					{
						type: "x",
						label: "Follow me on X",
						url: "https://x.com/miguel_trevinom",
					},
					{
						type: "email",
						label: "Email me",
						url: "mailto:miguel@zelf.world",
					},
				],
				promoItems: [
					{
						text: "Know more about BlockDAG",
						url: "https://blockdag.network",
						iconType: "world",
					},
					{
						text: "Know about Zelf",
						url: "https://zelf.world",
						iconType: "world",
					},
					{
						text: "Win 1 year of BDAG name",
						url: "https://zelf.world/bdag-promo/",
						iconType: "world",
					},
					{
						text: "Buy BDAG @ $0.005!",
						url: "https://purchase3.blockdag.network/",
						iconType: "coin",
					},
					{
						text: "Know about Verifik",
						url: "https://verifik.co",
						iconType: "world",
					},
				],
			},
			johan: {
				name: "Johan Castellanos",
				title: "CEO | CYBERSECURITY • ZK FACE PROOFS • WEB3",
				description:
					'Founder & CEO of Zelf & Verifik. Verifik is Compliance aaS, Onboarding aaS, Authentication aaS tech-enabler for the Americas. My life revolves around thinking, creating and implementing ideas that positively affect everyone (employees and clients) that comes in contact with our brand. "𝐈𝐧 𝐭𝐡𝐞 𝐛𝐞𝐠𝐢𝐧𝐧𝐢𝐧𝐠 𝐰𝐚𝐬 𝐭𝐡𝐞 𝐥𝐨𝐠𝐨𝐬, 𝐭𝐡𝐞 𝐞𝐧𝐭𝐫𝐨𝐩𝐢𝐜 𝐛𝐢𝐭" - 𝐉𝐨𝐡𝐚𝐧 𝐂𝐚𝐬𝐭𝐞𝐥𝐥𝐚𝐧𝐨𝐬',
				profileImage: "https://arweave.net/o60wwYAztZiwDzRm5TRf86LmhYTS0Pf3uSz66EKAV2s",
				currency: "blockDAG",
				currencyIcon: "https://arweave.net/C3UN6v_nJT81_3dhsIw5dGP0kjPTfUu6LSDqRwmW0OQ",
				socialLinks: [
					{
						type: "linkedin",
						label: "Follow me on LinkedIn",
						url: "https://www.linkedin.com/in/johancastellanos/",
					},
					{
						type: "x",
						label: "Follow me on X",
						url: "https://x.com/jbastiancas",
					},
					{
						type: "email",
						label: "Email me",
						url: "mailto:johan@zelf.world",
					},
				],
				promoItems: [
					{
						text: "Know more about BlockDAG",
						url: "https://blockdag.network",
						iconType: "world",
					},
					{
						text: "Know about Zelf",
						url: "https://zelf.world",
						iconType: "world",
					},
					{
						text: "Win 1 year of BDAG name",
						url: "https://zelf.world/bdag-promo/",
						iconType: "world",
					},
					{
						text: "Buy BDAG @ $0.005!",
						url: "https://purchase3.blockdag.network/",
						iconType: "coin",
					},
					{
						text: "Know about Verifik",
						url: "https://verifik.co",
						iconType: "world",
					},
				],
			},
		};

		// Get the profile data based on username, default to liza if not found
		const profile = socialProfiles[username] || socialProfiles.liza;

		// Populate profile information
		function populateProfile() {
			const profileImage = document.getElementById("profileImage");
			const currencyIcon = document.getElementById("currencyIcon");
			const profileName = document.getElementById("profileName");
			const profileTitle = document.getElementById("profileTitle");
			const profileDescription = document.getElementById("profileDescription");

			if (profileImage) {
				profileImage.src = profile.profileImage;
				profileImage.alt = profile.name;
			}

			if (currencyIcon) {
				currencyIcon.src = profile.currencyIcon;
				currencyIcon.alt = profile.currency;
			}

			if (profileName) {
				profileName.textContent = profile.name;
			}

			if (profileTitle) {
				profileTitle.textContent = profile.title;
			}

			if (profileDescription) {
				profileDescription.textContent = profile.description;
			}
		}

		// Generate social links
		function generateSocialLinks() {
			const socialLinksSection = document.getElementById("socialLinksSection");
			if (!socialLinksSection) {
				console.error("Social links section not found");
				return;
			}

			// Clear current links
			socialLinksSection.innerHTML = "";

			// Create social link buttons
			profile.socialLinks.forEach((link) => {
				const linkButton = document.createElement("a");
				linkButton.href = link.url;
				// Don't open email links in new tab
				if (!link.url.startsWith("mailto:")) {
					linkButton.target = "_blank";
					linkButton.rel = "noopener noreferrer";
				}
				linkButton.className = "social-link-button";

				const iconDiv = document.createElement("div");
				iconDiv.className = `social-link-icon ${link.type}`;

				// Add SVG icons for different link types
				if (link.type === "email") {
					const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
					svg.setAttribute("width", "20");
					svg.setAttribute("height", "16");
					svg.setAttribute("viewBox", "0 0 20 16");
					svg.setAttribute("fill", "none");
					svg.style.position = "absolute";
					svg.style.left = "50%";
					svg.style.top = "50%";
					svg.style.transform = "translate(-50%, -50%)";

					const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
					path.setAttribute(
						"d",
						"M18 0H2C0.9 0 0.01 0.9 0.01 2L0 14C0 15.1 0.9 16 2 16H18C19.1 16 20 15.1 20 14V2C20 0.9 19.1 0 18 0ZM18 4L10 9L2 4V2L10 7L18 2V4Z"
					);
					path.setAttribute("fill", "white");

					svg.appendChild(path);
					iconDiv.appendChild(svg);
				} else if (link.type === "x") {
					const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
					svg.setAttribute("width", "18");
					svg.setAttribute("height", "18");
					svg.setAttribute("viewBox", "0 0 18 18");
					svg.setAttribute("fill", "none");
					svg.style.position = "absolute";
					svg.style.left = "50%";
					svg.style.top = "50%";
					svg.style.transform = "translate(-50%, -50%)";

					const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
					path.setAttribute(
						"d",
						"M10.5 8.25L16.5 1.5H15.375L10.125 7.6875L5.8125 1.5H1.5L7.6875 9.75L1.5 16.5H2.625L8.0625 10.125L12.5625 16.5H16.875L10.5 8.25ZM8.4375 9.375L7.875 8.625L2.625 2.4375H5.25L9.75 8.0625L10.3125 8.8125L15.75 15.5625H13.125L8.4375 9.375Z"
					);
					path.setAttribute("fill", "white");

					svg.appendChild(path);
					iconDiv.appendChild(svg);
				} else if (link.type === "linkedin") {
					const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
					svg.setAttribute("width", "18");
					svg.setAttribute("height", "18");
					svg.setAttribute("viewBox", "0 0 18 18");
					svg.setAttribute("fill", "none");
					svg.style.position = "absolute";
					svg.style.left = "50%";
					svg.style.top = "50%";
					svg.style.transform = "translate(-50%, -50%)";

					const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
					path.setAttribute(
						"d",
						"M16.5 0H1.5C0.675 0 0 0.675 0 1.5V16.5C0 17.325 0.675 18 1.5 18H16.5C17.325 18 18 17.325 18 16.5V1.5C18 0.675 17.325 0 16.5 0ZM5.4 15H2.7V6.75H5.4V15ZM4.05 5.625C3.15 5.625 2.475 4.95 2.475 4.05C2.475 3.15 3.15 2.475 4.05 2.475C4.95 2.475 5.625 3.15 5.625 4.05C5.625 4.95 4.95 5.625 4.05 5.625ZM15.525 15H12.825V11.025C12.825 10.125 12.825 9 11.7 9C10.575 9 10.35 9.9 10.35 11.025V15H7.65V6.75H10.275V7.875C10.575 7.275 11.25 6.525 12.6 6.525C15.075 6.525 15.525 8.1 15.525 10.575V15Z"
					);
					path.setAttribute("fill", "white");

					svg.appendChild(path);
					iconDiv.appendChild(svg);
				}

				const textDiv = document.createElement("div");
				textDiv.className = "social-link-text";
				textDiv.textContent = link.label;

				linkButton.appendChild(iconDiv);
				linkButton.appendChild(textDiv);
				socialLinksSection.appendChild(linkButton);
			});
		}

		// Generate promo items
		function generatePromoItems() {
			const promoItems = document.getElementById("promoItems");
			if (!promoItems) {
				console.error("Promo items container not found");
				return;
			}

			// Clear current items
			promoItems.innerHTML = "";

			// Create promo item buttons
			profile.promoItems.forEach((item) => {
				const promoItem = document.createElement("a");
				promoItem.href = item.url;
				promoItem.target = "_blank";
				promoItem.rel = "noopener noreferrer";
				promoItem.className = "promo-item";

				const contentDiv = document.createElement("div");
				contentDiv.className = "promo-item-content";

				const iconDiv = document.createElement("div");
				iconDiv.className = `promo-item-icon ${item.iconType === "square" ? "square" : ""}`;

				if (item.iconType === "coin") {
					// Coin icon for Buy BDAG
					const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
					svg.setAttribute("width", "14");
					svg.setAttribute("height", "14");
					svg.setAttribute("viewBox", "0 0 14 14");
					svg.setAttribute("fill", "none");
					svg.style.position = "absolute";
					svg.style.left = "50%";
					svg.style.top = "50%";
					svg.style.transform = "translate(-50%, -50%)";

					const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
					circle.setAttribute("cx", "7");
					circle.setAttribute("cy", "7");
					circle.setAttribute("r", "6.5");
					circle.setAttribute("stroke", "white");
					circle.setAttribute("stroke-width", "1");

					const innerCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
					innerCircle.setAttribute("cx", "7");
					innerCircle.setAttribute("cy", "7");
					innerCircle.setAttribute("r", "4");
					innerCircle.setAttribute("fill", "white");

					svg.appendChild(circle);
					svg.appendChild(innerCircle);
					iconDiv.appendChild(svg);
				} else if (item.iconType === "image" || item.iconType === "world") {
					// World/globe icon for general links
					const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
					svg.setAttribute("width", "14");
					svg.setAttribute("height", "14");
					svg.setAttribute("viewBox", "0 0 14 14");
					svg.setAttribute("fill", "none");
					svg.style.position = "absolute";
					svg.style.left = "50%";
					svg.style.top = "50%";
					svg.style.transform = "translate(-50%, -50%)";

					const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
					circle.setAttribute("cx", "7");
					circle.setAttribute("cy", "7");
					circle.setAttribute("r", "6");
					circle.setAttribute("stroke", "white");
					circle.setAttribute("stroke-width", "1");

					const path1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
					path1.setAttribute("d", "M1 7C1 7 3 5 7 5C11 5 13 7 13 7");
					path1.setAttribute("stroke", "white");
					path1.setAttribute("stroke-width", "1");

					const path2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
					path2.setAttribute("d", "M1 7C1 7 3 9 7 9C11 9 13 7 13 7");
					path2.setAttribute("stroke", "white");
					path2.setAttribute("stroke-width", "1");

					const path3 = document.createElementNS("http://www.w3.org/2000/svg", "path");
					path3.setAttribute("d", "M7 1C7 1 5 3 5 7C5 11 7 13 7 13");
					path3.setAttribute("stroke", "white");
					path3.setAttribute("stroke-width", "1");

					svg.appendChild(circle);
					svg.appendChild(path1);
					svg.appendChild(path2);
					svg.appendChild(path3);
					iconDiv.appendChild(svg);
				} else if (item.iconType === "square") {
					const squareDiv = document.createElement("div");
					iconDiv.appendChild(squareDiv);
				}

				const textDiv = document.createElement("div");
				textDiv.className = "promo-item-text";
				textDiv.textContent = item.text;

				contentDiv.appendChild(iconDiv);
				contentDiv.appendChild(textDiv);

				// Create arrow SVG icon
				const arrowSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
				arrowSvg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
				arrowSvg.setAttribute("width", "16");
				arrowSvg.setAttribute("height", "16");
				arrowSvg.setAttribute("viewBox", "0 0 16 16");
				arrowSvg.setAttribute("fill", "none");
				arrowSvg.className = "promo-item-arrow";

				const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
				g.setAttribute("opacity", "0.5");

				const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
				path.setAttribute(
					"d",
					"M4.33317 3.6665V4.99984H10.0598L3.6665 11.3932L4.6065 12.3332L10.9998 5.93984V11.6665H12.3332V3.6665H4.33317Z"
				);
				path.setAttribute("fill", "white");

				g.appendChild(path);
				arrowSvg.appendChild(g);

				promoItem.appendChild(contentDiv);
				promoItem.appendChild(arrowSvg);
				promoItems.appendChild(promoItem);
			});
		}

		// Initialize the page
		populateProfile();
		generateSocialLinks();
		generatePromoItems();
	}

	// Check if DOM is already loaded, otherwise wait for it
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		// DOM is already loaded, run immediately
		init();
	}
})();
