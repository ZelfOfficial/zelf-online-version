const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const net = require("net");
const Koa = require("koa");
const { resolveListenHost, listenArgs } = require("../../Core/listen-host");

const reservePort = () =>
    new Promise((resolve, reject) => {
        const probe = net.createServer();

        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const { port } = probe.address();

            probe.close(() => resolve(port));
        });
    });

const closeServer = (server) =>
    new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });

describe("listen host", () => {
    test("keeps the current all-interfaces listen when HOST is unset or blank", () => {
        expect(resolveListenHost({})).toBeUndefined();
        expect(resolveListenHost({ HOST: "" })).toBeUndefined();
        expect(resolveListenHost({ HOST: "   " })).toBeUndefined();
        expect(listenArgs(3008, {})).toEqual([3008]);
        expect(listenArgs("3008", { HOST: "" })).toEqual(["3008"]);
    });

    test("trims HOST and passes it to listen", () => {
        expect(resolveListenHost({ HOST: " 127.0.0.1 " })).toBe("127.0.0.1");
        expect(listenArgs(3008, { HOST: "127.0.0.1" })).toEqual([3008, "127.0.0.1"]);
    });

    test("server.js uses listenArgs so PM2 workers share the same call", () => {
        const source = fs.readFileSync(path.join(__dirname, "../../server.js"), "utf8");

        expect(source.includes("listenArgs(config.port)")).toBe(true);
        expect(source.includes("app.listen(config.port, () =>")).toBe(false);
    });

    test("app.listen binds 127.0.0.1 when HOST is set and still accepts a request", async () => {
        const app = new Koa();

        app.use((ctx) => {
            ctx.body = "ok";
        });

        const port = await reservePort();
        const server = await new Promise((resolve, reject) => {
            const listening = app.listen(...listenArgs(port, { HOST: "127.0.0.1" }), () => resolve(listening));

            listening.once("error", reject);
        });

        try {
            expect(server.address().address).toBe("127.0.0.1");
            expect(server.address().port).toBe(port);

            const response = await fetch(`http://127.0.0.1:${port}/`);

            expect(response.status).toBe(200);
            expect(await response.text()).toBe("ok");
        } finally {
            await closeServer(server);
        }
    });

    test("cluster workers share listen(port, host), the same shape PM2 cluster mode uses", async () => {
        const port = await reservePort();
        const script = path.join(__dirname, "../fixtures/listen-host-cluster.js");
        const result = await new Promise((resolve, reject) => {
            const child = spawn(process.execPath, [script], {
                env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), WORKERS: "2" },
                stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";

            child.stdout.on("data", (chunk) => {
                stdout += chunk.toString();
            });
            child.stderr.on("data", (chunk) => {
                stderr += chunk.toString();
            });
            child.on("error", reject);
            child.on("exit", (code) => {
                if (code !== 0) {
                    reject(new Error(`cluster listen exited ${code}: ${stderr || stdout}`));
                    return;
                }

                resolve(JSON.parse(stdout.trim()));
            });
        });

        expect(result.body).toBe("ok");
        expect(result.seen).toHaveLength(2);
        for (const worker of result.seen) {
            expect(worker.address).toBe("127.0.0.1");
            expect(worker.port).toBe(port);
            expect(worker.error).toBeUndefined();
        }
    });
});
