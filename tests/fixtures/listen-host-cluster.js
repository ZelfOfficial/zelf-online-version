/**
 * Two workers call listen(port, host), the same call PM2 cluster mode makes
 * in each worker. Prints one JSON line: { seen, body }.
 */
const cluster = require("cluster");
const http = require("http");

const host = process.env.HOST;
const port = Number(process.env.PORT);
const workers = Number(process.env.WORKERS || 2);

if (!host || !Number.isInteger(port)) {
    console.error("HOST and PORT are required");
    process.exit(1);
}

if (cluster.isPrimary) {
    const seen = [];
    const timer = setTimeout(() => {
        console.error("workers did not bind");
        process.exit(1);
    }, 8000);

    for (let index = 0; index < workers; index += 1) cluster.fork();

    cluster.on("message", (_worker, message) => {
        seen.push(message);

        if (seen.length < workers) return;

        clearTimeout(timer);

        fetch(`http://${host}:${port}/`)
            .then((response) => response.text())
            .then((body) => {
                process.stdout.write(`${JSON.stringify({ seen, body })}\n`);
                process.exit(body === "ok" ? 0 : 1);
            })
            .catch((error) => {
                console.error(error.message);
                process.exit(1);
            });
    });
} else {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
    });

    server.on("error", (error) => {
        if (process.send) process.send({ error: error.message });
    });

    server.listen(port, host, () => {
        const address = server.address();

        process.send({ address: address.address, port: address.port });
    });
}
