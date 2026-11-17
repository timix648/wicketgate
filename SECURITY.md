# Security

Found a way to take funds from the pool, fake an attestation, block an exit, or anything else? Please tell us, privately, even in a public place.

## Report it sealed (post-quantum, no account needed)

Reports are encrypted in your terminal to the Wicketgate security key: an ML-KEM-1024 key registered on the QoreChain testnet for `qor16087dpc985wvk6hlsl2x8p0kyumz394q0lvm6k`, bound to its X25519 key by a recipient card signed with ML-DSA-87 ([cards/security.json](cards/security.json)). The sealed text is safe to post anywhere: only the team can open it, now or after quantum computers can break today's encryption.

```bash
git clone https://github.com/timix648/wicketgate && cd wicketgate && pnpm install
cd packages/scripts
npx tsx src/disclose.ts "what you found, how to reproduce it, and your contact"
```

Paste the printed `qoreseal:` text into a new GitHub issue titled **Sealed security report**. We answer within 48 hours during the fest.

How it is sealed: QoreSeal hybrid mode (ML-KEM-1024 + X25519, AES-256-GCM), bound to the chain id `qorechain-diana` and the purpose `wicketgate-security-report`, so the envelope cannot be opened under any other purpose. The registration transaction is `5D96D05590383D615560E3DA2FE15024E4B19A474FCDAEE453557B34FAE1659E`.

## Scope

The contracts in `contracts/src`, the watcher, the operator and the scripts, as deployed on the testnet (addresses in [deployments/diana.json](deployments/diana.json)). Known limits are in [LIMITS.md](LIMITS.md) and the threat model in [THREAT_MODEL.md](THREAT_MODEL.md).

Everything here is testnet only and holds no real value.
