# ZenWallet Goals

A Progressive Web App (PWA) that connects to your [Zenmoney](https://zenmoney.ru/) account and tracks category-based spending goals.

## Features

- **Token-based auth** — connect with your Zenmoney API token
- **Wallet selection** — choose which wallet/account to track
- **Category goals** — each budget category becomes a goal:
  - **Spending** from that category decreases the goal
  - **Income** with that category increases the goal
  - **Transfers** to the wallet with the category name in the comment increase the goal
- **Offline support** — data is cached locally; works as an installable PWA
- **Dark theme** — modern dark UI

## Getting Started

```bash
npm install --legacy-peer-deps
npm run dev
```

### Getting a Zenmoney Token

You can obtain a token from [zerro.app/token](https://zerro.app/token) or via the [Zenmoney API](https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API).

## Deployment

The app auto-deploys to GitHub Pages on push to `main` via GitHub Actions.

Live URL: `https://<username>.github.io/one-zenwallet/`

## Tech Stack

- React 19 + TypeScript
- Vite 8
- vite-plugin-pwa (Workbox)
- GitHub Pages + GitHub Actions
