# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.x (current) | ✅ |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Please report security issues via [GitHub Security Advisories](https://github.com/obalogunolabimpeoluwakanyinsol-ai/soroban-ttl-guardian/security/advisories/new). This keeps the report confidential until a fix is ready.

Include:
- A description of the vulnerability
- Steps to reproduce
- The potential impact
- Any suggested fix

You will receive acknowledgment within 48 hours. We aim for a fix and coordinated disclosure within 90 days.

## Sensitive data in config

The guardian config file contains a `feePayerSecret` — a Stellar secret key. Protect it accordingly:

- Do not commit config files to version control
- Use environment variable substitution or a secrets manager in production
- The fee-payer account should hold only enough XLM to cover extension fees, not your main operational funds

## Scope for security reports

In scope:
- Credential or secret leakage via log output
- Logic errors that cause the guardian to silently skip extensions it should make
- Logic errors that cause the guardian to extend entries it should not

Out of scope:
- Issues in the Stellar RPC endpoint or the Soroban network itself
- Fee-payer account being compromised by the operator's own mishandling of the secret key
