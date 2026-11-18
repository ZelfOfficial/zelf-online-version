/**
 * Bind host for app.listen.
 *
 * Unset or blank HOST keeps Node's default: listen(port) with no host, which
 * accepts connections on all interfaces. PM2 cluster mode is Node's cluster.
 * Every worker calls the same listen(port, host) and the primary shares that
 * handle. This repo has no ecosystem file; the API is the clustered PM2 app.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|undefined}
 */
const resolveListenHost = (env = process.env) => {
    const raw = env.HOST;

    if (raw == null) return undefined;

    const host = String(raw).trim();

    return host.length ? host : undefined;
};

/**
 * listen() arguments without the callback. A host is included only when HOST is set.
 * @param {number|string} port
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Array<number|string>}
 */
const listenArgs = (port, env = process.env) => {
    const host = resolveListenHost(env);

    return host ? [port, host] : [port];
};

module.exports = {
    resolveListenHost,
    listenArgs,
};
