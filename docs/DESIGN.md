# Design

The design language for rbitcoin.space. The tokens live in [`design/tokens.css`](../design/tokens.css). A static prototype of the home, block and transaction pages is in [`design/prototype/`](../design/prototype/); it predates the calmer design of the November 2026 design council and shows the earlier one, so the app, not the prototype, is the reference for how things look.

## Goal

A block explorer that answers the question a reader came with before it explains anything, in a calm interface where the figures are the loudest thing on the page, with motion that makes live data easy to follow.

## Idea: sediment, quietly

Transactions settle out of the mempool into blocks the way sediment settles into layers. The idea stays in the logo, in the words, and in how a block is drawn, but it no longer paints every surface:

- **A block is a core sample.** A block tile shows its fee make-up as layers settled in a box the size of the block's capacity: cheapest at the bottom, each layer as thick as the virtual size paying that band, the room above them the space the block left. A block's own page draws every transaction as a rectangle in a clean block outline, as high as the block is full, the dearest at the top left.
- **Fee rate is intensity.** Cheap is a quiet steel grey, dear a strong blue-violet, through blue. The scale keeps its resolution between 0.1 and 5 sat/vB, where almost all traffic now sits, and it never uses red: an ordinary fee is never an error.
- **Mined is solid, projected is provisional.** Mined tiles are filled and outlined. Projected tiles are dashed and open. When a block is found, the next projected tile crosses the "now" line and sets.
- **Palette:** cool neutral greys with one accent, rhodonite pink, for interaction. The accent is never a fee colour.

## Principles

1. **Answer first.** Every page opens with a compact answer to its reader's question: the fee to pay, a block's facts, a transaction's status and amount. The drawing and the explanation follow.
2. **Numbers are the content.** Every figure uses tabular digits. Amounts, rates and sizes are aligned, grouped and never squeezed. In a summary, magnitude first (`2 793 BTC`), the exact value on inspection; full precision where accounting needs it. Decoration never competes with a number.
3. **Colour carries fee, status or interaction, never two at once.** The fee ramp is for fee rate, in the drawings and their keys, not as a swatch beside every number. Status uses the positive, caution and negative tokens, always with an icon and a word; red is for real problems only. The accent marks interaction: links on hover, focus, the current page, the block that just landed.
4. **Never colour alone.** A fee colour is always next to its number or its key. A status colour always has an icon and a word.
5. **Explanations are a second layer.** The one sentence that changes what a number means stays beside it. Methodology and longer notes sit behind a disclosure ("How these figures are made") a keyboard reaches. Each thing is said once, where it matters most.
6. **Motion explains a change.** Something moves only when the data changed or the user acted. One orchestrated moment per event, never ambient decoration.
7. **The network is never ambiguous.** A test network shows a band with its warning in words, a recoloured logo and a recoloured network switch.
8. **Chain data is text.** Transaction data, coinbase tags, OP_RETURN text and Lightning aliases are attacker-controlled. They are set with `textContent` and never parsed as HTML ([`SECURITY.md`](SECURITY.md) rule 14). The prototype builds every node with one helper that only creates text nodes.
9. **Sentence case everywhere.** No all-caps labels and no decorative eyebrows above headings.

## What to keep from the genre

The ideas people already understand: blocks as tiles in a strip, with projected blocks on the left and mined blocks on the right, the fee to pay right after them, and a block's transactions drawn as a packed map sized by virtual size.

## What is our own

The visual identity: logo, colour, type, spacing, motion, the fee ramp, the tile gauge, the "now" line, the network band. Nothing is copied from mempool.space, and its source code is never consulted.

## Constraints

