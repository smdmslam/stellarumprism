## software distribution

to commercialize

how do i distribute the app. 

im assuming its a download and needs an installation package when we get to that point. keep your answer short
For a macOS app, distribution typically goes one of two routes:

1. Mac App Store — Submit through App Store Connect. Apple handles hosting, payments, and updates. Takes a 15–30% cut.
2. Direct distribution — Ship a signed .dmg or .pkg from your own website. Requires:
◦  Apple Developer ID certificate ($99/year)
◦  Code signing (codesign)
◦  Notarization (notarytool) so Gatekeeper allows it
◦  An updater framework (e.g. Sparkle) for auto-updates
◦  A payment/license system (Paddle, Stripe, Gumroad, etc.)

Most indie devs do direct distribution for flexibility, or both for reach.