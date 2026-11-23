# Build plan

The owner asked for everything at once, built in parallel. Streams own separate files and meet at `api.md`.

| Stream | Owns | Delivers |
|---|---|---|
| **A Domain & engine** | `domain.py`, `engine.py`, routes hook in `server.py`, MCP tools, `test_domain.py` | People, commitments, funds, assets (property, vehicle), claims, purposes; month view, 12-month look-ahead, debt-free, what-if, advice |
| **B UI** | `dashboard.html`, `web/*` | 5-tab nav, Home, People, Plan, More screens, Review stack, quick actions, polish |
| **C Auth & devices** | auth parts of `server.py`, `login.html`, `shortcut` page | Sign-up, forgot password, per-device keys, one-tap iPhone setup, PWA service worker |
| **D Merchant data** | `data/`, `parse.py` categorize, `rules.json` | Larger merchant dataset, fees/interest category, tests |
| **E History import** | `statement.py` | Owner's bank files, last |

Then: merge, full tests, deploy to the owner's Vercel.
