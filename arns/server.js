const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const BASE_DIR = __dirname;

// MIME types for different file extensions
const mimeTypes = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpg",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".woff": "application/font-woff",
	".woff2": "application/font-woff2",
	".ttf": "application/font-ttf",
	".eot": "application/vnd.ms-fontobject",
	".otf": "application/font-otf",
	".wasm": "application/wasm",
};

const server = http.createServer((req, res) => {
	console.log(`${req.method} ${req.url}`);

	// Remove query string and decode URI
	let filePath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);

	const hostname = req.headers.host || "";

	// Check if this is a social links domain (e.g., liza_socials_zelf.arweave.net)
	const isSocialLinksDomain = hostname.includes("_socials_") || (hostname === "localhost" && req.url.includes("domain=socials"));

	// Direct route for social links (easier access on localhost)
	if (filePath === "/socials" || filePath === "/socialLinks") {
		filePath = "/socialLinks/index.html";
	}

	// Default to index.html for root
	if (filePath === "/") {
		// Serve social links index if it's a social links domain
		if (isSocialLinksDomain) {
			filePath = "/socialLinks/index.html";
		} else {
			filePath = "/index.html";
		}
	}

	// If requesting root index but it's a social links domain, redirect to social links
	if (filePath === "/index.html" && isSocialLinksDomain) {
		filePath = "/socialLinks/index.html";
	}

	// Remove leading slash and resolve path
	const fullPath = path.join(BASE_DIR, filePath);

	// Security: prevent directory traversal
	if (!fullPath.startsWith(BASE_DIR)) {
		res.writeHead(403, { "Content-Type": "text/plain" });
		res.end("Forbidden");
		return;
	}

	// Get file extension for MIME type
	const ext = path.extname(fullPath).toLowerCase();
	const contentType = mimeTypes[ext] || "application/octet-stream";

	// Read and serve file (always read fresh, no caching)
	fs.readFile(fullPath, (err, data) => {
		if (err) {
			if (err.code === "ENOENT") {
				console.log(`  ❌ 404: ${filePath}`);
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("File not found");
			} else {
				console.log(`  ❌ 500: ${err.code}`);
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end(`Server error: ${err.code}`);
			}
			return;
		}

		// Disable caching for development - always serve fresh content
		const headers = {
			"Content-Type": contentType,
			"Cache-Control": "no-cache, no-store, must-revalidate",
			Pragma: "no-cache",
			Expires: "0",
		};

		console.log(`  ✅ 200: ${filePath} (${(data.length / 1024).toFixed(2)} KB)`);
		res.writeHead(200, headers);
		res.end(data);
	});
});

server.listen(PORT, () => {
	console.log(`Server running at http://localhost:${PORT}/`);
	console.log(`Serving files from: ${BASE_DIR}`);
	console.log("Press Ctrl+C to stop the server");
});
