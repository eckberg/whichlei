# Prototype

A clickable prototype of the search interface. It runs the reference ranking in the
browser over a fixed sample of 2,924 real records from the 2026-09-16 GLEIF golden copy.

    python3 build.py data.js scorer.js whichlei.html

Then open `whichlei.html` in a browser.

`scorer.js` is a browser port of [research/ranking](../../research/ranking/). On the same
records it returns the same top 10 as the reference for all 3,245 evaluation queries.

`shared.css` holds the theme and the record view. The production site (`apps/web`) was built
from these files and now keeps its own copies in `apps/web/static/`: change the look there.
This directory stays as the approved reference and is no longer built.
