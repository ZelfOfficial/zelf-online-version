module.exports = (server) => {
    //A
    require("../Repositories/ServerVersion/routes/server-version.routes")(server);
    require("../Repositories/AppVersion/routes/app-version.routes")(server);
    //B
    //C
    require("../Repositories/Client/routes/unprotected-client.route")(server);
    require("../Repositories/BlockDAG/routes/blockdag-nft-public.routes")(server);
    require("../Repositories/BlockDAG/routes/blockdag-public.routes")(server);
    require("../Repositories/Blogs/routes/blog-public.routes")(server);
    //D
    //E
    //F
    //G
    //H

    //I
    require("../Repositories/IPFS/routes/open-ipfs.routes")(server);
    //J
    //K
    //L
    require("../Repositories/Lawyer/routes/unprotected-lawyer.routes")(server);
    //M
    require("../Repositories/Mail/routes/mail.route")(server);

    //N
    //O
    //P
    require("../Repositories/PreSale/routes/pre-sale.routes")(server);

    //Q
    //R
    /** JSON-RPC proxy: no JWT; IP limits via Repositories/RPCCaller. */
    require("../Repositories/RPC/routes/rpc.routes")(server);
    //S
    require("../Repositories/SuperAdmin/routes/super-admin.route")(server);
    require("../Repositories/Session/routes/session.route")(server);
    require("../Repositories/Stripe/routes/stripe.routes")(server);
    require("../Repositories/Subscribers/routes/subscriber.route")(server);
    require("../Repositories/ZelfKeysSubscription/routes/zelf-keys-subscription.routes")(server);
    require("../Repositories/Staff/routes/unprotected-staff.route")(server);
    //T
    require("../Repositories/TON/routes/ton-unprotected.route")(server);
    //U
    //V
    require("../Repositories/VaultLegacy/routes/vault-legacy.routes")(server);
    //W
    require("../Repositories/WhatsApp/routes/whatsapp.route")(server);
    require("../Repositories/Wallet/routes/unprotected-wallet.route")(server);
    //X
    //Y
    //Z
    require("../Repositories/ZelfProof/routes/zelf-proof.route")(server);
    require("../Repositories/HumanAuthn/routes/human-authn.route")(server);
};
