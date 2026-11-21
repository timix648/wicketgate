"use client";

// Wallet connection, loaded only on /wallet so the board stays light. QoreX through
// @qorechain/qorex-rainbowkit; testnet only.
import type { ReactNode } from "react";
import { WagmiProvider, createConfig, http } from "wagmi";
import { RainbowKitProvider, connectorsForWallets, darkTheme, lightTheme } from "@rainbow-me/rainbowkit";
import { qorechainTestnet, qorexWallet } from "@qorechain/qorex-rainbowkit";
import "@rainbow-me/rainbowkit/styles.css";

// QoreX is an injected wallet, so WalletConnect is never used; RainbowKit still asks for an id.
const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "wicketgate-qorex-only";

const connectors = connectorsForWallets(
  [{ groupName: "QoreChain", wallets: [() => qorexWallet({ pollAccountsOnFocus: true })] }],
  { appName: "Wicketgate", projectId },
);

const config = createConfig({
  chains: [qorechainTestnet],
  connectors,
  transports: { [qorechainTestnet.id]: http() },
  ssr: true,
});

export function WalletProviders({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <RainbowKitProvider
        modalSize="compact"
        theme={{ lightMode: lightTheme({ accentColor: "#2f6f5e", borderRadius: "small" }), darkMode: darkTheme({ accentColor: "#6fbfa6", accentColorForeground: "#121412", borderRadius: "small" }) }}
      >
        {children}
      </RainbowKitProvider>
    </WagmiProvider>
  );
}
