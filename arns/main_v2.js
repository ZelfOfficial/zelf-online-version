(function () {
	// Function to run when DOM is ready
	function init() {
		// Extract the subdomain and format it as `username.zelf`
		const isLocalhost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
		const previewHost = new URLSearchParams(window.location.search).get("preview") || "";
		const url = isLocalhost ? previewHost : window.location.hostname;

		// Hostname is "<name>_<domain>[_zelf].<gateway>" on any gateway (ar.io, arweave.net, ar-io.dev, ...).
		const label = (url || "").split(".")[0] || "";
		const parts = label.split("_");
		const undername = parts[0] || "";
		const domain = parts[1] || "zelf";
		const hostZelfName = undername ? `${undername}.${domain}` : "";
		const apiUrl = "https://v4.zelf.world";

		let zelfNameObject = {};
		// v4 Zelf IDs first (IPFS + Arweave), v3 tags as fallback.
		const searchEndpoints = [
			{ path: "/api/zelf-ids/search", environment: "all" },
			{ path: "/api/tags/search", environment: "arweave" },
		];

		// Constants
		const COPY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none">
			<path d="M11.0013 0.666992H3.0013C2.26797 0.666992 1.66797 1.26699 1.66797 2.00033V11.3337H3.0013V2.00033H11.0013V0.666992ZM13.0013 3.33366H5.66797C4.93464 3.33366 4.33464 3.93366 4.33464 4.66699V14.0003C4.33464 14.7337 4.93464 15.3337 5.66797 15.3337H13.0013C13.7346 15.3337 14.3346 14.7337 14.3346 14.0003V4.66699C14.3346 3.93366 13.7346 3.33366 13.0013 3.33366ZM13.0013 14.0003H5.66797V4.66699H13.0013V14.0003Z" fill="currentColor"/>
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

		function setNameLabels(text) {
			const nameElement = document.getElementById("zelfName");
			const copyElement = document.getElementById("zelf-name-copy");
			if (nameElement) nameElement.textContent = text;
			if (copyElement) copyElement.textContent = text;
		}

		function showNotFound(name) {
			setNameLabels(name);
			const lede = document.querySelector(".lede");
			if (lede) lede.textContent = "This Zelf ID was not found yet. If it was just created, try again in a few minutes.";
			document.body.classList.add("zelf-not-found");
		}

		// Show the name from the hostname right away; never fall back to another person's name.
		setNameLabels(hostZelfName);

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

				let data = null;
				for (const endpoint of searchEndpoints) {
					try {
						const url = new URL(`${apiUrl}${endpoint.path}`);
						url.searchParams.append("tagName", tagName);
						url.searchParams.append("domain", domain);
						url.searchParams.append("environment", endpoint.environment);
						url.searchParams.append("type", "mainnet");
						const response = await fetch(url.toString(), { method: "GET", headers });
						if (!response.ok) continue;
						const responseData = await response.json();
						if (responseData?.data?.tagObject) {
							data = responseData.data;
							break;
						}
					} catch (lookupError) {
						console.warn("Zelf ID lookup failed", endpoint.path, lookupError);
					}
				}

				if (!data) {
					showNotFound(`${tagName}.${domain || "zelf"}`);
					return;
				}


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
		function createAddressCard(grid, chainKey, displayName, address, sharedNames) {
			const cardDiv = document.createElement("div");
			cardDiv.className = "card-div";

			const shortenedAddress = `${address.slice(0, 8)}...${address.slice(-8)}`;
			const copyButtonId = `copy${displayName.replace(/\s+/g, "")}Address`;
			const sharedNote = sharedNames?.length ? `<span class="shared-note">Same address on ${sharedNames.join(", ")}</span>` : "";

			cardDiv.innerHTML = `
				<div class="card-address-container name">
					<div class="card-address">
						<span class="chain-pill">${displayName}</span>
						<span class="address-line">
							<span id="${chainKey}">${shortenedAddress}</span>
							${sharedNote}
						</span>
					</div>
					<div class="card-copy-action" id="${copyButtonId}">
						<span>Copy</span>
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
			const sharedByFallback = {};
			requiredChains.forEach((chain) => {
				const address = zelfNameObject.publicData[chain.key];
				if (address || !chain.fallback) return;
				if (!sharedByFallback[chain.fallback]) sharedByFallback[chain.fallback] = [];
				sharedByFallback[chain.fallback].push(chain.displayName);
			});

			requiredChains.forEach((chain) => {
				const address = zelfNameObject.publicData[chain.key];
				if (!address) return;
				createAddressCard(grid, chain.key, chain.displayName, address, sharedByFallback[chain.key]);
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
		if (undername) fetchZelfData(undername, domain || "zelf");
		else showNotFound("");

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
