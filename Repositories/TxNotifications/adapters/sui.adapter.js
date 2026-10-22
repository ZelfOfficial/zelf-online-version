const { formatUnits } = require("../modules/amount.util");
const { suiCoin } = require("../modules/tokens");
const { querySuiGraphql } = require("../../sui/modules/sui-graphql.client");

/**
 * Sui via GraphQL. JSON-RPC `suix_queryTransactionBlocks` is gone on mainnet, so
 * this follows `transactions(filter: { affectedAddress })` and reads balance
 * changes. The endpoint list is shared with /api/sui: `${SUI_RPC_URL}/graphql`
 * when that base is configured, then the public mainnet GraphQL service.
 * SUI and curated coins only; transactions the owner sent are ignored.
 */

const TRANSACTION_FIELDS = `
    pageInfo { endCursor }
    nodes {
      digest
      sender { address }
      effects {
        status
        timestamp
        balanceChanges(first: 50) { nodes { owner { address } amount coinType { repr } } }
      }
    }`;

const SEED_QUERY = `query TxWatcherSuiSeed($address: SuiAddress!) {
  transactions(last: 10, filter: { affectedAddress: $address }) {${TRANSACTION_FIELDS}
  }
}`;

const NEXT_QUERY = `query TxWatcherSuiNext($address: SuiAddress!, $after: String) {
  transactions(first: 25, after: $after, filter: { affectedAddress: $address }) {${TRANSACTION_FIELDS}
  }
}`;

/** GraphQL transaction node → incoming transfer for `address`, or null. */
const parseSuiTransaction = (node, address) => {
    if (!node?.digest || node.effects?.status !== "SUCCESS") return null;
    if (String(node.sender?.address || "").toLowerCase() === address) return null;

    const timestampMs = Date.parse(node.effects.timestamp);
    if (!Number.isFinite(timestampMs)) return null;

    const changes = node.effects.balanceChanges?.nodes || [];
    const incoming = changes
        .filter((change) => String(change?.owner?.address || "").toLowerCase() === address)
        .map((change) => ({ change, coin: suiCoin(change.coinType?.repr), raw: BigInt(String(change.amount ?? "0")) }))
        .filter((entry) => entry.coin && entry.raw > 0n)
        .sort((a, b) => Number(Boolean(a.coin.native)) - Number(Boolean(b.coin.native)));

    if (!incoming.length) return null;
    const { coin, raw } = incoming[0];

    return {
        network: "sui",
        hash: node.digest,
        amount: formatUnits(raw, coin.decimals),
        asset: coin.symbol,
        from: node.sender?.address || null,
        timestampMs,
        native: Boolean(coin.native),
    };
};

const query = async (text, variables) => {
    const data = await querySuiGraphql(text, variables);
    return data?.transactions || { nodes: [], pageInfo: {} };
};

const poll = async ({ address, state = {}, seen, minTimestampMs }) => {
    const owner = String(address).toLowerCase();
    const seeding = !state.cursor;
    const page = seeding ? await query(SEED_QUERY, { address: owner }) : await query(NEXT_QUERY, { address: owner, after: state.cursor });

    const nodes = page.nodes || [];
    const cursor = nodes.length && page.pageInfo?.endCursor ? page.pageInfo.endCursor : state.cursor || null;

    const observed = [];
    const transfers = [];
    for (const node of nodes) {
        if (!node?.digest) continue;
        observed.push(node.digest);
        if (seen.has(node.digest)) continue;
        const transfer = parseSuiTransaction(node, owner);
        if (transfer && transfer.timestampMs >= minTimestampMs) transfers.push(transfer);
    }

    // An account with no transactions yet has no cursor: stay in seed mode until it has one.
    return { state: { cursor }, transfers, observed };
};

module.exports = {
    network: "sui",
    parseSuiTransaction,
    poll,
};
