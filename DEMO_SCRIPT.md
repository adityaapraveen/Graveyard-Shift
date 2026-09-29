# Two-minute mock demo

Run `npx wrangler dev --local --env-file .env --var DRY_RUN:false` and open `http://localhost:8787/`. Use the local `ADMIN_SECRET` to sign in. All DNS records are fake `example.test` records.

**0:00–0:20 — Detection.** Show the ranked suspects table. Open the evidence for `old-api.example.test`: unresolved target, age, and reported mock traffic are separate signals. Explain that the score prioritizes investigation; it does not approve deletion.

**0:20–0:40 — Agent.** Ask, “Why does old-api.example.test exist?” The OpenRouter-backed answer must say its purpose is unknown and cite only stored evidence. If the free router is rate limited, say so; the DNS workflow remains independent.

**0:40–1:00 — Explicit approval.** Click “Review plan.” Show the original target, 5-second window, and one unique request threshold. Click “Confirm scream test” to consume the short-lived, record-bound token.

**1:00–1:20 — Scream and resurrection.** Before the countdown ends, send a browser-like request to the quarantined mock hostname or call the authenticated `/api/dev/simulate-scream` endpoint. Show the counted hit and the record returning to its original snapshot. A bot or duplicate hit does not count.

**1:20–1:45 — Quiet deletion.** Repeat with another suspect, such as `staging.example.test`, and let its window end without a hit. Show the obituary card and open `/obituary/mock-2`; point to its born/died timestamps, recorded cause, survivors, last words, and Open Graph metadata.

**1:45–2:00 — Recovery and limits.** Click “Restore from snapshot” on the obituary card to bring the mock record back. State the live-mode boundary: this demo used mock DNS, only HTTP(S) traffic can scream, and a quiet window does not prove non-web services are unused.
