# Contributing to soroban-ttl-guardian

## Before you start

Check existing issues before opening new ones. For security vulnerabilities, see [SECURITY.md](SECURITY.md) — do not open public issues for security bugs.

## Development setup

```bash
npm install
npm run typecheck   # must be clean
npm run lint        # must be clean
npm test            # all tests must pass
npm run build       # must succeed
```

All four checks must pass before submitting a PR.

## What we accept

- Bug fixes with a test that reproduces the bug
- New `Notifier` implementations (as examples or separate packages)
- Performance improvements with measurements
- Documentation improvements

## What is out of scope for v1

- Multi-network support in a single instance
- Web dashboard
- Automatic fee-payer top-up
- Restore-from-archive

These are tracked as issues for future work. Don't implement them as part of this package.

## Pull request process

1. Fork and create a branch off `main`.
2. Write or update tests for your change.
3. Run all checks (typecheck, lint, test, build) — all must be clean.
4. Open a PR with a description of what changed and why.
5. A maintainer will review within a few days.

## Code style

- TypeScript strict mode is enforced.
- No `any` types without a comment explaining why.
- All public methods must have JSDoc comments.
- Errors must be isolated per-entry in `runOnce` — never let one entry's failure throw.
- The append-only log must record every check and every extension attempt.

## License

By contributing, you agree your contributions are licensed under MIT.
