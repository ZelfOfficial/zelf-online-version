// Batched BNB + BEP-20 balances in ONE eth_call through Multicall3 (same approach MetaMask uses with its
// single-call balance checker): aggregate3([getEthBalance(user), token.balanceOf(user) ...]).

const { Interface } = require("ethers");

const { rpcCall } = require("./bsc-rpc.module");

// Multicall3 is deployed at the same address on BSC (verified: contract code present).
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const multicall3 = new Interface([
	"function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
	"function getEthBalance(address addr) view returns (uint256 balance)",
]);

const erc20 = new Interface(["function balanceOf(address owner) view returns (uint256)"]);

/** Build the aggregate3 calldata: index 0 = native BNB, then one balanceOf per token (allowFailure so one bad token can't break the batch). */
const encodeBalancesCall = (userAddress, tokens) => {
	const calls = [
		{ target: MULTICALL3_ADDRESS, allowFailure: true, callData: multicall3.encodeFunctionData("getEthBalance", [userAddress]) },
		...tokens.map((t) => ({ target: t.contractAddress, allowFailure: true, callData: erc20.encodeFunctionData("balanceOf", [userAddress]) })),
	];

	return multicall3.encodeFunctionData("aggregate3", [calls]);
};

/** Decode aggregate3 output into { nativeWei: bigint, tokenBalances: Map<lowercased contract, bigint> } (failed sub-calls are skipped). */
const decodeBalancesResult = (returnData, tokens) => {
	const [results] = multicall3.decodeFunctionResult("aggregate3", returnData);

	const read = (i, iface, fn) => {
		const r = results[i];

		if (!r || !r.success || !r.returnData || r.returnData === "0x") return null;

		try {
			return BigInt(iface.decodeFunctionResult(fn, r.returnData)[0]);
		} catch (_) {
			return null;
		}
	};

	const tokenBalances = new Map();

	tokens.forEach((t, i) => {
		const raw = read(i + 1, erc20, "balanceOf");

		if (raw !== null) tokenBalances.set(t.contractAddress.toLowerCase(), raw);
	});

	return { nativeWei: read(0, multicall3, "getEthBalance") ?? 0n, tokenBalances };
};

/**
 * Native BNB + every curated token balance with one RPC round trip.
 * @param {string} userAddress
 * @param {Array<{contractAddress: string}>} tokens
 */
const getBalancesInSingleCall = async (userAddress, tokens) => {
	const { result, rpc } = await rpcCall("eth_call", [{ to: MULTICALL3_ADDRESS, data: encodeBalancesCall(userAddress, tokens) }, "latest"]);

	return { ...decodeBalancesResult(result, tokens), rpc };
};

module.exports = { MULTICALL3_ADDRESS, encodeBalancesCall, decodeBalancesResult, getBalancesInSingleCall };
