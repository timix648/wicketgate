import type { ReactNode } from "react";
import { WalletProviders } from "./providers";

export const metadata = { title: "Wallet" };

export default function WalletLayout({ children }: { children: ReactNode }) {
  return <WalletProviders>{children}</WalletProviders>;
}
