# Contributing

Thanks for your interest in AgentValet!

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test --if-present
```

## Ground rules

- Keep changes scoped and add tests where it makes sense.
- The client packages here must never embed secrets or backend hostnames —
  all network access goes through the public proxy at `https://api.agentvalet.ai`
  (override with `AGENTVALET_API_URL` for self-hosting).
- By contributing you agree your contributions are licensed under the MIT License.

## Reporting issues

Open an issue on GitHub. For security reports, see [SECURITY.md](./SECURITY.md).
