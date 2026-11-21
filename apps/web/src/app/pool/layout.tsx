import type { ReactNode } from "react";
import { WalletProviders } from "../wallet/providers";

export const metadata = { title: "Pool" };

export default function PoolLayout({ children }: { children: ReactNode }) {
  return <WalletProviders>{children}</WalletProviders>;
}
