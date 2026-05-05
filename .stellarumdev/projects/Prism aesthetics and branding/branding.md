a) Distinctive styling for Prism

Right now the deck reads as "premium terminal-tool aesthetic" — dark navy + mint accent + monospace. That's correct but generic; it could be Linear, Warp, Antigravity, or any modern infra startup. The brand isn't doing work yet.

The fastest way to make Prism recognizable on sight is to lean into the word: a prism splits white light into a spectrum, and Prism the product splits an LLM's claim into three confidence tiers. The grader's color system IS the brand's color system. Use that as the deck's grammar:

confirmed   →   emerald  (#10b981)   substrate-backed; shippable; "yes"
probable    →   amber    (#f59e0b)   AST/structural; defensible; "maybe"
candidate   →   rose     (#f43f5e)   grep/LLM-only; lead, not proof; "risk"


Concrete moves that stack up to a recognizable identity without rebuilding the deck:

1. Spectrum rule line. A 1px horizontal gradient bar across every slide header — emerald → cyan → amber → rose. Makes the slide instantly Prism. (One CSS gradient, reusable.)
2. Tier-coded accent borders on cards. Today you've got mint for the "real incident" box and rose for "tab closes". Make that systematic: every claim card is bordered emerald/amber/rose by what it asserts. Strengths in green, in-flight bets in amber, problems/risks in rose. By slide 5 the reader has internalized the language.
3. Prism mark. A small triangle glyph (▲ or ◣) in the page-number corner, color-rotated through the spectrum slide-to-slide. Cheap, recognizable, brandable.
4. Stat block hierarchy. Right now every stat card has the same mint border — flatten the visual signal. Make 7 substrate cells and 6 consumers (architecture facts) emerald; make 350+ tests amber (test count keeps moving — defendable but moving); leave 2m 42s and $0.28/MTok un-bordered as raw measurements. The eye learns to read the hierarchy.
5. Drop the second mint highlight on the cover title. That mint rectangle behind "verifier" reads as a placeholder image. Either replace it with a literal small spectrum-split prism graphic, or kill it.

The ROI here is exact: every slide already has the structure — you're just remapping which color goes on which border.