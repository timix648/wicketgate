import { fileURLToPath } from "node:url";

/**
 * Modules pulled in by wagmi's bundled connectors (Base Account -> Coinbase CDP SDK, MetaMask SDK) that the wallet
 * never uses: it only connects QoreX. They are optional and not installed, so resolve them to nothing.
 */
const UNUSED_OPTIONAL_MODULES = ["@x402/core/client", "@x402/evm", "@x402/evm/exact/client", "@x402/evm/upto/client", "@x402/svm/exact/client", "@react-native-async-storage/async-storage"];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The app imports deployments/diana.json and the ABIs in packages/core from outside apps/web.
  experimental: { externalDir: true },
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  webpack: (config) => {
    config.resolve.alias = { ...config.resolve.alias, ...Object.fromEntries(UNUSED_OPTIONAL_MODULES.map((m) => [m, false])) };
    // WalletConnect's logger and storage reach for these server-only optionals.
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

export default nextConfig;
