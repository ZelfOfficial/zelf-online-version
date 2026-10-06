(function () {
	// Function to run when DOM is ready
	function init() {
		// Extract the subdomain and format it as `username.zelf`
		const isLocalhost = window.location.hostname === "localhost";

		const randomlocalhosts = [
			"john4_bdag_zelf.arweave.net",
			"jumitrmo_zelf.arweave.net",
			"jumitrmo22_avax_zelf.arweave.net",
		];

		const url = isLocalhost ? randomlocalhosts[Math.floor(Math.random() * randomlocalhosts.length)] : window.location.hostname;

		const undername = url.split("_")[0]; // Get the first part of the subdomain

		// Get the domain part (second segment after underscore, before any dots)
		const domain = url.split("_")[1]?.split(".")[0] || url.split("_")[1];

		const apiUrl = isLocalhost ? "http://localhost:3050" : `https://v4.zelf.world`;

		let zelfNameObject = {};
		const apiBaseUrl = `${apiUrl}/api/tags/search`;

		// Constants
		const COPY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
			<path d="M11.0013 0.666992H3.0013C2.26797 0.666992 1.66797 1.26699 1.66797 2.00033V11.3337H3.0013V2.00033H11.0013V0.666992ZM13.0013 3.33366H5.66797C4.93464 3.33366 4.33464 3.93366 4.33464 4.66699V14.0003C4.33464 14.7337 4.93464 15.3337 5.66797 15.3337H13.0013C13.7346 15.3337 14.3346 14.7337 14.3346 14.0003V4.66699C14.3346 3.93366 13.7346 3.33366 13.0013 3.33366ZM13.0013 14.0003H5.66797V4.66699H13.0013V14.0003Z" fill="white"/>
		</svg>`;

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
		async function fetchZelfData(tagName, domain) {
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

				zelfNameObject = data.tagObject;

				// Update the image URL in the HTML
				const imageElement = document.getElementById("zelfproof");
				const zelfNameElement = document.getElementById("zelfName");
				const zelfNameCopyElement = document.getElementById("zelf-name-copy");

				if (!imageElement || !zelfNameElement || !zelfNameCopyElement) {
					throw new Error("Required DOM elements not found");
				}

				// Get the tagName from the response or construct it from the request
				const displayTagName = data.tagName || `${tagName}.${domain || "zelf"}`;

				// Set the zelfName in the HTML
				zelfNameElement.innerHTML = displayTagName;
				zelfNameCopyElement.innerHTML = displayTagName;

				if (zelfNameObject.url) {
					imageElement.src = zelfNameObject.url;
					generateAddressCards();
				} else {
					console.error("Image URL not found in the response");
				}
			} catch (error) {
				console.error("Error fetching Zelf data:", error);
			} finally {
				setLoading(false);
			}
		}

		// Helper function to create an address card
		function createAddressCard(grid, chainKey, displayName, address) {
			const cardDiv = document.createElement("div");
			cardDiv.className = "card-div";

			const shortenedAddress = `${address.slice(0, 8)}...${address.slice(-8)}`;
			const copyButtonId = `copy${displayName.replace(/\s+/g, "")}Address`;

			cardDiv.innerHTML = `
				<div class="card-address-container name">
					<div class="card-address">
						<span class="chain-pill">${displayName}</span>
						<span id="${chainKey}">${shortenedAddress}</span>
					</div>
					<div class="card-copy-action" id="${copyButtonId}">
						<span>COPY</span>
						<div style="width: 24px; height: 24px; position: relative">
							${COPY_ICON_SVG}
						</div>
					</div>
				</div>
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

			if (!zelfNameObject?.publicData) {
				console.error("Zelf name object or public data not available");
				return;
			}

			// Clear current grid
			grid.innerHTML = "";

			// Get all address properties from publicData
			const addressProperties = Object.keys(zelfNameObject.publicData).filter(
				(key) => key.endsWith("Address") && zelfNameObject.publicData[key]
			);

			// Define the chains we want to display and their display names
			const requiredChains = [
				{ key: "ethAddress", displayName: "ETH", fallback: null },
				{ key: "solanaAddress", displayName: "Solana", fallback: null },
				{ key: "btcAddress", displayName: "BTC", fallback: null },
				{ key: "avaxAddress", displayName: "AVAX", fallback: "ethAddress" },
				{ key: "polAddress", displayName: "Polygon", fallback: "ethAddress" },
				{ key: "bnbAddress", displayName: "BNB", fallback: "ethAddress" },
				{ key: "suiAddress", displayName: "Sui", fallback: null },
			];

			// Generate cards for each required chain
			requiredChains.forEach((chain) => {
				let address = zelfNameObject.publicData[chain.key];

				// If the address doesn't exist but we have a fallback, use the fallback address
				if (!address && chain.fallback && zelfNameObject.publicData[chain.fallback]) {
					address = zelfNameObject.publicData[chain.fallback];
				}

				// Only create card if we have an address (either direct or fallback)
				if (address) {
					createAddressCard(grid, chain.key, chain.displayName, address);
				}
			});

			// Also add any additional address properties that might exist but weren't in our required list
			const additionalAddresses = addressProperties.filter((key) => !requiredChains.some((chain) => chain.key === key));

			additionalAddresses.forEach((addressKey) => {
				const address = zelfNameObject.publicData[addressKey];
				const chainName = addressKey.replace("Address", "").toUpperCase();
				const displayName = chainName.charAt(0).toUpperCase() + chainName.slice(1).toLowerCase();

				createAddressCard(grid, addressKey, displayName, address);
			});
		}

		// Call the function with the extracted zelfName
		fetchZelfData(undername, domain || "zelf");

		// Copy referral code handler
		const copyReferralCodeBtn = document.getElementById("copyReferralCode");
		if (copyReferralCodeBtn) {
			copyReferralCodeBtn.addEventListener("click", function () {
				const referralCode = document.getElementById("zelf-name-copy")?.textContent;
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
				toast.style.background = "rgba(200, 30, 30, 0.92)";
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
