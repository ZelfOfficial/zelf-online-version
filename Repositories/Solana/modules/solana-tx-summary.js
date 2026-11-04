const { getKnownSplDisplay, WSOL_MINT } = require("./solana-spl-known-metadata");

const LAMPORTS_PER_SOL = 1e9;

const accountKey = (key) => (typeof key === "string" ? key : key?.pubkey || "");

const uiAmount = (balance) => {
	const raw = balance?.uiTokenAmount?.uiAmountString ?? balance?.uiTokenAmount?.uiAmount ?? 0;
	const value = Number(raw);
	return Number.isFinite(value) ? value : 0;
};

/** Net token change per mint for `owner`, from the parsed pre/post token balances. */
const tokenDeltasFor = (meta, owner) => {
	const deltas = new Map();
	const add = (balance, sign) => {
		if (balance?.owner !== owner || !balance.mint) return;
		deltas.set(balance.mint, (deltas.get(balance.mint) || 0) + sign * uiAmount(balance));
	};
	(meta.preTokenBalances || []).forEach((b) => add(b, -1));
	(meta.postTokenBalances || []).forEach((b) => add(b, +1));
	return deltas;
};

/** Owner of the token account whose balance of `mint` moved the opposite way the most. */
const tokenCounterparty = (meta, owner, mint, ownerDelta) => {
	const byOwner = new Map();
	const add = (balance, sign) => {
		if (balance?.mint !== mint || !balance.owner || balance.owner === owner) return;
		byOwner.set(balance.owner, (byOwner.get(balance.owner) || 0) + sign * uiAmount(balance));
	};
	(meta.preTokenBalances || []).forEach((b) => add(b, -1));
	(meta.postTokenBalances || []).forEach((b) => add(b, +1));

	let best = "";
	let bestMove = 0;
	for (const [other, delta] of byOwner) {
		const opposite = -Math.sign(ownerDelta) * delta;
		if (opposite > bestMove) {
			best = other;
			bestMove = opposite;
		}
	}
	return best;
};

/** Account whose SOL balance moved the opposite way the most (excluding the owner). */
const solCounterparty = (keys, meta, ownerIndex, ownerDelta) => {
	let best = "";
	let bestMove = 0;
	keys.forEach((key, index) => {
		if (index === ownerIndex) return;
		const delta = Number(meta.postBalances?.[index] ?? 0) - Number(meta.preBalances?.[index] ?? 0);
		const opposite = -Math.sign(ownerDelta) * delta;
		if (opposite > bestMove) {
			best = key;
			bestMove = opposite;
		}
	});
	return best;
};

const roundAmount = (value) => Number(value.toFixed(9));

/**
 * What a parsed transaction (`getTransaction` with `jsonParsed`) did to `owner`'s wallet:
 * direction, amount and asset as the apps show it (`traffic` "IN" / "OUT").
 *
 * - A token (SPL) movement wins over SOL, so a ZNS reward shows as "+10 ZNS" and not as the
 *   lamports the sender spent on fees or the token account.
 * - For SOL, when the owner paid the fee the fee is left out of the amount sent.
 *
 * @param {Object} tx - `getTransaction` result
 * @param {string} owner - wallet address
 * @returns {{ traffic: string, amount: number, asset: string, from: string, to: string, tokenMint?: string } | null}
 */
const summarizeParsedTransaction = (tx, owner) => {
	const meta = tx?.meta;
	const message = tx?.transaction?.message;
	if (!meta || !message || !owner) return null;

	const keys = (message.accountKeys || []).map(accountKey);

	let tokenMint = "";
	let tokenDelta = 0;
	for (const [mint, delta] of tokenDeltasFor(meta, owner)) {
		if (Math.abs(delta) > Math.abs(tokenDelta)) {
			tokenMint = mint;
			tokenDelta = delta;
		}
	}

	if (tokenMint && tokenDelta !== 0) {
		const incoming = tokenDelta > 0;
		const counterparty = tokenCounterparty(meta, owner, tokenMint, tokenDelta);
		const display = getKnownSplDisplay(tokenMint);
		return {
			traffic: incoming ? "IN" : "OUT",
			amount: roundAmount(Math.abs(tokenDelta)),
			asset: tokenMint === WSOL_MINT ? "SOL" : display?.symbol || `${tokenMint.slice(0, 4)}…${tokenMint.slice(-4)}`,
			from: incoming ? counterparty : owner,
			to: incoming ? owner : counterparty,
			tokenMint,
		};
	}

	const ownerIndex = keys.indexOf(owner);
	if (ownerIndex < 0) return null;

	let delta = Number(meta.postBalances?.[ownerIndex] ?? 0) - Number(meta.preBalances?.[ownerIndex] ?? 0);
	if (ownerIndex === 0 && delta < 0) delta += Number(meta.fee || 0);

	const incoming = delta > 0 || (delta === 0 && ownerIndex !== 0);
	const counterparty = delta !== 0 ? solCounterparty(keys, meta, ownerIndex, delta) : ownerIndex === 0 ? "" : keys[0];
	return {
		traffic: incoming ? "IN" : "OUT",
		amount: roundAmount(Math.abs(delta) / LAMPORTS_PER_SOL),
		asset: "SOL",
		from: incoming ? counterparty : owner,
		to: incoming ? owner : counterparty,
	};
};

module.exports = { summarizeParsedTransaction };
