# Evaluation gate

`live-fixtures.json` contains the seven required input-shape smoke fixtures.
They intentionally use `"verified": false` until a human verifies the current
target identity and LinkedIn profiles.

Before production launch:

1. Expand the file to at least 20 independently verified leads.
2. Put only canonical, manually verified profile URLs in
   `expectedLinkedInUrls`, then set `"verified": true`. A verified zero-profile
   target keeps an empty list; any returned URL is then counted as a false
   positive.
3. Start the API and run `npm run evaluate`.
4. Require LinkedIn-match precision of at least 95%.
5. Review coverage separately. Never add uncertain expected or returned
   profiles to improve coverage.

The evaluation script refuses to declare the launch gate passed with fewer
than 20 scored fixtures.
