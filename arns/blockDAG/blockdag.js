(function () {
	// Function to run when DOM is ready
	function init() {
		// Extract the subdomain and format it as `username.bdag`
		const isLocalhost = window.location.hostname === "localhost";

		const randomlocalhosts = [
			"miguel114_bdag_zelf.arweave.net",
			"john4_bdag_zelf.arweave.net",
			"johnone_bdag_zelf.arweave.net",
		];

		const url = isLocalhost ? randomlocalhosts[Math.floor(Math.random() * randomlocalhosts.length)] : window.location.hostname;

		const undername = url.split("_")[0]; // Get the first part of the subdomain

		// Get the domain part (second segment after underscore, before any dots)
		const domain = url.split("_")[1]?.split(".")[0] || url.split("_")[1] || "bdag";

		// Ensure domain is bdag for BlockDAG
		const finalDomain = domain === "bdag" ? "bdag" : "bdag";

		const apiUrl = isLocalhost ? "http://localhost:3050" : `https://v4.zelf.world`;

		let bdagNameObject = {};
		const apiBaseUrl = `${apiUrl}/api/tags/search`;

		// Currency icon mapping
		const currencyIcons = {
			blockDAG: "https://bn2q32x744st6np7o5q3bdbzorr7jert2n6uxornedveocmw2dsa.arweave.net/C3UN6v_nJT81_3dhsIw5dGP0kjPTfUu6LSDqRwmW0OQ", // BlockDAG icon
			ethereum: "https://dp44frbowjposjoknmyo4bon7om2gk4sdxbag3jnmooxqkz4uzfa.arweave.net/G_nCxC6yXuklymsw7gXN-5mjK5IdwgNtLWOdeCs8pko", // Ethereum icon
			solana: "https://vw3ypbantpnrcc662suuvlnpcl4eewxt2janvyt2jppaabwelaaq.arweave.net/rbeHhA2b2xEL3tSpSq2vEvhCWvPSQNriekveAAbEWAE", // Solana icon
			bitcoin: "https://ai4zitgjrujeosrovx6fkcqj4cfqt3iw7qhi677wj52iih34zkwa.arweave.net/AjmUTMmNEkdKLq38VQoJ4IsJ7Rb8Do9_9k90hB98yqw", // Bitcoin icon
			avalanche: "https://rjzku6wtmhlkitxpklwzsgtjmpfd6tclwkwgrwlywfbnzhkerylq.arweave.net/inKqetNh1qRO71LtmRppY8o_TEuyrGjZeLFC3J1Ejhc", // AVAX icon
			Polygon: "https://ow622ynu5zaenumha7edaxqxaib4k5p6rgdcccgdojpzatqcidma.arweave.net/db2tYbTuQEbRhwfIMF4XAgPFdf6JhiEIw3JfkE4CQNg", // Polygon icon
			bnb: "https://kwrwz2x744st6np7o5q3bdbzorr7jert2n6uxornedveocmw2dsa.arweave.net/VaNs6vF5YUDvYQCC5hHXBnvWaI5E7mfgHvab_FaQdMM", // BNB icon
			Sui: "https://ypl6m7xa4pfbuou25qjcfkbbsk26a4qehcxbhmbqn53a6ik6bg7q.arweave.net/w9fmfuDjyho6muwSIqghkrXgcgQ4rhOwMG92DyFeCb8", // SUI icon
		};

		function _generateUniqueIdentifier() {
			const randomString = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
			return `${randomString}_${navigator.userAgent}`;
		}

		async function getSessionToken() {
			// Check if token already exists and is valid
			const existingToken = localStorage.getItem("sessionToken");
			if (existingToken) {
				return existingToken;
			}

			try {
				const headers = new Headers();
				headers.append("Content-Type", "application/json");

				const options = {
					method: "POST",
					headers: headers,
					body: JSON.stringify({
						identifier: _generateUniqueIdentifier(),
						type: "general",
					}),
				};

				const response = await fetch(`${apiUrl}/api/sessions`, options);

				if (!response.ok) {
					throw new Error(`Failed to fetch session token: ${response.statusText}`);
				}

				const responseData = await response.json();
				const token = responseData.data?.token;

				if (token) {
					localStorage.setItem("sessionToken", token);
					return token;
				}
			} catch (error) {
				console.error("Error fetching session token:", error);
			}
		}

		// Make an API call to fetch the image URL
		async function fetchBdagData(tagName, domain) {
			try {
				// show loading badge while we fetch decentralized data
				setLoading(true);
				// JWT token from localStorage
				await getSessionToken();

				// Set up headers
				const headers = new Headers();
				headers.append("Authorization", `Bearer ${localStorage.getItem("sessionToken")}`);
				headers.append("Content-Type", "application/json");

				// Build URL with query parameters
				const url = new URL(apiBaseUrl);
				url.searchParams.append("tagName", tagName);
				url.searchParams.append("domain", domain);
				url.searchParams.append("environment", "arweave");
				url.searchParams.append("type", "mainnet");

				// Set up GET options
				const options = {
					method: "GET",
					headers: headers,
				};

				// Fetch the data from the API
				const response = await fetch(url.toString(), options);

				// Check if the response is OK
				if (!response.ok) {
					throw new Error(`Failed to fetch data: ${response.statusText}`);
				}

				const responseData = await response.json();
				const data = responseData.data;

				if (!data || !data.tagObject) throw new Error("No tag object received from API");

				bdagNameObject = data.tagObject;

				// Update the image URL in the HTML
				const imageElement = document.getElementById("bdagproof");
				const bdagNameElement = document.getElementById("bdagName");
				const bdagNameCopyElement = document.getElementById("bdag-name-copy");

				if (!imageElement || !bdagNameElement || !bdagNameCopyElement) {
					throw new Error("Required DOM elements not found");
				}

				// Get the tagName from the response or construct it from the request
				const displayTagName = data.tagName || `${tagName}.${domain || "bdag"}`;

				// Set the bdagName in the HTML
				bdagNameElement.innerHTML = displayTagName;
				bdagNameCopyElement.innerHTML = displayTagName;

				if (bdagNameObject.url) {
					imageElement.src = bdagNameObject.url;
					generateAddressCards();
				} else {
					console.error("Image URL not found in the response");
				}
			} catch (error) {
				console.error("Error fetching BDAG data:", error);
			} finally {
				setLoading(false);
			}
		}

		// Helper function to create an address card
		function createAddressCard(grid, chainKey, displayName, address, currencyKey) {
			const cardDiv = document.createElement("div");
			cardDiv.className = "address-card";

			const shortenedAddress = `${address.slice(0, 8)}...${address.slice(-8)}`;
			const copyButtonId = `copy${displayName.replace(/\s+/g, "")}Address`;
			const iconUrl = currencyIcons[currencyKey] || currencyIcons[chainKey] || "https://placehold.co/24x24";

			// Special handling for BlockDAG icon
			const isBlockDAG = currencyKey === "blockDAG";
			let iconHTML = "";

			if (isBlockDAG) {
				iconHTML = `
					<div class="currency-icon-blockdag" data-currency="blockDAG" style="width: 24px; height: 24px; position: relative; background: #0094FF; overflow: hidden; border-radius: 500px; display: flex; align-items: center; justify-content: center">
						<img style="width: 20px; height: 20px; object-fit: contain" src="${iconUrl}" alt="${displayName}" />
					</div>
				`;
			} else {
				iconHTML = `<img class="currency-icon" data-currency="${currencyKey || chainKey}" src="${iconUrl}" alt="${displayName}" />`;
			}

			cardDiv.innerHTML = `
				<div class="address-card-content">
					<div class="address-header">
						${iconHTML}
						<div class="currency-name">${displayName}</div>
					</div>
					<div class="address-text">${shortenedAddress}</div>
				</div>
				<button class="copy-button" id="${copyButtonId}">
					<span>Copy</span>
				</button>
			`;

			grid.appendChild(cardDiv);

			const copyButton = cardDiv.querySelector(`#${copyButtonId}`);
			copyButton.addEventListener("click", function () {
				_writeToClipboard(address);
				copyButton.classList.add("copied");
				setTimeout(() => copyButton.classList.remove("copied"), 600);
			});
		}

		// Function to generate address cards dynamically
		function generateAddressCards() {
			const grid = document.getElementById("addressesGrid");
			if (!grid) {
				console.error("Addresses grid not found");
				return;
			}

			if (!bdagNameObject?.publicData) {
				console.error("BDAG name object or public data not available");
				return;
			}

			// Clear current grid
			grid.innerHTML = "";

			// Get all address properties from publicData
			const addressProperties = Object.keys(bdagNameObject.publicData).filter(
				(key) => key.endsWith("Address") && bdagNameObject.publicData[key]
			);

			// Define the chains we want to display and their display names
			const requiredChains = [
				{ key: "blockDAGAddress", displayName: "BDAG", fallback: "ethAddress", currencyKey: "blockDAG" },
				{ key: "ethAddress", displayName: "ETH", fallback: null, currencyKey: "ethereum" },
				{ key: "solanaAddress", displayName: "SOL", fallback: null, currencyKey: "solana" },
				{ key: "btcAddress", displayName: "BTC", fallback: null, currencyKey: "bitcoin" },
				{ key: "avaxAddress", displayName: "AVAX", fallback: "ethAddress", currencyKey: "avalanche" },
				{ key: "polAddress", displayName: "POL", fallback: "ethAddress", currencyKey: "Polygon" },
				{ key: "bnbAddress", displayName: "BNB", fallback: "ethAddress", currencyKey: "bnb" },
				{ key: "suiAddress", displayName: "SUI", fallback: null, currencyKey: "Sui" },
			];

			// Generate cards for each required chain
			requiredChains.forEach((chain) => {
				let address = bdagNameObject.publicData[chain.key];

				// If the address doesn't exist but we have a fallback, use the fallback address
				if (!address && chain.fallback && bdagNameObject.publicData[chain.fallback]) {
					address = bdagNameObject.publicData[chain.fallback];
				}

				// Only create card if we have an address (either direct or fallback)
				if (address) {
					createAddressCard(grid, chain.key, chain.displayName, address, chain.currencyKey);
				}
			});

			// Also add any additional address properties that might exist but weren't in our required list
			const additionalAddresses = addressProperties.filter((key) => !requiredChains.some((chain) => chain.key === key));

			additionalAddresses.forEach((addressKey) => {
				const address = bdagNameObject.publicData[addressKey];
				const chainName = addressKey.replace("Address", "").toUpperCase();
				const displayName = chainName.charAt(0).toUpperCase() + chainName.slice(1).toLowerCase();

				createAddressCard(grid, addressKey, displayName, address, chainName.toLowerCase());
			});
		}

		// Call the function with the extracted bdagName
		fetchBdagData(undername, finalDomain);

		// Copy referral code handler
		const copyReferralCodeBtn = document.getElementById("copyReferralCode");
		if (copyReferralCodeBtn) {
			copyReferralCodeBtn.addEventListener("click", function () {
				const referralCode = document.getElementById("bdag-name-copy")?.textContent;
				if (referralCode) {
					_writeToClipboard(referralCode);
				}
			});
		}

		// Download app button handler
		const downloadButton = document.getElementById("downloadButton");
		if (downloadButton) {
			downloadButton.addEventListener("click", function () {
				window.open("https://zelf.world/download", "_blank");
			});
		}

		const _writeToClipboard = (text) => {
			navigator.clipboard
				.writeText(text)
				.then(() => {
					showToast("Address copied to clipboard");
				})
				.catch((err) => {
					console.error("Failed to copy text: ", err);
					showToast("Failed to copy", true);
				});
		};

		// Lightweight toast system (no libraries)
		function showToast(message, isError = false) {
			const container = document.getElementById("toastContainer");
			if (!container) return;

			const toast = document.createElement("div");
			toast.className = "toast";
			toast.textContent = message;
			if (isError) {
				toast.classList.add("error");
			}

			container.appendChild(toast);

			// trigger animation
			requestAnimationFrame(() => {
				toast.classList.add("show");
			});

			// auto remove after 2.2s
			setTimeout(() => {
				toast.classList.remove("show");
				setTimeout(() => {
					toast.remove();
				}, 300);
			}, 2200);
		}

		function setLoading(isLoading) {
			const badge = document.getElementById("loadingBadge");
			if (!badge) return;
			badge.style.display = isLoading ? "inline-flex" : "none";
		}
	}

	// Check if DOM is already loaded, otherwise wait for it
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		// DOM is already loaded, run immediately
		init();
	}
})();
