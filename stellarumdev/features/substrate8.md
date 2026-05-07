b) Substrate v8 — what it actually is

The cell: a passive log probe. Today's runtime tier has http_fetch (one request) and e2e_run (scripted multi-step flow) — both are active probes. They make a request and check the response. That misses everything the dev server logs to itself: stack traces, deprecation warnings, slow-query notices, request/response IDs, "EADDRINUSE", silent 500s the test runner didn't see.

v8 contract: tail the dev server's stdout/stderr (or a configurable log file) for a bounded window — say 10 seconds after an edit lands — and parse for lines matching known shapes (HTTP status, panic, exception, console.error, etc). Return them as Diagnostics with source: "runtime-log". Same shape every other cell uses, so the Problems panel + grader + report all inherit the new evidence for free.

Why it unlocks verticals:

•  /audit after a /build. Right now /build runs typecheck + tests. With v8 it can also boot the dev server, hit the new route, and read the log — catching the Cannot find module 'foo' that tsc couldn't see because it was a runtime import.
•  Production-style evidence. Every team that runs a staging server already has logs; v8 turns those into substrate evidence at no extra cost. That's the foothold for the enterprise tier (self-hosted log pipe → Prism reviewer).
•  The "silent incompleteness" claim from slide 2 gets stronger. Half-rewired routes, drifted types, dead imports — these usually scream in the runtime log first. v8 catches them before users do.

Why it's last in the substrate sequence: it's the only cell whose evidence isn't reproducible from a static repo state. Logs depend on runtime. We needed e2e_run first to give us a controlled way to cause the log lines we want to read.

Engineering size: ~1 week. The cell itself is straightforward (PTY/file tail + regex bank); the work is the matcher library and the integration test harness for "did v8 catch the planted bug."

c) What's next — three ranked options

Picking based on leverage-per-week:

1. /explain + /review-pr (days, not weeks). Pure consumer adds, no new substrate work. They harvest the architecture you've already built. /explain @file is the hidden killer feature for the comprehensive-context wedge from slide 7-old. /review-pr <ref> is the natural extension of /audit to PR review and the obvious GitHub-marketplace play. Investor-visible. Demo-able. Cheap.
2. Substrate v8 (1 week). The next architectural layer. Strengthens slide 2 ("we catch silent incompleteness") and unlocks the enterprise log-pipe story. Single biggest "credible roadmap → shipped" move available.
3. Polish / GTM. prism.dev landing page, a 90-second demo GIF that lives at the top of the README, the prism-audit GitHub Action published to the marketplace. Zero new product work; entirely about converting the existing surface into reach. This is what gets you the first 100 individual users.

If I were ranking by what makes the deck you just refreshed actually true: #1 first (because two new consumers in days makes "compounding now" not just a slogan), then #3 (because the deck implies trajectory, and the marketplace listing is the cheapest evidence of one), then #2 (the bigger architectural bet, taken once the consumer-velocity story is locked in).