| Constraint | Why |
|---|---|
| No third-party requests: fonts, icons and scripts are self-hosted | Privacy, and the Content-Security-Policy is `default-src 'self'` |
| Light and dark themes | Both are first-class |
| Works at phone width | No horizontal page scroll |
| WCAG AA contrast | Text 4.5:1, fee colours and controls 3:1, on every surface in both themes |
| Motion respects `prefers-reduced-motion` | Accessibility |
| Animations hold 60 fps | Use transform and opacity; heavy scenes are WebGL |
| Design tokens are CSS custom properties, with no CSS-in-JS runtime | Performance budget in [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Chain data is always rendered as text | [`SECURITY.md`](SECURITY.md) |

## Color

Light is the default. Dark follows the OS, and `<html data-theme="light">` or `data-theme="dark"` forces either. The dark values appear twice in `tokens.css`, once for the OS setting and once for the forced choice. Keep the two blocks identical.

### Surfaces

Neutral grounds with a faint cool cast. In light, a near-white page with white panels; in dark, a charcoal page with panels a clear step lighter, so what belongs together reads as one group. A page's sections are panels (see "Space, shape and layout").

| Token | Light | Dark | Use |
|---|---|---|---|
| `--color-bg` | `#f4f6f7` | `#121518` | Page background |
| `--color-surface` | `#ffffff` | `#1b1f23` | Panels, header, mined tiles |
| `--color-surface-raised` | `#ffffff` | `#252a2f` | Tooltips, menus |
| `--color-surface-sunken` | `#eef1f3` | `#0e1113` | Block strip band, inputs, wells inside panels (the fee answers), the grid frame |
| `--color-line` | `#e1e6e9` | `#2c3237` | Panel borders, hairlines between rows |
| `--color-line-strong` | `#7a868d` | `#6f7b83` | Control borders, projected tile outline (3:1 on every surface) |
| `--color-text` | `#161b1e` | `#e6eaed` | Body text |
| `--color-text-muted` | `#56616a` | `#9aa4ab` | Labels, units, dimmed zeros (4.5:1 on every surface) |
| `--color-accent` | `#a8196b` | `#f27ab9` | Focus ring, current page, hover, landing block |
| `--color-accent-soft` | `#f8e1ed` | `#3b2230` | Highlight behind new rows, pressed toggles |
| `--color-on-accent` | `#ffffff` | `#1a0a12` | Text on the accent |
| `--color-focus` | accent | accent | Focus outline |
| `--color-positive` | `#1b6e43` | `#5fd39a` | Confirmed, copied |
| `--color-caution` | `#8a5a00` | `#f0b43c` | Unconfirmed, waiting, node not answering |
| `--color-negative` | `#b42318` | `#ff8a7a` | Replaced, dropped, missing from an audit, errors |
| `--color-live` | `#1f6f9c` | `#6cb0dc` | The breathing dot of a page that updates itself: about the page, not the data |

All text tokens reach 4.5:1 and `--color-line-strong` reaches 3:1 against `bg`, `surface`, `surface-raised` and `surface-sunken` in both themes. If you add a surface, measure again.

Incoming amounts are not green: a `+` sign carries the direction. Green means confirmed, and nothing else.

### Fee scale

Twelve bands, one sequential ramp across neighbouring hues: a quiet steel grey for the cheapest, through blue, to a strong blue-violet for the dearest. Lightness stays nearly constant and colourfulness rises with the fee, so the ramp reads as "quiet to strong" on a white page and a charcoal one alike, and **the same rate is the same colour in both themes**: the fee tokens have one set of values. No band is red, green, amber or pink, so a fee never looks like a status or an error. Band thresholds are in sat/vB, lower bound inclusive.

| Token | Band | Colour |
|---|---|---|
| `--fee-1` | under 0.12 | `#868a8d` |
| `--fee-2` | 0.12 to 0.15 | `#798791` |
| `--fee-3` | 0.15 to 0.2 | `#6b8494` |
| `--fee-4` | 0.2 to 0.3 | `#698aa0` |
| `--fee-5` | 0.3 to 0.5 | `#688fac` |
| `--fee-6` | 0.5 to 1 | `#5885b7` |
| `--fee-7` | 1 to 1.5 | `#5c89c3` |
| `--fee-8` | 1.5 to 2 | `#5d86ce` |
| `--fee-9` | 2 to 3 | `#6182d7` |
| `--fee-10` | 3 to 5 | `#687ce0` |
| `--fee-11` | 5 to 10 | `#7176e7` |
| `--fee-12` | 10 and up | `#7b6fed` |

- **Why the low end is split three ways:** with the node's minimum at 0.10 sat/vB, "under 0.2" held about 98% of the mempool in November 2026, almost all of it between 0.10 and 0.13. At 0.12 and 0.15 the bulk divides: about a third under 0.12, most of the rest at 0.12 to 0.15. So a drawing can say whether 0.11 clears before 0.15.
- **The low end is the quietest:** five steps from grey to a light steel blue, chroma 0.007, 0.022, 0.038, 0.050 and 0.062 (OKLCH), at lightness 0.60 to 0.63, each about 0.02 from its neighbours in OKLab, as the upper bands are. Then blue (L 0.605, C 0.091, h 252). Bands 7 to 12 are L 0.623 to 0.615, C 0.101 to 0.183 and h 255 to 284, evenly stepped. Rebuild them that way if the thresholds change.
- The thresholds are shared with the server, which bands the projected blocks, block facts and mempool history the same way (`FEE_BOUNDS` in `web/src/lib/format.ts`, `BAND_EDGES` in `crates/engine/src/projected/model.rs`). Change both together; change the thresholds, not the colours, if fee levels move.
- **Before the split:** blocks and mempool minutes stored before the lowest band was split (13 November 2026) carry ten bands, all under 0.2 in one (docs/API.md). A tile or a block's strata draw that whole in the grey of `--fee-1`, and name it "under 0.20 sat/vB". The mempool history draws those minutes as one bottom layer in the same grey, "under 0.2 sat/vB, not yet split"; where its minutes end, the three finer bands begin, so the join is where the one layer stops and three take its place (and the other way, where a roll-up mixes the two), on a vertical edge at one point, the total unchanged across it. Only the drawing joins: the readout and the figures give each point as recorded.
- Band the rate as printed, not the raw value: 0.1996 sat/vB prints as `0.20` and takes band 4, and 0.1196 prints as `0.12` and takes band 2, so the colour never disagrees with the number next to it.
- Every fee colour reaches 3:1 against every surface in both themes (the least is 3.03, `--fee-5` on white), which WCAG requires for graphics. Fee colours are fills: rectangles, gauges, layers and keys. They are never used as text colour.
- **Where fee colour goes:** the block map, a tile's layers, the mempool's rows by fee band, the mempool history's layers, a transaction's fee ribbon, and the key beside the drawing that needs one. Not beside numbers in tables, facts or the fee panel: the number says it. `FeeRate` draws a swatch only when asked (`swatch`), as the map's tooltip does.

### Charts

Series that are not fees take their own two colours, never a fee or status colour: `--series-1` (light `#1f6f9c`, dark `#6cb0dc`), a calm blue, solid, for the main series and its area; `--series-2` (light `#9a6412`, dark `#d9a24c`), an ochre, dashed, for the second; `--series-3` is the muted text colour. An area is filled only over an axis that starts at zero: over a cut axis the line stands alone, so a change is not overstated.

**A chart draws what was recorded, and nothing between.** Where the record knows the moment a value changed (a node's channels open and close in blocks), the line holds flat and steps at that moment; where it only samples (the network's totals every ten minutes), each sample is a dot once samples stand 24 px apart, so a line between two reads as two looks, never as a measured ramp.

**Mining pools** are the one small set of categories on the site, and only in the pool-share charts, always named beside their colour. A colour belongs to a pool by name, not by rank, so a pool has one colour at every period and in the share bar, the weekly chart and their keys alike. Twelve pools have one (`COLOURED_POOLS` in `web/src/pages/mining/mining.ts`): the twelve that reach a period's top six over the last year and all of history, as of November 2026; revise the list when another one does. A period draws its own six largest of them, so the graphic agrees with the top of the table beside it, and counts every other pool as "Other pools" in `--pool-other`, a neutral grey; the table names them all. `--pool-1` to `--pool-12`, in the list's order (Foundry USA, AntPool, F2Pool, ViaBTC, SpiderPool, MARA Pool, Luxor, SecPool, Ocean.xyz, Poolin, BTC.com, Binance Pool): light `#2f6f9c`, `#9a6412`, `#7d4e8f`, `#3a7a5a`, `#a24f2e`, `#5563a8`, `#6b6e1f`, `#10787a`, `#9f495c`, `#673b1e`, `#205564`, `#967f0e`; dark `#6cb0dc`, `#d9a24c`, `#c193d6`, `#74bb94`, `#e0906d`, `#97a3e6`, `#acb165`, `#63bcbd`, `#e38a9a`, `#ad7859`, `#5290a3`, `#e2ca6a`. Muted, in hues around the wheel, each at least 3.9:1 on its panel (the least, the mustard of Binance Pool on white); the closest pairs differ by 0.054 to 0.07 in OKLab, as the blue and indigo of the first six always did, and the pools that rank together most often (the first six and Luxor) are the farthest apart. Neighbours in the bar have a seam of the panel between them.

### Network

`<html data-network="mainnet|signet|testnet4|testnet5|regtest">` sets `--color-network`.

| Token | Light | Dark |
|---|---|---|
| `--network-mainnet` | `#161b1e` | `#e6eaed` |
| `--network-signet` | `#0b7285` | `#4fc3d9` |
| `--network-testnet4` | `#8a5a00` | `#f0b43c` |
| `--network-testnet5` | `#4f6d10` | `#a8d05a` |
| `--network-regtest` | `#56616a` | `#9aa4ab` |

Mainnet shows its name in the network switch and nothing else. Test networks add three signals: a slim band above the header, tinted with the network colour and underlined in it, whose words carry the warning ("Signet is a test network. Coins here have no value.") after a short hatched mark; the logo's crab and settled layers in the network colour; and the network switch outlined in the network colour. The page title is prefixed with the network name. Signet is teal so it never reads as a fee: the fee ramp ends in violet. Testnet 5 is moss green, a yellow-green well apart from testnet4's amber and signet's teal, and kept off violet for the same reason.

## Type

**Two voices.** Prose, labels and headings are set in the reader's own system interface font (`system-ui`: San Francisco, Segoe UI, Roboto, Cantarell and so on), at normal weight, with weight kept for the one value that matters in each group. Hashes, addresses and numeric table columns are set in **Recursive Mono** ([Recursive](https://github.com/arrowtype/recursive), SIL Open Font License 1.1, license in `design/fonts/OFL.txt`), its Linear monospace cut. The system font costs no download, is plain where Recursive's proportional cut had character, and is what each reader's eye is used to; the monospace keeps hashes and columns of figures aligned digit for digit.

- **One file, 24 KB:** `design/fonts/recursive.woff2`, Recursive instanced at `MONO` 1, `CASL` 0, `slnt` 0, `CRSV` 0, with `wght` 400–700 left variable. The character set is Basic Latin plus the punctuation we use (–, —, …, ≈, ≥, ×, arrows, ₿, superscript digits and minus, thin and narrow no-break spaces). Recursive has no narrow no-break space of its own, so the build adds one, 0.15 em wide at every weight.
- **Digit groups look the same everywhere.** Each engine draws the narrow no-break space (U+202F) of whatever font it falls back to, and WebKit's is too thin to see (`1 293` read as `1293`). So the sans stack begins with a second `@font-face`, "Recursive Gap", that is the same file limited to `unicode-range: U+202F`: the system font sets every letter and digit, and Chromium and WebKit take the gap between digit groups from our file (0.15 em). Firefox takes a space from the font of the characters around it, so in prose it draws the system font's own narrow space: 0.10 em in a Mac's, 0.20 em in DejaVu Sans, Linux's usual default. Both are visible and narrower than a word space; there is no way in CSS to make Firefox take ours. In the monospace every engine draws ours. `shell.e2e.ts` measures the site's grouping in both stacks in every engine, with the font and without it.
- The page waits for both faces before its first render (`index.tsx`). If the font fails, or arrives after the first second, it takes both out of the stacks for that load, so text is laid out once: system monospace for data, the system font's narrow space between digit groups. A system monospace's narrow space can be a whole cell (DejaVu Sans Mono's is): wider, but figures still line up and read grouped.
- **The layout holds in every system's font, up to DejaVu Sans's width.** The prose font is the reader's, so the design is checked in more than a Mac's: Linux's DejaVu Sans is about 10% wider than San Francisco on the site's own strings (its bold 18%), Noto Sans 3%, while Roboto, Cantarell and Arial are as narrow or narrower. Nothing is sized to one font: a row of figures gives each column at least its figure's width (`minmax(min-content, 1fr)`), and goes to fewer per row where they do not fit; a figure never wraps inside itself or away from its unit, while words, labels and table headers wrap; a fact that must stay on one line and cannot (an exact amount in a phone's flow card) reads in magnitude, its exact form in the title. `fonts.e2e.ts` checks every page type in a stand-in for DejaVu Sans ([`FRONTEND.md`](FRONTEND.md#other-systems-fonts)).
- **Turn on monospace** with the class `mono`, or `font-family: var(--font-mono)`. Use it for hashes, txids, addresses, scripts and numeric table columns (the table does this itself), and for the number in a transaction's status step, so the ring holds the same glyph, centred, on every system. Figures elsewhere stay in the sans with tabular digits (`num`).
- Rebuild the subset from the upstream release (`Recursive_VF_1.085.ttf` in `ArrowType-Recursive-1.085.zip`) with fontTools 4.68 and `brotli`, from `design/fonts/`:

```sh
fonttools varLib.instancer Recursive_VF_1.085.ttf CASL=0 slnt=0 CRSV=0 MONO=1 wght=400:700 -o rec.ttf
python3 add-nnbsp.py rec.ttf
pyftsubset rec.ttf --flavor=woff2 --output-file=recursive.woff2 \
  --unicodes="U+0020-007E,U+00A0,U+00B0,U+00B2,U+00B3,U+00B7,U+00B9,U+00D7,U+2009,U+2013,U+2014,U+2018,U+2019,U+201C,U+201D,U+2026,U+2070,U+2074-2079,U+207B,U+2190-2193,U+2197,U+2212,U+2248,U+2264,U+2265,U+202F,U+20BF" \
  --layout-features='kern,tnum,zero,case'
```

### Scale

A restrained scale on a 16 px base: headings are only a little larger than the text, so the figures, not the titles, are what the eye finds.

| Token | Size | Use |
|---|---|---|
| `--text-xs` | 12 | Tile footers, axis ticks, keys |
| `--text-sm` | 14 | Labels, tables, captions, controls |
| `--text-md` | 16 | Body |
| `--text-lg` | 18 | Section headings, tile heights, summary values, wordmark |
| `--text-xl` | 22 | Key stats, the fee answers |
| `--text-2xl` | 28 | Reserved |
| `--text-3xl` | 24–30, fluid | Page titles |

Weights: `--weight-regular` 400 for text, `--weight-medium` 500 for labels that lead a group, `--weight-bold` 600 for headings and the value that matters. Nothing heavier. Line heights: `--leading-tight` 1.2 for headings and figures, `--leading-snug` 1.35, `--leading-body` 1.5. Page titles use `--tracking-tight`.

### Numbers

| Kind | Treatment | Example |
|---|---|---|
| Any figure | `font-variant-numeric: tabular-nums slashed-zero` (class `num`) | |
| Grouping | Narrow no-break space (U+202F) every three digits, so numbers never wrap | `975 411`, `3 341 tx` |
| BTC, exact | Eight decimals where accounting needs them (a transaction, an address, a block's fees). Trailing zeros in the muted colour at the same weight, so the number reads as one. Hover shows sats | `0.03500000`, with `00000` dimmed |
| BTC, summary | Magnitude first (`formatBtcShort`, `Amount short`): whole bitcoins from 1 000, two decimals from 1, three significant digits below. The exact amount and sats in the title. An address's balance, received and sent are summaries too: each figure is a button whose title is the exact amount, and a tap or key opens it with a copy button that copies it to the satoshi. Every exact amount on the site (these, and a channel's msat terms) opens the same way: in a pop-up over the page, above its figure (below it where the room above is under the sticky header) and wholly on screen whatever column it opens from, moving nothing; one at a time, closed by Escape, a scroll, or a tap elsewhere, which only closes it, as with the network menu (a tap on another amount opens that one at once). A channel's msat terms copy as plain digits, their unit named in the button's label | `2 793 BTC`, `3.15 BTC`, `0.0225 BTC` |
| sats | Grouped integer | `167 sats` |
| Fee rate | Two decimals under 10, one under 100, none above. A recommendation is rounded up at the same precision (`formatFeeRateUp`), never shown with more | `0.80 sat/vB` |
| Size | One quantity, one unit family, everywhere: serialized size in B, kB, MB; virtual size in vB, kvB, MvB; weight in WU, kWU, MWU. The base unit under 10 000, then k or M (powers of 1 000) with two decimals (`formatSize`). A block's **size** is its serialized size; its virtual size is always written in vB units or labelled "virtual". The same block reads the same string on every page | `209 vB`, `1.69 MB`, `998.52 kvB`, `3.99 MWU` |
| Units | Muted, after a space. In tables the unit moves into the column header ("Value, BTC") and cells hold bare numbers, except sizes, which keep their unit in the cell because one column spans B to MB. A unit hidden from sight is still in the text for screen readers | |
| Approximate | `~` for projected values, `≈` for derived counts | `~0.64 sat/vB`, `≈ 15 blocks` |
| Very small or large | A power of ten with three significant digits, where writing the figure out would not fit a phone (`formatPowerOfTen`): below 0.001, or past the last prefix. Regtest's difficulty is the one seen in practice | `4.66 × 10⁻¹⁰` |

### Spent state

An output is **Spent** (or **Being spent**, while the spending transaction is unconfirmed), **Unspent**, or **Unspendable**. Unspendable is for outputs that can never be spent, which the node reports as not spent: an `OP_RETURN` output, a locking script over the 10,000-byte limit, and the genesis block's coinbase, which was never added to the set of spendable coins. Never call those Unspent, and never call the genesis coinbase Spendable; the inspector gives the reason.

### Hashes and copy

- **In lists:** first eight and last eight characters with a middle ellipsis (`a3f9c2e1…7b0d44e9`), in the monospace cut. The full value is in the `title` and in the copy button.
- **As a page subject** (block hash, txid, address): the full value in groups of eight at one contrast, wrapping cleanly at any width. A copy button sits at the end.
- **Addresses** in the flow diagram: whole, wrapping, where the cards have room; seven and five characters on a phone.
- **A short form never loses its end.** Where even `a3f9c2e1…7b0d44e9` or `mwLW3XD…UAuat` is wider than its room (a 320 px phone, a wide font), its head gives way, down to two characters and its "…" (`mwLW3…UAuat`); the tail stays whole.
- **Copy button:** a 28 px drawn button in a 44 px target that takes only its room, kept clear of the link beside it. It copies plain text a program can read: a hash, address or key exactly as on the wire, an amount as digits and a point with no grouping and no unit, its unit named in the button's label ("Copy the exact balance, in BTC"). "Copied" rises above the button, never over the value it copied, inside any scrolling table so nothing clips it (below it in an exact amount's pop-up that opened below its figure). On press it turns positive, pops once, and the word "Copied" shows, at a readable size, while its label reads "Copied" for screen readers, for 1.4 s, only when the value was copied. When the browser copied nothing, its icon turns to a cross in the negative color, "Not copied" shows above it and "Could not copy" is announced, for 3 s.

### Time

Relative time ("13 min ago", "1 day 23 h ago", "9 days ago": days lead from a day on) in lists, with the absolute UTC time in the `title`. Detail pages show absolute UTC first (`11 Nov 2026, 20:41:07 UTC`, the form chart read-outs use, there to the minute) and relative time below. Under 10 seconds is "just now". Block tiles drop "ago" to fit ("13 min").

## Space, shape and layout

- **Space** on a 4 px grid: `--space-1` 4, `--space-2` 8, `--space-3` 12, `--space-4` 16, `--space-5` 24, `--space-6` 32, `--space-7` 48, `--space-8` 64.
- **Page:** max width `--page-max` (85rem), side gutter `--gutter` (16 px on phones, up to 40 px).
- **Radius follows hierarchy:** `--radius-s` 2 px for map rectangles and swatches, `--radius-m` 6 px for controls, tiles and wells, `--radius-l` 10 px for panels, `--radius-pill` for chips. Do not use one radius for everything.
- **Sections are panels.** A `section` whose first child is a `SectionHeader` is a panel: `--color-surface`, a 1 px `--color-line` border, `--radius-l`, `--panel-pad` inside (`global.css`). A panel inside a panel is a group, not another card. Things that are not sections but read as one group take the class `panel` (the block's facts, its map). Headings sit at the top of the panel with no rule under them.
- **Shadow:** `--shadow-panel`, a hairline in light and none in dark, under panels; `--shadow-pop` on floating things.
- **Touch:** every control a thumb uses has a target of at least `--touch` (44 px) each way that no neighbour's covers. Small drawn buttons (copy, expand, theme) keep their size and get the target from an invisible margin on touch screens; so do links and figures in a line of text (`.tap` round a control, `.tap-line` on a line that cuts itself with an ellipsis, in `global.css`), so the target grows and the look does not. Two exceptions, both meant: a link inside a sentence, which the words around it place; and a phone's flow card, three short lines with a control on each, whose address and spending links are also in the inspector its details button opens: they keep their line's height, so no target in the card reaches over another. `targets.e2e.ts` holds the rule on every page type.
- **Tiles:** `--tile-w` 8.25rem, `--tile-h` 9.5rem, `--tile-gap` 0.75rem. Phones override them on the strip element.
- **Breakpoints:** 65em (single column, the header's two rows) and 40em (phone): 1040 and 640 px at the default text size. They are in `em`, so a reader's larger text size moves the layout to the narrower form, as zoom does; below 18.75em (300 px, reached only by zoom or a large text size) the last two-column groups stack.

## Motion

| Token | Value | Use |
|---|---|---|
| `--dur-instant` | 90 ms | Press, toggle |
| `--dur-quick` | 160 ms | Hover, focus, tooltip |
| `--dur-base` | 260 ms | Open, expand, swap |
| `--dur-slow` | 520 ms | Tiles shifting, bars resizing, pins sliding |
| `--dur-block` | 900 ms | The new-block sequence, end to end |
| `--dur-fade` | 140 ms | Opacity fades that remain under reduced motion |
| `--stagger` | 45 ms | Delay between items in a sequence |
| `--ease-out` | `cubic-bezier(0.2, 0.7, 0.1, 1)` | Things arriving or moving into place |
| `--ease-in-out` | `cubic-bezier(0.65, 0, 0.35, 1)` | Things travelling from one place to another |
| `--ease-settle` | `cubic-bezier(0.3, 1.45, 0.6, 1)` | Things that land: a small overshoot |

Rules:

1. **Move with `transform`, fade with `opacity`.** Never animate width, height, top or left. Bars that change size are positioned with `translateX` and sized with `scaleX` (see the difficulty bar and the tile gauge).
2. **Read durations from the tokens** in JavaScript too (`getComputedStyle(...).getPropertyValue("--dur-slow")`), so reduced motion applies everywhere. The build's minifier rewrites them in seconds (`520ms` becomes `.52s`), so read both units (`toMs` in `pages/home/motion.ts`).
3. **Leaders move first.** When a row of things shifts, stagger from the one at the front of the movement so nothing overlaps.
4. **One moment per event.** A new block is one sequence. Live rows get a background flash, not a slide.
5. **Reduced motion:** all durations except `--dur-fade` become 0. Nothing translates or scales. Content still updates, and short opacity fades remain. Ambient loops (the live dot) are opacity only.

### CSS or WebGL

| Scene | Drawn with | Why |
|---|---|---|
| Block strip (the tiles in view and six beyond each edge, however far it is scrolled: 24 mined tiles at 1,440 px, 17 on a phone, and 4 projected) | DOM, CSS and the Web Animations API | Few elements; text must be selectable and accessible |
| Fee answers, waiting by fee rate, flow diagram, timeline | DOM and SVG | Few elements |
| Hover, focus, press, tooltips, row flash | CSS transitions | |
| A block's packed transaction grid (thousands of squares) | WebGL2 instanced quads | Too many elements for the DOM |
| The projected-block mempool view and squares moving from mempool into a block | WebGL2 | Thousands of moving squares |

The prototype draws the grid with canvas 2D as a stand-in. The real app uses WebGL ([`ARCHITECTURE.md`](ARCHITECTURE.md)).

### The new-block sequence

When a block is found, in 900 ms:

1. The "now" line flashes in the accent (opacity).
2. The next projected tile crosses the line on a shallow arc (lift 14 px, scale 1.05 at the midpoint), lands in the first mined slot with a short squash (`--ease-settle`), and changes from dashed to solid. Its border shows the accent until the sequence ends.
3. Mined tiles shift right by one slot, the farthest first; the ones past the view move on into the past. Scrolled into the past, with the "now" line out of view, nothing moves: the tiles in view stay where they are.
4. Projected tiles shift toward the line, the nearest first, and relabel ("Next block", "In ~20 min").
5. A new projected tile fades in at the far end and its gauge settles in, like sediment.
6. Mempool figures and the fee answers update where they stand.
7. A polite live region announces "Block 975 412 mined by …: 3 341 transactions, median fee 0.64 sat/vB."

The sequence uses FLIP: measure every tile, change the DOM, then animate each tile from its old place to its new one with `transform`.

### The projected side

Decided while building it, where the rest of this document left it open:

- **Four tiles:** the next three blocks and one for everything after them, which names how many blocks' worth it holds ("+14 blocks"). They read "Next block", "In ~20 min", "In ~30 min"; regtest has no block interval, so there they read "Second block" and "Third block". The next block's foot says "~10 min". Each shows `~` before its median, its range and its transaction count.
- **Each projected tile opens its projected block's page;** the last tile opens the first block it holds. Its link carries the tile's meaning for a screen reader ("Next block, projected: 3 214 transactions, median fee about 1.50 sat/vB, …").
- **Ordinary updates do not move.** The mempool changes every two seconds; a tile's figures and layers change where they stand, with no transition, so the strip is simply different the next time you look. Motion is kept for tiles changing places: a block mined, a projection catching up after a burst or a reorg, a tile forming or leaving. A tile that appears outside a crossing (the first state, a mempool growing into a second block) fades in and settles its layers; one that leaves fades where it stood.
- **The crossing shows the projection becoming the block.** The tile that crosses is the one that projected that height, and it carries the projected figures (with `~`) and layers until it lands, however soon the block's own facts arrive. Then each real layer grows out of the same band's projected layer while the projected ones fade: a block close to its projection barely moves, a different one visibly re-forms, and an empty block drains to its coinbase. In a burst each block leaves from the tile that projected it.
- **A small mempool is information.** One short tile is the whole mempool, and the space beside it says "Everything waiting fits in the next block." An empty next block says "Nothing waiting" over a dashed floor, and the space beside it "Nothing is waiting. The next block would hold only its coinbase." (Phones hide that sentence; the tile still says it.)
- **Not live, honestly.** When the server has lost its node, the last projection stays, the space beside it says it is the last one before the server lost touch, and the live indicator says "Node not answering". When the server does not track the mempool, the strip keeps the single "Next block" tile with the time since the last block.
- **New transactions come in at a readable pace,** one row at a time, at most one every 0.7 s, newest on top with the row flash; on a busy day the rows that could not be shown in time are skipped rather than queued.

### The transaction grid

Decided while building it, and redrawn by the design council's first round:

- **A block reads as a block.** The transactions make one clean rectangle on the floor of the frame, as high as the block is full: an ordered squarified treemap, with no ragged edge and no holes, so empty space can only mean one thing. The band above the rectangle is the capacity the block left unused; a full block leaves a hairline. The frame is the weight limit, so a full block fills it and an old block of 20 kvB is a thin layer on the floor.
- **Order.** The coinbase first at the top left, then fee band by fee band, dearest first. Within a band, whose rectangles share a colour, the largest first: that keeps the rectangles close to square (half are within 5% of square on a full mainnet block). Each run of rectangles is laid along the shorter side of the space still free, a column down its left or a row along its top.
- **Honest scale.** A rectangle's area is its virtual size, exactly, except that none is drawn smaller than `MIN_AREA` (4 cells, about 25 vB at a block's scale, smaller than any mainnet transaction) so it can be seen and pointed at. A nearly empty block is a small rectangle at the left of the floor, as wide as tall, at least `MIN_ROWS` (10 cells) high, rather than a sliver too thin to see; the caption and the facts give its true fullness.
- **The coinbase** is drawn in `--color-text-muted`: it pays no fee rate, and fee colour is for fees.
- **Pour in, cheapest first.** On load the rectangles drop into place from a little above, the cheapest first and the dearest last, each with `--ease-settle` over `--dur-slow`, the whole pour lasting `--dur-block`. Under reduced motion they fade in where they lie over `--dur-fade`. Live changes: a rectangle that moves travels with `--ease-in-out`, leaders first; a new one drops in; a gone one shrinks and fades where it stood.
- **Hover** rings the rectangle in `--color-text` and opens a tooltip above it (below when there is no room), inside the frame: fee rate with its swatch (the one place a swatch sits beside a rate: it is the key to the drawing), txid, fee, size and value; the coinbase says "Coinbase" and what it pays. Click opens the transaction. On touch the first tap shows the tooltip ("Tap again to open"), the second opens it.
- **No keyboard stops in the grid.** A packing has no order an arrow key could follow, and a screen reader cannot see it. The list of transactions below is the keyboard and screen-reader path to the same facts and links; focusing or hovering a row rings its rectangle, and the caption links to the list.
- **Captions.** One line: how full the block is, what a rectangle means, and that the space above is unused. The fee-layer caption shown before the map draws sits in the same cell, so swapping one for the other moves nothing.
- **Fallbacks.** The fee layers stay in the frame until the map has drawn, and come back if the WebGL context is lost, until it is restored. A browser without WebGL2 keeps the layers and the caption says the map needs WebGL2. If the data fails, the caption offers "Try again".

### The projected-block page

Decided while building it (`/block/next`, `/block/next/:n`), where the rest of this document left it open:

- **The address is a place in the queue,** not a height. `/block/next` is whatever block comes next, so the link keeps meaning "the next block" after one is mined, and the block that was mined gets its own `/block/:hash`. Positions run from 1 (the next block) to 8 (the rest of the mempool), as the projected tiles do.
- **Provisional, in the same frame.** The map sits in the box a mined block's map gets, with the same scale (the frame is the weight limit), but the frame is dashed and open, the level line is dashed, and the title carries a dashed "Projected" badge. Figures that are estimates carry `~` (median rate, range, fullness); counts and fees of the projection itself are exact.
- **Motion for live changes is the grid's own** and nothing more: a square that moves travels with `--ease-in-out` over `--dur-slow`, leaders first; a newcomer drops in with `--ease-settle`; one that is outbid, replaced or mined shrinks and fades where it stood over `--dur-base`. An update's motion is over in about 0.7 s of each 2 s interval, so the picture is still more than half the time and a change reads as one event. Squares whose place did not change do not move. Nothing else on the page animates per update: rows that came in get the row flash once, the "last change" line says how many came in and left, and no live region reads updates out.
- **A block found is the one orchestrated moment.** The dashed frame sets solid in the accent for `--dur-block` while the mined squares fade and what is left moves up; a notice in the accent says which block was found, when, and links to it, and a polite live region says it once. On a page with a map the moment waits for the block's new picture: on mainnet the projection can sit on the new tip one update before the mined transactions leave it, so telling it at the tip alone would show the mined block under a notice that says it has moved on (seen live at block 975 529). It waits at most 8 s. The next block's page then carries on with the new next block. A later block's page stays at its place in the queue, since its address names the place, and the notice says that every projected block moved up, linking to where what it showed went (or saying it was the guess at one of the blocks found, in a burst deeper than it). Blocks found in a burst are one notice ("Blocks 101 to 103 were found"); a shorter or equal chain with a new tip is a reorg and says so. The notice stays until dismissed.
- **Empty is a state, not a failure.** On test networks the next block is often empty: the frame stays, and its open middle says "Nothing waiting here" and what that means, fading in after the last squares have gone.
- **The rest of the mempool has no map.** It has no size bound, so it gets its strata (squeezed into one frame when it holds more than a block, and labelled so) and a sentence on why there is no map.
- **Not live, not current, not on.** The connection state sits beside the badge as an icon and a word. While the server has lost its node the page keeps its last picture with a caution notice saying since when. With the mempool switched off on a network, the page says so and points to the mined blocks.

### The transaction page, live

Decided while building it, where the rest of this document left it open. The page is where people land from a wallet, often worried, so it says exactly what the server knows and no more.

- **Five words for where it is.** Unconfirmed (in the mempool), Confirmed, Replaced (another transaction spending the same coins took its place), Dropped (it left without being mined, for a reason the node does not report) and Removed (the node no longer has it and nothing says why). The timeline's middle step carries the same word with its detail; a replaced version's last step is "Will not confirm", struck through.
- **Where it waits** sits above the fee, under the flow and beside the details. The projected blocks are a row of dashed slots running to a dashed "now" line, the next block nearest it, the last one "8+". The transaction is one square in the fee colour of the group it will be mined with. Under it, in words: "In the next block" (linked to that block's page), "In about 3 blocks", or "In more than 7 blocks"; how much would be mined before it; and what that means in time. A block is on average ten minutes away whenever one looks, and about one in seven takes more than twenty (an exponential wait), so the next block is said that way; later blocks get a rough figure ("~30 min") at the usual pace, with the condition that nothing paying more arrives; regtest says it has no schedule. A last, muted line says this is a projection, not a promise.
- **Alive without twitching.** The square travels only when its block changes (`--dur-slow`, `--ease-in-out`); what is ahead of it changes in place. Nothing is announced for a position that only moves: only entering or leaving the next block, and every change of state, once, in a polite live region.
- **The position bar of the prototype is not used.** The projection says which block a transaction is in, not a percentile of one, and the lane says that directly.
- **Mined with.** When the rate it will be mined at prints differently from its own, an "Effective fee rate" fact joins the fee list, and under it the group: its members in mining order (this transaction, its child, its parent), each with its own rate and a link, eight at a time with a "Show all" button (this transaction always among them), one sentence saying who lifts whom ("On its own it pays 1.00 sat/vB, but its child pays enough to lift the group to 12.5 sat/vB as a whole") and one explaining why miners take such a group whole, naming child pays for parent last.
- **Replaced** is a notice above the timeline, in the negative colour: what took its place, linked, with both rates and both fees, and that this version can no longer confirm. A longer chain is listed oldest first, and the newest version's own state ("It waits in the mempool: in the next block", "It confirmed in block 975 530") is followed live. Opened later, when the node says not found, the same notice comes from the server's record of replacements; when the record has nothing, the not-found state says the record is recent and holds nothing for it, and that the page will show the transaction if it is broadcast while open.
- **Dropped** is a notice that lists what it may have been (pushed out by fees, expired, made invalid by a reorganisation, or replaced by a transaction the server did not see) and that it will not confirm unless broadcast again. It never says "replaced".
- **The happy moment** is the existing one: the "Confirmed" step's marker lands with `--ease-settle` over `--dur-slow`, once, and the live region says "Confirmed in block N." Reduced motion keeps only the change.
- **Back from a reorganisation** is a caution notice ("Back in the mempool") naming the block that held it, saying it waits to be mined again and can be replaced meanwhile, until it confirms again.
- **Not live, quietly.** Beside the badge, an icon and a word: "Live" (a breathing dot), "Connecting", or "Not live" / "Node not answering" with what the page does instead ("Checking every 10 s instead."). Without the live channel there is no position to vouch for, so the panel says the place in the queue shows while the page is live; with the mempool engine off on the network the panel is left out. A settled transaction shows no indicator: nothing on it can change.
- **The address page** shows "Live" under its header while the node watches the address, and otherwise says plainly that the page does not update by itself and why (too much history to watch, the node watching as many addresses as it can, the node out of reach), never as an error.

## Components

| Component | What it is |
|---|---|
| Header | Logo and wordmark, network switch, search, navigation (Blocks, Mempool, Mining, Lightning), theme toggle. Sticky, except on a screen under 30em tall (a phone on its side, a page zoomed in or set in a large text size), where it scrolls away with the page. Focus and in-page links stop clear of it. One row on wide screens. Between 640 and 1040 px (tablets, a desktop at 200% zoom) two rows: the brand, the search and the theme toggle, then the network switch and the sections. On a phone two rows of about 100 px in all: the mark, the network, the search (its hint one word, "Search") and the theme, then the four sections sharing the row evenly, every one in sight at 320 px. A focused search takes the whole first row, the mark, network and theme stepping aside, so it and its answer are the phone's width. The network and theme are 44 px targets around a smaller drawn pill and square |
| Network band | A slim band tinted with the network colour, a short hatched mark and the warning in words. Test networks only |
| Logo | `design/logo.svg`, also the favicon: a crab, a nod to Rust and to rbitcoin's own crab, lifting a block of three strata, the top layer shorter, offset and in the accent, still settling. In the header it is inline SVG, 32 px: the crab and the two settled layers in `--color-network`, the top layer in `--color-accent` on every network. The wordmark is live text, so a new name is one string |
| Block tile | Projected (dashed) or mined (solid). Height or label, median fee, fee range, total fees (in magnitude), its fee layers, transaction count and age. Mined tiles link to the block and show the pool below |
| Tile layers | The block's capacity as a box, its fee bands settled from the floor, cheapest at the bottom, each as thick as the virtual size paying it (`strataLayers`); the room above is room the block left. Until the block's facts arrive, a neutral gauge of the same height stands in |
| Block strip | Projected lane, "now" line, mined lane. Scrolls sideways inside itself and starts centred on the line; the mined lane goes on into the past down to block 0, and "← Now" in its head brings the line back ([`FRONTEND.md`](FRONTEND.md#the-block-strips-past)) |
| Fee answers | "Fee to pay now": up to four plainly labelled rates, slowest first (No rush, Low, Medium, High), each with its unit and what it promises (within a day, within an hour, within 30 min, next block), rounded up. Levels next to each other that print the same rate are one answer ("No rush or low"), never stacked labels, laid out in the same two rows of two whatever merges: Low and Medium alone are never merged, a lone answer beside three takes its row, and one answer for every wait ("Any wait") is one tile across the row, the panel no taller than it, its line of text saying the next block has room at that rate. In sunken wells |
| Waiting by fee rate | The home page's mempool: one line saying the fee rate the next block's worth reaches down to, then, behind "By fee rate" (open on wide screens, closed on a phone), a row per band, dearest first: its range, a bar on a log scale from 100 vB to one block's worth (a band past a block fills its bar, the end cut), its size, and how many blocks deep the queue is by the end of that band |
| Fee key | Twelve swatches with lower bounds, in one row where their labels fit and two rows of six where they do not (the test is in the labels' own font). Beside a drawing that needs one (the block map, a projected block), never repeated where the figures already name the bands |
| Fee chip | A number and its unit, with a swatch only where it is the key to a drawing (`FeeRate swatch`) |
| Amount | BTC with dimmed trailing zeros, sats on hover; `short` for a summary's magnitude |
| Hash | Truncated or grouped, monospace, with copy; `whole` wraps the full value |
| Stat | Label above a figure, optional muted sub-line |
| Fact list | `dl` of label and value pairs, two columns or one |
| Summary | The transaction page's answer: Status, Fee, Amount and Block (or First seen), four label-value pairs in a panel. On a phone, status and fee share a row and the amount has one of its own, so thousands of bitcoin in eight decimals fit 320 px in any face |
| Table | Units in headers, bare numbers in cells, numeric columns right-aligned in the monospace, a gutter on both sides of every column, row rules. Phones drop the least important columns and may show a shorter header (`short`). A list's row is one target: a tap anywhere on it opens its item, the cells' own links and buttons staying on top and the row link hidden from the keyboard and screen readers. Identifiers in a list take as much of their column as it allows, cut in the middle only when they must |
| More | The second reading layer: a disclosure ("How these figures are made", "How this changes", "Why") holding methodology and longer notes, under the one sentence that stays visible |
| Lightning nav | Lightning's own way around: Overview, Rankings and History (the overview's chart, by an anchor) in one short row above the title, and on a node or channel a "←" link back to the list the reader came from, a search's results included |
| Packed map | Rectangles sized by vsize and coloured by fee band, the dearest at top left, one clean block on the floor of the frame ([The transaction grid](#the-transaction-grid)). Tooltip on hover, click opens the transaction, rows in the table below ring their rectangle. Comes with a caption and the fee key; the table is its text alternative |
| Flow diagram | Inputs on the left, outputs on the right, ribbons as thick as the value they carry, meeting at a bar that is the transaction. The fee leaves as its own ribbon in its fee colour. A card shows its exact amount; where that is wider than the card (a phone, a wide font, a thousand bitcoin and more) it reads in magnitude, the exact amount in its title and the inspector |
| Status badge | Pill with icon and word: Confirmed (check), Unconfirmed (dashed circle), Replaced, Dropped and Removed (cross) |
| Timeline | Numbered steps: first seen, replaced or replacing, waiting or confirmed. While waiting and once confirmed it is one line of words, the summary and "Where it waits" holding the rest; after a replacement, a drop or a reorganisation it is the full sequence, horizontal on wide screens and vertical on phones. A version that can no longer confirm is struck through with a dashed marker |
| Notice | Bordered strip for important state, such as "This version was replaced" with a link to the replacement |
| Tooltip | Raised surface, title line and muted detail lines. Opens on hover and keyboard focus |
| Buttons | Default (outlined) and accent (filled). Toggles use `aria-pressed` and show a dot when on. 44 px tall on touch screens |

## Page layouts

### Home

```text
┌ header ─────────────────────────────────────────────────────────────┐
├ strip band (sunken, full width) ────────────────────────────────────┤
│ Blocks   ┆ projected ▭ mined ■                                 Live │
│ [+11][~30m][~20m][Next] ┆now┆ [975411][975410][975409][975408] …   │
├─────────────────────────────────────────────────────────────────────┤
│ ┌ Fee to pay now ──────────┐  ┌ Mempool ─────────────────────────┐ │
│ │ No rush       Low        │  │ Transactions  Size  Fees  Lowest │ │
│ │ 0.14 sat/vB   0.22 sat/vB│  │ Waiting, by fee rate             │ │
│ │ Medium        High       │  │ 10+      ▏           16.59 kvB   │ │
│ │ 0.27 sat/vB   3.29 sat/vB│  │ …                                │ │
│ └──────────────────────────┘  │ < 0.2    ██████████  28.72 MvB   │ │
│ ┌ Difficulty adjustment ───┐  └──────────────────────────────────┘ │
│ │ [██████████████░░┃░░]    │  ┌ Latest transactions ─────────────┐ │
│ └──────────────────────────┘  └──────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

The fee to pay is the first panel after the blocks, so a phone shows it on its first screen. The difficulty bar is neutral (never a fee colour); its mark is where the period would be at one block every ten minutes. Changes read as an arrow and a word ("Down 7.05%"). On a network that never retargets (regtest) the section says so instead.

Wide screens: the fee answer and the difficulty stacked beside the mempool, about its height, and the latest transactions across the width below. Phones: one column, in the order fees, mempool, latest transactions, difficulty; the strip scrolls sideways; stats in two columns.

### Block

```text
← Previous: 975 410                                   Next: 975 412 →
Block 975 411
00000000 00000000 0004f2c1 …  [copy]
┌ facts ──────────────────────┐  ┌ map ───────────────────────────┐
│ Mined          Miner        │  │ ▇▇▆▆▅▅▄▄▄▃▃▃▂▂▂▁▁▁             │
│ Transactions   Fullness     │  │ one clean rectangle, as high   │
│ Median fee     Fee range    │  │ as the block is full           │
│ Total fees     Reward       │  └────────────────────────────────┘
└─────────────────────────────┘  caption, fee key
┌ details ────────────────────┐
│ Size, confirmations, tag,   │
│ header fields               │
└─────────────────────────────┘
Audit, then Transactions (in block order, the coinbase first)
```

The facts come first in reading order; on a phone the map follows them, then the details.

### Transaction

```text
Transaction  (✓ Confirmed)
65428488 a6202f1d 681d053b …  [copy]
┌ summary: Status · Fee · Amount · Block ──────────────────────────┐
└──────────────────────────────────────────────────────────────────┘
[notice: this version was replaced → replacement txid]   (replaced only)
① Broadcast  ② Confirmed  ③ Six confirmations 3 of 6     (one line once confirmed)
┌ Inputs and outputs ──────────────────────────────────────────────┐
│ [input]  ═══╗                    ╔═══ [output]                   │
│ [input]  ═══╣      ┃trunk┃       ╠═══ [output]                   │
│             ╚════════════════════╚~~~ [fee]                      │
└──────────────────────────────────────────────────────────────────┘
┌ Where it waits (unconfirmed) ┐ ┌ Details ──────────────────────────┐
│ Fee: rate, effective rate,   │ │ Version, witness, lock time,      │
│ fee, vsize, weight, size     │ │ raw transaction                   │
└──────────────────────────────┘ └───────────────────────────────────┘
```

The flow takes the page's width, so an address fits its box on one line; the fee and the details share the row under it. While unconfirmed, the full timeline stays, with where it waits above the fee. Long input or output lists collapse after ten; each "Show more" adds a hundred, and the hidden rest travels as one ribbon, so a transaction with thousands of outputs never renders them all at once.

### Address (not in the prototype)

```text
Address  (P2WPKH)
bc1qxy2k gdygjrsq tzq2n0yr f2493p83 kkfjhx0w lh   [copy]
● Live
┌ Balance (big), Confirmed ──────────────────────────────────────┐
│ Received     Sent     Transactions     Unconfirmed             │
└────────────────────────────────────────────────────────────────┘
┌ Balance over time ─────────────────────── n confirmed transactions ┐
│ [line chart]                                     Show the figures │
└───────────────────────────────────────────────────────────────────┘
[Transactions] [Unspent outputs] ══════════════════════════ 4 of 4
time (or Unconfirmed)   txid   this address +/-   fee rate
```

Incoming amounts are `+`, outgoing `−`, both in the text colour: the sign carries the direction. The live line sits below the address, never over it.

### Mining (not in the prototype)

```text
Mining                                        [24 h | 1 w | 1 m | 1 y | All]
(network note: signet, testnet4, regtest)
The network now ═══════════════════════════════════════════════════════════
Hashrate   Difficulty        │ Next difficulty adjustment (the home panel's)
Hashrate and difficulty ═══════════════════════════════════════════════════
[area: hashrate; dashed step: difficulty, right axis]
Pools ═════════════════════════════════════════════════ 895 blocks in the last week
rank  pool  share bar  blocks  hashrate  empty │ Share of blocks, week by week
...                                           │ [stacked strata, biggest at the bottom]
Rewards ═══════════════════════════════════════════════════════════════════
Paid to miners   New coins   Fees   Per block
Blocks over time ══════════════════════════════════════════════════════════
[Fees | Rewards | Fee rates | Size]  one chart at a time
Block health ══════════════════════════════════════ 158 audited blocks in the last week
18% audited, from 12 Nov, 11:21 UTC.   [area: match rate per block, 0–100%; gaps]
Difficulty adjustments ═══════════════════════════════════════════ Every 2 016 blocks
Next, expected ↓ Down 8.41% at block 975 744, in 8 h
block  when  ↑ Up 5.54%  difficulty                       [Show all 483 adjustments]
Recent blocks ═════════════════════════════════════════════════ All blocks
the same mined tiles as the strip, in a wrapping grid
```

Decided while building it, where the layout above left it open:

- **The period is in the address** (`/mining?period=1m`), so a view can be linked; a week is the default. "All" joins the design's four periods, for the whole of history. The period is a row of links, the current one raised with an accent underline.
- **Charts are drawn in the series colours, never fee colours:** the main series a solid `--series-1` line over a pale area, a second series a dashed `--series-2` line on its own right-hand scale. The one exception is the fee-rate chart, whose axis carries the fee scale as its key.
- **Pool shares over time are strata.** Each pool is a layer, the biggest at the bottom, in its pool colour with a seam of the panel between them. The six biggest pools have their own layer and colour and the rest are one, "Other pools", in grey. The layer under the pointer turns the accent. Shares over time are weekly, so that chart appears from a month up; for 24 hours and a week the same place shows the period's shares as one bar, in the same shades, each pool named with its share.
- **Summaries in magnitude.** Rewards read `2 793 BTC`, the exact amount in the title; the pool table's estimate of how a pool's hashrate is made sits behind "How these figures are made".
- **Hashrate needs a week.** Each daily point averages the 7 days before it, so the 24-hour view draws the last week and says why.
- **Coverage is drawn, not hidden.** Where the server has not stored the start of the period yet, the chart keeps the whole period's width and hatches the part with no data ("No data stored"), and a note above says "Data from 22 Sep 2026 onward". The same hatch is the note's swatch. A period with nothing stored says so and offers all of history.
- **One readout, no tooltip.** Above each plot a line at a fixed height shows the point under the pointer (the latest otherwise): its time and every figure with its key. It never covers the data, works the same for touch and keys, and never moves the page. On a phone a stacked fee chart reads out its totals only, and the one band under the finger on a line held for it, which says "Tap a layer to name it" until then; every band is in the figures table.
- **The second level is a switch,** not more charts: fees, rewards, fee rates and size share one chart slot under "Blocks over time", so the page stays one screen of figures and one of charts.
- **Block health is what was watched.** Only blocks this server saw arrive have an audit, so the chart counts them in its caption, says what share of the period's blocks they are and since when, hatches the time before the first and breaks wherever a block has none. The area stands on an axis from zero, so a bad block is a notch down from the top and an ordinary period a full band; past 1,000 blocks a point is the lowest of its run, so a bad block is never averaged away. A point opens its block: a click, a second tap, or Enter.
- **Past adjustments are a list, not a period's.** The latest ten, newest first, each opening the block that began its period, with all of them a press away, under the next one's expected change; ups and downs read as an arrow and a word, never a colour. They sit after the block charts, so the page still opens on the network now.
- **Unknown is a pool.** It is ranked like any other, its page exists, and its row says it is the blocks no tag or address on the list names.
- **Test networks say what their figures mean.** Signet's blocks come from a few signers the list does not name; testnet4's minimum-difficulty rule makes its hashrate swing; regtest has no pools, a meaningless hashrate and no retargets; Testnet 5's figures read as mainnet's, so it has no note. A note under the title says so, and figures that mean nothing there say "Not meaningful on regtest".
- **A pool's page** has its name as the title (dataset text), its site as a plain link only when it is `http` or `https`, its blocks and shares, its weekly share and hashrate, and its blocks 25 at a time.
- **Nothing moves as it loads.** Each section holds the height its content will take; the coverage notes on a pool's page sit below its figures.

### Mempool history (not in the prototype)

```text
Mempool history                     [2 h | 24 h | 1 w | … | 4 y | All]
(coverage sentence, with the hatch as its swatch, when minutes are missing)
Waiting, by fee rate ════════════════════════════════ One point a minute
readout: time, total, transactions, lowest accepted, each band
[stacked areas in the fee colors, cheapest at the bottom; total as a line]
fee key
Flow ═══════════════════════════════════════════════════ vB a second
Over the last 24 hours, 2 983 vB/s arrived, blocks took …: it filled by …
[line: arrived; stacked shades: mined, left otherwise]
```

- **The mempool is the core sample laid on its side,** as pool shares are, but its layers are fee bands, so here they take the fee colors: color still carries fee and nothing else. The layer under the pointer turns the accent.
- **Flow is its own chart,** not a second axis on the first: its units are a rate, and the question it answers (filling or draining) is read from where the line sits against the layers. A sentence above gives the period's answer in words.
- **Honest about coverage,** as the mining charts are: a break wherever a step was not sampled (a lone minute is a sliver), and a sentence saying how many of the period's minutes are here and since when.
- **Opens on what is recorded, and says so in its choices.** With no period in the address, a view whose records begin inside it starts where they do, under one line ("Recorded since …"; the Lightning overview says "Everything recorded, since …"), and the period choices gain "Recorded", marked as the current one: a period's name always means its whole width, so choosing "24 h" shows the whole day, the time before the records hatched ("No data stored"). The same holds on the Lightning overview. The fee key is not repeated under the chart: its readout names every band, and on a phone only the bands holding anything at that point.
- **A few missing minutes are bridged.** Up to five missing steps are drawn across rather than as thin stripes that look like faults; a longer pause in recording breaks the line, and the figures table lists only what was stored.
- **A phone's time axis names its ends:** too narrow for ticks a reader can place, a chart labels its first and last moment instead ("9 Nov", "12 Nov"; "12 Nov 11:14", "20:35").
- **The intervals are one row** on a phone, scrolling sideways with their far edge faded and the chosen one in sight, so the chart and its time axis are on the first screen. The coverage is one short line ("49% recorded, from 12 Nov, 11:14 UTC.", the year said only when it is not this one).

### Replacements (not in the prototype)

```text
← Mempool history
Replacements                                              [All | Full RBF only]
25 replacements, the newest 17 s ago; 8 of them mined.
Newest first ════════════════════════════════════════════════════════════ ● Live
What replaced what, oldest first, sat/vB              Rate rose, sat/vB   Status
■ 990f7d1f…3138 4.12 ─6 s→ ■ 30d6fb23…e6ae 4.47 ─3 s→ ◘ 096809c9…1607 4.79   +0.67   ◌ Not mined
Also replaced: 51fb6b4f…a1c2                                                    17 s ago
```

Decided while building it:

- **A row is a story, not a list of ids.** The versions of one replacement, oldest first, on a line: each a mark in its rate's fee colour (the line is a drawing, so the fee ramp belongs there), a short id that opens its page and its rate; between two, how long the first stood. The version that stands has its mark ringed and its id in the text colour; the ones it replaced are muted. Each version is a target of its own: its mark, id and rate, at least 44 px high, reaching halfway across the time it stood on either side, so a near miss opens the version aimed at. A press elsewhere on the row opens the version that stands; inside the story, between versions, it opens nothing. A story longer than four keeps its first and last two and folds the rest behind "N more versions". What else a replacement removed (the children of what it replaced, other conflicts) is one muted line under the story, three named and the rest behind "N more". A version that did not signal says "did not signal" under its rate; a story with one is marked "Full RBF".
- **The answer per row** is at its right end: how much the rate rose (or fell: a replacement can pay more in all over more bytes), and whether the version that stands was mined, as an icon and a word: Mined (positive), Not mined (caution), Unknown (muted, after a reorg took its block away), with how long ago it arrived under it.
- **On a phone** the story runs down the row, each version on its own line and the time it stood between them on a short rule; the rise drops first when the table does not fit.
- **Live without moving the reader.** A new story comes in at the top with the row flash; a reader scrolled into the list keeps the story they read where it was.
- **Where it sits.** The header's Mempool is current on `/rbf`, which has a "← Mempool history" link above its title; the mempool's own pages are two, so they get no row of tabs (on a phone it would push the history chart off the first screen). The recent replacements panel, the newest five, is the home page's last panel, below everything the council placed, and the foot of `/mempool`: the way to `/rbf` from both. On the narrowest phones its row gives way before its status does: the id's header reads "Tx", the id shortens, and the rate it rose to goes under the one it rose from, so "Not mined" is always whole.

### Lightning (not in the prototype)

```text
Lightning              (nodes and channels are found from the header's search)
The network now ═════════════════════════════════════════ As of 12 Nov, 18:30 UTC
Channels  Nodes  Capacity  Median fee rate  Median base fee
(only channels checked against the chain)
Over time ═══════════════════════════════════════════════════ Every ten minutes
[24 h | 1 w | 1 m | 3 m | 1 y | All]   (since when, with the hatch)
[area: channels; dashed line: capacity, right axis]
Newest channels ══════════════════ │ Newest closes ═════════════════════
channel and ends, capacity, block  │ channel, kind and ends, capacity, block
Largest nodes ════════════════════ │ Most connected nodes ══════════════
Node page: name (text, cut), key grouped with copy, "the key is the identity";
  figures; its past │ its fee rates (two bars a row: it charges, its peers charge); addresses and features as chips; channels, open | closed, 25 a page
Channel page: id and state badge; funding; close (kind · how sure, why); its two ends' policies
```

Decided while building it:

- **The order answers the visit:** the figures, the history chart, then five-row previews of the largest and best-connected nodes (their "Top 100" in the panel's heading) and of the newest opens and closes. Every Lightning page has the short Overview and Rankings row; a node or channel leads back to the list the reader came from.
- **What is ours is said, not hidden.** Under the figures, one line says only channels checked against the chain are counted; how, and what the fee figures leave out, is behind "How these figures are made". History starts when this server's peer first synced: with no interval in the address the chart starts there and says so; a chosen interval hatches the time before it. The closed lists say they hold closes seen since then.
- **A close says how sure it is,** beside its kind: "Force close · Certain", "Cooperative close · Likely" (a splice that only takes funds out looks the same), "Penalty · Certain", "Other · Certain it is not a plain close". Lists give the kind in one word; the channel page gives the reason.
- **Charts are drawn in the series colours,** as the mining charts are: the main series an area, the second a dashed line on its own scale. Capacity in the figures reads in magnitude (`3 199 BTC`).
- **Names are claims.** A node's name is text, cut short in lists and titles with the rest one press away, and isolated so its direction cannot run into the text beside it; its public key is always next to it. Node colors are not shown: color carries fee and nothing else, and an operator's chosen color would only add a second way to imitate another node.
- **Tables fit a 320 px phone,** and every column keeps a gutter at every width. A chart's figures do too, with no sideways scroll: a time takes two lines (the day, then the time of day, with "UTC" in the header), and a node's fee figures are one table each way, headed with the chart's own words, side by side only where the panel holds both whole and one over the other otherwise. Long headers take two lines and fee-rate ranges break before their upper end wherever room runs short, at any width. A channel row puts its id, kind, time and both ends in one cell; a node list drops, on a phone, the figure it is not ranked by.
- **Switched off is a sentence,** not an empty chart: a network without Lightning says so, and a peer still syncing shows how far it has come and fills the page when done.

## Plain CSS or a utility framework

**Decision: plain CSS with custom properties.** The lean holds.

1. **The tokens are already the system.** `tokens.css` is plain custom properties. A utility framework would need the same tokens restated in its config and would add a build plugin to keep them in sync.
2. **No dependency.** Vite bundles plain CSS natively. Nothing to audit, upgrade or configure.
3. **Most styling here is not utility-shaped.** The hard parts are the strip, the map and the flow: positioned, measured and animated components that are custom CSS in either approach.
4. **Solid markup stays readable.** Class names describe the component (`tile__strata`) rather than its look.
5. **It meets the CSP.** Static CSS files only. Dynamic values go through `element.style.setProperty`, which `default-src 'self'` allows, never through `style` attributes in markup.

How to write it:

- Import `tokens.css` once, unchanged. It contains only `@font-face` and custom properties.
- Order everything else with cascade layers: `@layer reset, base, layout, components, pages;` so specificity never fights. `tokens.css` stays unlayered.
- One CSS file per component next to the component, with BEM-style names (`block`, `block__part`, `block--variant`).
- Pass per-element values (a fee color, a position) as custom properties set from code, such as `--c`, `--x` and `--w`.
- Override a token for a region by setting it on that region's element, not on `:root`. Unlayered `:root` rules in `tokens.css` beat layered ones.

## Prototype

The prototype shows the design before the council's rounds (the ten-hue fee scale, strata in every tile, the fee ladder): keep it as a record, not a target. `design/prototype/` holds `index.html` (home), `block.html` and `tx.html`, with plain ES modules and no build step. It needs an HTTP server, because browsers do not load fonts or modules from `file://`. From `design/`, run any static server on a free port, for example `python3 -m http.server 0`, then open `/prototype/`.

- Each page carries `<meta http-equiv="Content-Security-Policy" content="default-src 'self'">`, so anything the real policy would block shows up as a console error.
- URL parameters: `?network=signet|testnet4`, `?theme=light|dark`, `?autoplay=0` on the home page, `?h=<height>` on the block page, `?state=unconfirmed|replaced|confirmed` on the transaction page.
- The home page mines a block every 6.5 seconds. "Mine a block" triggers it at once, and "Auto-play" toggles the loop.
- The sample data is invented, seeded and repeatable. It follows late-2026 fee levels: most transactions pay under 1 sat/vB, and the floor is 0.1.
