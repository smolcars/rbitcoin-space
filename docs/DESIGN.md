# Design

The design language for rbitcoin.space. The tokens live in [`design/tokens.css`](../design/tokens.css). A static prototype of the home, block and transaction pages is in [`design/prototype/`](../design/prototype/); it predates the calmer design of the November 2026 design council and shows the earlier one, so the app, not the prototype, is the reference for how things look.

## Goal

A block explorer that answers the question a reader came with before it explains anything, in a calm interface where the figures are the loudest thing on the page, with motion that makes live data easy to follow.

## Idea: sediment, quietly

Transactions settle out of the mempool into blocks the way sediment settles into layers. The idea stays in the logo, in the words, and in how a block is drawn, but it no longer paints every surface:

- **A block is a core sample.** A block tile shows its fee make-up as layers settled in a box the size of the block's capacity: cheapest at the bottom, each layer as thick as the virtual size paying that band, the room above them the space the block left. The tile is drawn as that box, with a top and a right face behind its front, and the whole front is the gauge: the layers rise from its floor as far as the block is full, tinted behind the figures, and carry on round the corner onto the right face, so a half-empty block looks half empty at a glance. A block's own page draws every transaction as a rectangle in a clean block outline, as high as the block is full, the dearest at the top left.
- **Fee rate is intensity.** Cheap is a quiet steel grey, dear a strong blue-violet, through blue. The scale keeps its resolution between 0.1 and 5 sat/vB, where almost all traffic now sits, and it never uses red: an ordinary fee is never an error.
- **Mined is solid, projected is provisional.** Mined tiles are solid boxes, filled and outlined. Projected tiles are open wireframes, dashed, their faces clear. When a block is found, the next projected tile crosses the "now" line and sets: its faces fill at the top of its arc.
- **Palette:** cool neutral greys with one accent, rhodonite pink, for interaction. The accent is never a fee colour.

## Principles

1. **Answer first.** Every page opens with a compact answer to its reader's question: the fee to pay, a block's facts, a transaction's status and amount. The drawing and the explanation follow.
2. **Numbers are the content.** Every figure uses tabular digits. Amounts, rates and sizes are aligned, grouped and never squeezed. An amount a reader acts on or reads for one thing (an address's balance, a transaction's outputs, a block's reward) is exact to the satoshi, always in sight; only an overview read at a glance (the home page's blocks, the mining page's totals, a list of nodes) gives magnitude first (`2 793 BTC`), the exact value in its title. Decoration never competes with a number.
3. **Colour carries fee, status or interaction, never two at once.** The fee ramp is for fee rate, in the drawings and their keys, not as a swatch beside every number. Status uses the positive, caution and negative tokens, always with an icon and a word; red is for real problems only. The accent marks interaction: links on hover, focus, the current page, the block that just landed.
4. **Never colour alone.** A fee colour is always next to its number or its key. A status colour always has an icon and a word.
5. **Explanations are a second layer.** The one sentence that changes what a number means stays beside it. Methodology and longer notes sit behind a disclosure ("How these figures are made") a keyboard reaches. Each thing is said once, where it matters most.
6. **Motion explains a change.** Something moves only when the data changed or the user acted. One orchestrated moment per event, never ambient decoration.
7. **The network is never ambiguous.** A test network shows a band with its warning in words, a recoloured logo and a recoloured network switch.
8. **Chain data is text.** Transaction data, coinbase tags, OP_RETURN text, inscriptions and Lightning aliases are attacker-controlled. They are set with `textContent` and never parsed as HTML ([`SECURITY.md`](SECURITY.md) rule 14). Nothing from the chain is ever drawn as an image: an inscription that is not text is named by its type and size. The prototype builds every node with one helper that only creates text nodes.
9. **Sentence case everywhere.** No all-caps labels and no decorative eyebrows above headings.

## What to keep from the genre

The ideas people already understand: blocks as tiles in a strip, with projected blocks on the left and mined blocks on the right, the fee to pay right after them, and a block's transactions drawn as a packed map sized by virtual size.

## What is our own

The visual identity: logo, colour, type, spacing, motion, the fee ramp, the tile gauge, the "now" line, the network band. Nothing is copied from mempool.space, and its source code is never consulted.

## Constraints

| Constraint | Why |
|---|---|
| No third-party requests: fonts, icons and scripts are self-hosted | Privacy, and the Content-Security-Policy is `default-src 'self'` (its one opt-in exception, Cloudflare's beacon, is [`SECURITY.md`](SECURITY.md) rule 15). The one call the browser makes elsewhere is the decoder's `GET` of a service the visitor pasted (`connect-src`, the same rule) |
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
| `--color-veil` | `#e2e7ea` at 60% | `#050607` at 72% | Over the page under the command palette: frosted in light, dimmed in dark (below) |
| `--color-glass` | white at 70% | `#24292e` at 60% | The command palette's pane, only over a blurred page |
| `--color-glass-lit` | `#f8e1ed` at 75% | `#3b2230` at 75% | Its selected row |

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

### Lightning

`--ln-caution` (light `#c2410c`, dark `#fb923c`), an orange, marks caution on the Lightning pages: a direction disabled, a force close, an amount past what a channel forwards. It is not `--color-caution`, whose amber sits too close to the ochre of a channel's second direction (`--series-2`). Like the status tokens, it colours an icon beside a word, never the word alone; it reaches 3:1 on every surface (`contrast.test.ts`). "Enabled" takes the green of `--color-positive`, as confirmed does.

Two ramps of Lightning's own, for drawings that colour channels (none yet; a node's map is to come), never for text and never the fee ramp's sat/vB colours:

- **Forwarding rate**, ppm, quiet to strong: `--ln-ppm-1` to `-6`, light `#9399a0`, `#6c90a9`, `#4d82b3`, `#466eb8`, `#5255b6`, `#5c3bab`; dark `#646a70`, `#597f9b`, `#5b90c7`, `#7a9ce9`, `#a9a5ff`, `#d8aeff`. A grey through blue to violet that also steps in lightness, darker each step on a light page and lighter on a dark one, so neighbours part without hue: each step at least 1.15:1 from the last, the strongest 3:1 on every surface (`contrast.test.ts`).
- **Age**, one teal, `--ln-age` (light `#0f766e`, dark `#26b3a1`, 3:1 on every surface), mixed into the panel in five steps, `--ln-age-1` (the youngest, the teal itself) to `-5` (20%), each at least 1.15:1 from the next against the panel.

### QR codes

A QR code (the address page's address, a Lightning node's connect string) is drawn dark on a light card in both themes, never inverted: `--qr-paper` (`#ffffff`) and `--qr-ink` (`#161b1e`), the same in both, with the logo's arriving layer in `--qr-mark` (`#a8196b`). Its modules are soft: each dark module's corners round by 0.4 of a module where both neighbours on that corner are light, so a lone module is a soft square, a run a rounded bar and a clump a blob, with a small fillet filling each inside corner. The three finders are a nearly square ring (corners of a tenth of a module) round a soft pupil, in their 1:1:3:1:1 proportions: rounder rings and round dots cost a decoder its read ([`FRONTEND.md`](FRONTEND.md#qr-codes)). The card runs edge to edge in the pop-up, so the code gets every pixel a phone has, and on a short screen it is no taller than the room left, so the whole symbol is always in view. The logo sits in the middle, sized so the code still reads with room to spare ([`FRONTEND.md`](FRONTEND.md#qr-codes)): a short code (an address) shows the whole mark in a clear square; a longer one (a connect string) keeps the alignment pattern decoders look for in its middle, and that square becomes the block the crab lifts, its claws either side, its arriving layer above in `--qr-mark`; the crab is drawn a little smaller than the block would make it, with white round it. A code too dense for its card has no logo, and below that a plain look: square modules and finders, as a dense code on a small card must scan before it looks good. The thresholds, in pixels a module, are in [`FRONTEND.md`](FRONTEND.md#qr-codes). The quiet zone of four modules is part of the card.

A node's code is drawn in the colour the node announces, so each node's code looks like its own; the crab in the middle takes it too. A colour under 4.5:1 on the card (the site's text bar, well past what a camera needs, so a dim screen or glare still reads) is darkened, keeping its hue, until it reaches that; a line under the code says which, with the announced colour as a swatch.

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
- **The layout holds in every system's font, up to DejaVu Sans's width.** The prose font is the reader's, so the design is checked in more than a Mac's: Linux's DejaVu Sans is about 10% wider than San Francisco on the site's own strings (its bold 18%), Noto Sans 3%, while Roboto, Cantarell and Arial are as narrow or narrower. Nothing is sized to one font: a row of figures gives each column at least its figure's width (`minmax(min-content, 1fr)`), and goes to fewer per row where they do not fit; a figure never wraps inside itself or away from its unit, while words, labels and table headers wrap; an exact amount wider than its field (a phone's flow card, a balance of a hundred thousand bitcoin) breaks after its point or before its unit, never between its groups, and never reads in magnitude in its place. `fonts.e2e.ts` checks every page type in a stand-in for DejaVu Sans ([`FRONTEND.md`](FRONTEND.md#other-systems-fonts)).
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
| BTC, exact | Every amount a reader acts on or reads for one thing: a transaction's, an address's (its balance, received and sent too), a block's reward and fees, an invoice's. Never rounded, whatever the room: all eight decimals, grouped as sats read, 2 + 3 + 3 (`formatBtc`, `Amount`), so the last six digits are the sats under a hundred thousand; whole bitcoins in threes as any figure. Trailing zeros in the muted colour at the same weight, group spaces with them, so the number reads as one. Hover shows sats. Where a full amount does not fit (a phone's flow card, a large balance) the field lets it break after its point or before its unit (`Amount wrap`), or sets it a step smaller; a table scrolls sideways. An address's totals each have a copy button beside them that copies the amount as a program reads it (`plainBtc`) | `1 234.56 789 012`; `0.03 500 000`, with `00 000` dimmed |
| BTC, overview | Only in an overview read at a glance: the home page's block tiles and mempool panel, the mining page's totals, lists and rankings of Lightning nodes and channels. Magnitude first (`formatBtcShort`, `Amount short`): whole bitcoins from 1 000, two decimals from 1, three significant digits below. The exact amount and sats in the title. A chart's axis is a scale, not an amount, and reads its round steps compactly (`formatBtcScale`); a chart's readout of one point is exact | `2 793 BTC`, `3.15 BTC`, `0.0225 BTC` |
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
- **Addresses** in the flow diagram: on one line, cut in the middle only as far as the card needs (`Hash fit`), the last eight characters always whole.
- **A short form never loses its end.** Where even `a3f9c2e1…7b0d44e9` or `mwLW3XD…UAuat` is wider than its room (a 320 px phone, a wide font), its head gives way, down to two characters and its "…" (`mwLW3…UAuat`); the tail stays whole.
- **Copy button:** a 28 px drawn button in a 44 px target that takes only its room, kept clear of the link beside it. It copies plain text a program can read: a hash, address or key exactly as on the wire, an amount as digits and a point with no grouping and no unit, its unit named in the button's label ("Copy the exact balance, in BTC"). "Copied" rises above the button, never over the value it copied, inside any scrolling table so nothing clips it (below it in an exact amount's pop-up that opened below its figure). On press it turns positive, pops once, and the word "Copied" shows, at a readable size, while its label reads "Copied" for screen readers, for 1.4 s, only when the value was copied. When the browser copied nothing, its icon turns to a cross in the negative color, "Not copied" shows above it and "Could not copy" is announced, for 3 s.

### Time

Relative time ("13 min ago", "1 day 23 h ago", "9 days ago": days lead from a day on) in lists, with the absolute UTC time in the `title`. Detail pages show absolute UTC first (`11 Nov 2026, 20:41:07 UTC`, the form chart read-outs use, there to the minute) and relative time below. Under 10 seconds is "just now". Block tiles drop "ago" to fit ("13 min").

A block's time to mine (the Blocks page) is its time less its parent's, to the second under an hour ("9 min 12 s"). Under it, a bar as long as the time, full at 30 min, with a tick at the 10-minute average: `--color-line-strong` on `--color-line`, and `--color-caution` from 20 min, the one place caution marks a figure rather than a state, so a slow block stands out without a word in every row. Miners set block times, so one can come before its parent's: it keeps its minus sign. A slow time and a negative one are dotted, and explain themselves in a note (`Note`) on hover, focus or tap, and again on Enter, Space or a tap once Escape or a press elsewhere has closed it (the button is named by its figure alone, the note being its description); a tile on the home strip timed before its parent gives the same note on its time, below the tile.

## Space, shape and layout

- **Space** on a 4 px grid: `--space-1` 4, `--space-2` 8, `--space-3` 12, `--space-4` 16, `--space-5` 24, `--space-6` 32, `--space-7` 48, `--space-8` 64.
- **Page:** max width `--page-max` (85rem), side gutter `--gutter` (16 px on phones, up to 40 px).
- **Radius follows hierarchy:** `--radius-s` 2 px for map rectangles, swatches and block tiles (nearly square, so a tile's faces meet its corners), `--radius-m` 6 px for controls and wells, `--radius-l` 10 px for panels, `--radius-pill` for chips. Do not use one radius for everything.
- **Sections are panels.** A `section` whose first child is a `SectionHeader` is a panel: `--color-surface`, a 1 px `--color-line` border, `--radius-l`, `--panel-pad` inside (`global.css`). A panel inside a panel is a group, not another card. Things that are not sections but read as one group take the class `panel` (the block's facts, its map). Headings sit at the top of the panel with no rule under them.
- **Shadow:** `--shadow-panel`, a hairline in light and none in dark, under panels; `--shadow-pop` on floating things.
- **Touch:** every control a thumb uses has a target of at least `--touch` (44 px) each way that no neighbour's covers. Small drawn buttons (copy, expand, theme) keep their size and get the target from an invisible margin on touch screens; so do links and figures in a line of text (`.tap` round a control, `.tap-line` on a line that cuts itself with an ellipsis, in `global.css`), so the target grows and the look does not. Exceptions, each meant: a link inside a sentence, which the words around it place; and a phone's flow card, three short lines with a control on each, whose address and spending links are also in the inspector its details button opens: they keep their line's height, so no target in the card reaches over another; and a node's channel card, whose first line's peer and channel are also under its chevron, a thumb's target there. `targets.e2e.ts` holds the rule on every page type.
- **Sideways rows are moved by hand:** a row of tiles or choices that scrolls sideways (the block strip, the mining page's recent blocks, the period, view and chip rows, the header's sections on a phone) follows a mouse press and drag, and glides on and slows after a quick one, as a swipe does on a touch screen; under reduced motion it stops where the hand let go. A press that moves less than 6 px is still a click, a drag released over a link does not open it, and a modified click (Ctrl, Cmd, Shift, Alt) stays the browser's. The cursor is a grab hand over a row that has more to show. The tile rows hide their scrollbar: the wheel, a trackpad, a swipe and the keys still move them. Tables and text boxes do not drag, so their text selects as usual (`components/dragScroll.ts`).
- **Tiles:** `--tile-w` 8.25rem, `--tile-h` 10.25rem, `--tile-gap` 1rem, and `--tile-depth` 0.5rem, how far the top and right faces reach back into the gap. Phones override the size and gap on the strip element. The faces are the tile's own shades, `--tile-face-top` (light `#dce2e6`, dark `#262b30`) and `--tile-face-side` (light `#d2d9de`, dark `#131619`), outlined in the tile's border, so a hover or the accent outlines the whole box. The front's layers sit under the figures, tinted (`--tile-tint`, 0.19 light, 0.25 dark: the most that keeps muted text at 4.5:1 over every band, which `contrast.test.ts` holds), with no seams to run through the text. A 2 px mark in the top band's full colour, in the right padding where no figure reaches, shows where the fill stops, at 3:1 against the empty room above it. The right face repeats the layers in shadow (`--tile-side-shade`, 0.82 light, 0.62 dark) and holds no text. A projected tile's faces are clear and its side layers at 55% (`components/BlockBox.css`).
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

### The goggles

Approved by the owner as a mockup (GG5), on a phone. On the block and projected-block pages, not the home page.

- **Closed, one button.** "Highlight" under the map; the picked kinds beside it as tags joined by "or" or "and", × to take one out; one result line, "9 of 3 862 · 0.2% of the block" (the count in transactions, the share in virtual size, the area the eye sees).
- **Open:** a bottom sheet on phones and tablets (to 65em), the map kept in view above it; on a desktop a panel docked beside the map, over the facts. Done or Escape closes it.
- **Kinds:** five first (Taproot, Inscription, OP_RETURN, Consolidation, Paid by a child); "More kinds" opens the rest in four groups. Each shows its share of the block, with a wash as wide as the share. Absent from the block: dashed, cannot be picked. In "All" mode, one that would leave nothing lit turns dashed before it is picked. "Any / All" and Clear appear once a kind is picked.
- **The map:** unmatched squares fade where they stand to `--txgrid-dim` (0.14 light, 0.2 dark), matched ones keep their fee colour and grow back into place; reduced motion only fades. While a tenth or fewer are lit, each lit square under 5 px is drawn at 5 px in a ring of `--color-text`: one inscription among 4 000 squares is found at a glance on a phone.
- **Words:** titles, figures and controls only, no instructions.

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

- **Five words for where it is.** Unconfirmed (in the mempool), Confirmed, Replaced (another transaction spending the same coins took its place), Dropped (it left without being mined, for a reason the node does not report) and Removed (the node no longer has it: nothing says why, or the server knows it left with a transaction it depended on, which was replaced, and the page then says so), in the badge. After a replacement, a drop or a reorganisation the full timeline says how it came to this: its middle step carries the same word with its detail, and a replaced version's last step is "Will not confirm", struck through.
- **Where it is** is the summary's first figure, with the block strip in small inside it. Waiting: "Projected", the block in a few words ("Next block", "~3 blocks", "7+ blocks", linked to that block's page), the strip, and "1 022 txs ahead" (its kvB in the title). The strip is the projected blocks as dashed slots running to a dashed "now" line, the next block nearest it, and the transaction one square in the fee colour of the group it will be mined with. Mined: "Block" and its height, linked, the square crossed into a solid block right of the line with the blocks found since between them and dashed slots for those still to come, six in all, and "1 of 6 confirmations" (a coinbase counts to its 100, "Spendable" after; the genesis coinbase is "Never spendable"). The home strip's rule: projected left and dashed, mined right and solid.
- **The sentences sit behind one disclosure** under the summary, "How this changes" while it waits, "When it is final" once mined ("When it can be spent" for a coinbase): how much would be mined before it and what that means in time, that it is a projection, not a promise, and that it can be replaced until it confirms (full replace-by-fee). A block is on average ten minutes away whenever one looks, and about one in seven takes more than twenty (an exponential wait), so the next block is said that way; later blocks get a rough figure ("~30 min") at the usual pace, with the condition that nothing paying more arrives; regtest says it has no schedule. The figures above it each carry at most one short line.
- **Alive without twitching.** The square travels only when its block changes (`--dur-slow`, `--ease-in-out`); what is ahead of it changes in place. Each new block moves the mined strip on by one. Nothing is announced for a position that only moves: only entering or leaving the next block, and every change of state, once, in a polite live region.
- **The position bar of the prototype is not used.** The projection says which block a transaction is in, not a percentile of one, and the strip says that directly.
- **Mined with.** When the rate it will be mined at prints differently from its own, the fee rate's figure adds one line, "Effective 12.5 sat/vB", and the side panel's details end with the group: its members in mining order (this transaction, its child, its parent), each with its own rate and a link, eight at a time with a "Show all" button (this transaction always among them), one sentence saying who lifts whom ("On its own it pays 1.00 sat/vB, but its child pays enough to lift the group to 12.5 sat/vB as a whole"), and behind "Why" why miners take such a group whole, naming child pays for parent last.
- **Replaced** is a notice under the summary, above the timeline, in the negative colour: what took its place, linked, with both rates and both fees, and that this version can no longer confirm. A longer chain is listed oldest first, and the newest version's own state ("It waits in the mempool: in the next block", "It confirmed in block 975 530") is followed live. Opened later, when the node says not found, the same notice comes from the server's record of replacements; when the record has nothing, the not-found state says the record is recent and holds nothing for it, and that the page will show the transaction if it is broadcast while open.
- **What changed** follows the chain inside that notice, and is its own panel on a version that replaced others: the two versions' fee, rate, virtual size, total paid out and inputs side by side with the change, then the outputs matched by where they pay, each marked Same, Changed (with what it was and the difference), Added or Removed. Each kind is a word with a drawn mark (`=`, `≠`, `+`, `−`; Removed's dashed, its amount struck through), never a colour: green means confirmed and red real problems, and a removed output is neither. What stayed the same steps back to the muted ink, so what moved reads first. Each link of the chain has a "What changed" toggle for that pair, and a line of three or more versions gets two pickers, From and To, for any two: one pair, so a toggle is pressed only while its pair is the one shown. When one side's figures came from the node, both sizes are weight over four and a line says so, so a change of method never reads as a change. On a phone each figure is its label, the two values under it, then the change, and each output two lines. A transaction that left with a replaced parent says so in a line, and is compared only with its own versions (one it bumped, say), never with what replaced its parent: the line of versions offers only versions; outputs the server did not keep, or too many to keep, are said in a sentence and the figures still stand.
- **Dropped** is a notice that lists what it may have been (pushed out by fees, expired, made invalid by a reorganisation, or replaced by a transaction the server did not see) and that it will not confirm unless broadcast again. It never says "replaced".
- **The happy moment:** when it confirms while the page is open, the square crosses the "now" line and lands in its block with `--ease-settle` over `--dur-slow`, once, and the live region says "Confirmed in block N." Reduced motion keeps only the change.
- **Back from a reorganisation** is a caution notice ("Back in the mempool") naming the block that held it, saying it waits to be mined again and can be replaced meanwhile, until it confirms again.
- **Not live, quietly.** Beside the badge, an icon and a word: "Live" (a breathing dot), "Connecting", or "Not live" / "Node not answering" with what the page does instead ("Checking every 10 s instead."). Without the live channel there is no position to vouch for, so the figure reads "–" with "Shows while live" (its sentence in the disclosure); with the mempool engine off on the network, "Not followed here". A settled transaction shows no indicator: nothing on it can change.
- **The address page** shows "Live" under its header while the node watches the address, and otherwise says plainly that the page does not update by itself and why (too much history to watch, the node watching as many addresses as it can, the node out of reach), never as an error.

## Components

| Component | What it is |
|---|---|
| Header | Logo and wordmark, network switch, search, navigation (Blocks, Mempool, Mining, Lightning, and Ark on a network that has an Ark server), theme toggle. Sticky, except on a screen under 30em tall (a phone on its side, a page zoomed in or set in a large text size), where it scrolls away with the page. Focus and in-page links stop clear of it. One row on wide screens. Between 640 and 1040 px (tablets, a desktop at 200% zoom) two rows: the brand, the search and the theme toggle, then the network switch and the sections. On a phone two rows of about 100 px in all: the mark, the network, the search (its hint one word, "Search") and the theme, then the sections sharing the row, every one in sight at 320 px: four evenly, five (with Ark) each as wide as its name. A focused search takes the whole first row, the mark, network and theme stepping aside, so it and its answer are the phone's width. The network and theme are 44 px targets around a smaller drawn pill and square |
| Network band | A slim band tinted with the network colour, a short hatched mark and the warning in words. Test networks only |
| Logo | `design/logo.svg`, also the favicon: a crab, a nod to Rust and to rbitcoin's own crab, lifting a block of three strata, the top layer shorter, offset and in the accent, still settling. In the header it is inline SVG, 32 px: the crab and the two settled layers in `--color-network`, the top layer in `--color-accent` on every network. The wordmark is live text, so a new name is one string |
| Block tile | Projected (dashed) or mined (solid). Height or label, median fee, fee range, total fees (in magnitude), its fee layers, transaction count and age. Mined tiles link to the block and show the pool below |
| Tile layers | The block's capacity as a box, its fee bands settled from the floor, cheapest at the bottom, each as thick as the virtual size paying it (`strataLayers`); the room above is room the block left. Until the block's facts arrive, a neutral gauge of the same height stands in |
| Block strip | Projected lane, "now" line, mined lane. Scrolls sideways inside itself, by a drag, a swipe, the wheel or the keys with no scrollbar, and starts centred on the line; the mined lane goes on into the past down to block 0, and "← Now" in its head brings the line back ([`FRONTEND.md`](FRONTEND.md#the-block-strips-past)) |
| Fee answers | "Fee to pay now": up to four plainly labelled rates, slowest first (No rush, Low, Medium, High), each with its unit and what it promises (within a day, within an hour, within 30 min, next block), rounded up. Levels next to each other that print the same rate are one answer ("No rush or low"), never stacked labels. Wide, one row of four, an answer for several levels as wide as they are; on a phone two rows of two whatever merges: Low and Medium alone are never merged, a lone answer beside three takes its row, and one answer for every wait ("Any wait") is one tile across the row. A line under them only when it changes what they mean: the node's estimates, or one answer for every wait (the next block has room at that rate). In sunken wells |
| Mempool panel | The home page's mempool, each part a fixed height: the next projected block's map, read-only (no Highlight), headed by a link to its page and the fee rate the next block's worth reaches down to; the four figures, two by two; and what has been arriving, in vB a second over the last two hours, as a line chart. Side by side on wide screens, stacked on narrower ones. The map and chart load once the panel nears the view. The size by fee band is on `/mempool` |
| Fee key | Twelve swatches with lower bounds, in one row where their labels fit and two rows of six where they do not (the test is in the labels' own font). Beside a drawing that needs one (the block map, a projected block), never repeated where the figures already name the bands |
| Fee chip | A number and its unit, with a swatch only where it is the key to a drawing (`FeeRate swatch`) |
| Amount | BTC exact, grouped, with dimmed trailing zeros, sats on hover; `wrap` where it may outgrow its field; `short` for an overview's magnitude |
| Hash | Truncated or grouped, monospace, with copy; `whole` wraps the full value |
| QR scanner | A scan button (a frame with a line across it) at the right end of the header search, inside its box; under 360 px it shows once the search has focus. It opens a dialog on the raised surface: the camera's view in a square well with four corners to hold a code in, which close in on a read code and take the accent, then the page it leads to opens; one line saying what is happening (starting, hold the code, blocked, no camera, nothing in that picture), "Choose a picture", and a muted note that nothing leaves the device. Without a camera the well shows a camera mark and the picture is the way in. On a phone, a sheet from the top. A code the site does not know is said in the search's answer, "Code not recognised", its text quoted ([`FRONTEND.md`](FRONTEND.md#qr-scanner)) |
| QR code | A small button beside a copy button that opens a pop-up by it: "Scan the address", the code on its light card, the value as text below. Closed by Escape, a press outside, its close button or a scroll ([QR codes](#qr-codes)) |
| Stat | Label above a figure, optional muted sub-line |
| Fact list | `dl` of label and value pairs, two columns or one |
| Summary | The transaction page's answer: four figures in a panel, each a label, a value and one muted line: where it is (the block strip in small), fee rate (sats and vsize; once mined, a quiet line comparing it with its block's low end, [`FRONTEND.md`](FRONTEND.md#a-confirmed-transactions-fee-verdict)), amount (inputs to outputs), and first seen or mined. Each at least as wide as its figure; on a phone two by two, a wide amount on a row of its own. The broadcast page's three figures (fee, amount, size) are label-value pairs of the same kind |
| Table | Units in headers, bare numbers in cells, numeric columns right-aligned in the monospace, a gutter on both sides of every column, row rules. Phones drop the least important columns and may show a shorter header (`short`). A list's row is one target: a tap anywhere on it opens its item, the cells' own links and buttons staying on top and the row link hidden from the keyboard and screen readers. Identifiers in a list take as much of their column as it allows, cut in the middle only when they must |
| More | The second reading layer: a disclosure ("How these figures are made", "How this changes", "Why") holding methodology and longer notes, under the one sentence that stays visible |
| Lightning nav | Lightning's own way around: Overview, Rankings and History (the overview's chart, by an anchor) in one short row above the title, and on a node or channel a "←" link back to the list the reader came from, a search's results included |
| Packed map | Rectangles sized by vsize and coloured by fee band, the dearest at top left, one clean block on the floor of the frame ([The transaction grid](#the-transaction-grid)). Tooltip on hover, click opens the transaction, rows in the table below ring their rectangle. Comes with a caption and the fee key; the table is its text alternative |
| Flow diagram | Inputs on the left, outputs on the right, ribbons as thick as the value they carry, meeting at a bar that is the transaction. The fee leaves as its own ribbon in its fee colour. A card is a two-line ledger row: the address (cut in the middle as the card needs) and the exact amount, then the script type and whether it is spent; on a phone three short lines, the amount first, and both columns start at the top. The amount is always exact: where it is wider than the card (a phone, a wide font, a thousand bitcoin and more) it breaks after its point, onto a line more. Text on the chain has a line of its own under the ledger row, behind a dashed rule, in the body colour and in quotes, cut after two lines (three on a phone): a coinbase's words on the coinbase card, an OP_RETURN's text on its output, an inscription's text on the input that reveals it, after a quiet "Inscription". An inscription that is not text reads "Inscription, image/png, 793 B" there, and an OP_RETURN that is not text "OP_RETURN, 44 bytes" in the name. Each card's button opens its inspector: in the side panel beside the flow on a wide screen (the chevron points right), under the flow on a narrower one |
| Status badge | Pill with icon and word: Confirmed (check), Unconfirmed (dashed circle), Replaced, Dropped and Removed (cross) |
| Timeline | Numbered steps: first seen, replaced or replacing, waiting. Only after a replacement, a drop or a reorganisation, when the badge and the summary alone would not say how it came to this; horizontal on wide screens and vertical on phones. A version that can no longer confirm is struck through with a dashed marker |
| Notice | Bordered strip for important state, such as "This version was replaced" with a link to the replacement |
| Tooltip | Raised surface, title line and muted detail lines. Opens on hover and keyboard focus |
| Command palette | Go anywhere from one field: ⌘K or Ctrl K, the header's key-cap hint, or, wherever the hint has no room, "Go to a page, pool or date" hanging under the search while it has focus ([below](#command-palette)) |
| Buttons | Default (outlined) and accent (filled). Toggles use `aria-pressed` and show a dot when on. 44 px tall on touch screens |

### Command palette

The one glass surface on the site: a pane in the upper third of the screen over the page under `--color-veil`, which frosts it pale in light and dims it in dark. The pane is `--color-glass` over the page blurred (40 px) and its colours lifted (saturation 1.8), with a bright hairline edge (white at 70% in light, 14% in dark) and a darker rim outside it so it holds on a pale page, light caught along its top edge, and a wide soft shadow, at a 16 px radius, a step rounder than a panel because it floats above them. The selected row is lit glass: `--color-glass-lit`, light along its top and a faint accent rim.

Text keeps 4.5:1 over any page: `contrast.test.ts` takes the darkest and the lightest page pixel, lays the veil, the glass and the selected row's tint over it, and measures the text, muted and accent tokens on each result. The worst cases: muted text 4.62:1 (light) and 4.73:1 (dark) on the pane over a black or white page, the accent 5.07:1 and 4.72:1, body text 12.65:1 and 9.92:1; on the selected row muted text 4.99:1 and 5.46:1. Thinner glass is held up by the veil, not by a weaker bar. Without `backdrop-filter`, or under `prefers-reduced-transparency`, the pane is the solid `--color-surface-raised` and the selected row `--color-accent-soft`: unblurred glass would let a page's text read through.

- **Inside:** one field at `--text-xl`, then rows in named groups, each a drawn mark in a small well, its name, a muted line under it where there is one, and its kind in words at the end, so the mark never carries the kind alone. The selected row's mark is outlined in the accent. A foot of key caps (↑ ↓ to move, ↵ to open, esc to close, drawn as the search's `/` is) and the network it works on.
- **Motion:** opening, the pane settles down 8 px from 98.5% over `--dur-base` as the veil comes over `--dur-quick`; closing, a quicker fade upwards. None under reduced motion.
- **Phones:** a sheet from the top, 8 px from each edge, as tall as the room the on-screen keyboard leaves; the key hints give way to the network alone.

## Page layouts

### Home

```text
┌ header ─────────────────────────────────────────────────────────────┐
├ strip band (sunken, full width) ────────────────────────────────────┤
│ Blocks   ┆ projected ▭ mined ■                                 Live │
│ [+11][~30m][~20m][Next] ┆now┆ [975411][975410][975409][975408] …   │
├─────────────────────────────────────────────────────────────────────┤
│ ┌ Fee to pay now ───────────────┐ ┌ Difficulty adjustment ────────┐ │
│ │ No rush  Low    Medium  High  │ │ [████████░┃░░░░░░] 398/2016   │ │
│ │ 0.14     0.22   0.27    3.29  │ │ ↑ Up 14.9%  in 9 days  ↓ 9.1% │ │
│ └───────────────────────────────┘ └───────────────────────────────┘ │
│ ┌ Mempool ─────────────────────────────────────── Mempool history ┐ │
│ │ Next block  1–1.5   │ Transactions Size │ Arriving 902 vB/s     │ │
│ │ ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐ │ 74 179  31.77 MvB │   ╲__/‾‾╲___          │ │
│ │ ╎ next block map  ╎ │ Fees    Lowest    │                       │ │
│ │ └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘ │ 0.079   0.10      │ 14:57       15:06     │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│ ┌ Latest transactions ──────────┐ ┌ Recent replacements ──────────┐ │
│ └───────────────────────────────┘ └───────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

The fee to pay is the first panel after the blocks, so a phone shows it on its first screen. The difficulty bar is neutral (never a fee colour); its mark is where the period would be at one block every ten minutes, and the sentence saying how far ahead or behind is the bar's title, not a line of its own. Changes read as an arrow and a word ("Down 7.05%"). On a network that never retargets (regtest) the section says so instead.

Wide screens: the fee answers and the difficulty in one short row, the mempool across the width, then the latest transactions beside the recent replacements, six rows each with ids cut in the middle, so the top of every panel is on a 1440 × 900 screen's first view. Phones: one column, in the order fees, mempool, latest transactions, difficulty, replacements; the strip scrolls sideways; stats in two columns.

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

The facts come first in reading order; on a phone the map follows them, then the details. The coinbase tag reads as its words ("Mined by Luxor", "/F2Pool/"), the same reading as the transaction page's coinbase card; a coinbase with no words shows every visible character, dots for the rest, or its hex.

**The Stratum V2 mark.** A block whose coinbase is laid out as the Stratum V2 reference implementation writes it carries "Sv2" after its miner's name, here and in the blocks list. It is a neutral chip: muted text, a `--color-line-strong` outline, `--radius-pill`, `--text-xs`. It names a kind of block, and colour is for fee, status and interaction. In the list it is not a control: it opens nothing of its own, and it reads "Stratum V2" aloud. On a phone it sits under the name, as the age sits under the height, so the name keeps its width and the row its height; the name's touch target reaches over all of it, so a tap on it opens the pool's page, as one on the age opens what the height does. On the block's page an unmarked name's link fills its line, and a marked one stays at least `--touch` wide however short the name. On the block's page it is dotted and opens a note (`Note`) on hover, focus or tap: "Stratum V2 coinbase tag", then what the mark rests on: the coinbase's layout, which is what the block's builder wrote and not something the chain proves. Tiles do not carry it: their pool line is one fixed line.

### Transaction

```text
Transaction  (◌ Unconfirmed)  • Live
65428488 a6202f1d 681d053b …  [copy]
┌ summary ─────────────────────────────────────────────────────────┐
│ Projected        Fee rate        Amount           First seen     │
│ Next block       1.00 sat/vB     0.03169119 BTC   just now       │
│ ┆┆┆┆┆┆┆■┆ now    141 sats, 141 vB 1 input to 2 …  17 Nov, 14:25  │
│ 45 txs ahead                                                     │
└──────────────────────────────────────────────────────────────────┘
› How this changes                       (When it is final, once mined)
[notice: replaced, dropped, back in the mempool]   (only then, with the full timeline)
┌ Inputs and outputs ─────────────────────────┐ ┌ What an observer … ┐
│ [addr…  0.031 ›] ═╗          ╔═ [addr… 0.03 ›]│ │ ◉ Address reused   │
│ #0 P2WPKH        ╠┃trunk┃╣ #1 P2WPKH Unspent  │ │ › What this checks │
│ ◉ Reused address  ║          ║ ◉ Reads as change│ └────────────────────┘
│                   ╚══════════╚~ [Fee   0.00  ]│ ┌ Details ───────────┐
└───────────────────────────────────────────────┘ │ Size, weight,      │
                                                  │ replaceable,       │
  (with nothing to report, the privacy panel      │ version, witness,  │
   is one muted line after "Details")             │ lock time, raw hex,│
                                                  │ mined with         │
                                                  └────────────────────┘
```

Once mined, the first figure is "Block 976 283" over the strip with the square past the "now" line in a solid block ("3 of 6 confirmations"), and the last is "Mined". The flow sits beside a side panel holding the facts the summary does not: size, weight, replaceable, what it replaced, version, witness, lock time and the raw hex ("Show" opens it in place), then who it is mined with. The panel stays in view while the flow scrolls, once anything above it in the column has scrolled by; only with the muted "nothing to report" panel under it does it scroll with the page, since held it would slide over that panel. Each input and output card starts its meta line with its number, muted ("#0"), Bitcoin's zero-based index, as the privacy check's sentences and the card's details button name it. Opening a card's details shows its inspector in that panel, over the details (and the privacy panel), in the room they held, so nothing on the page moves on a wide screen; "Close" brings the details back. Text on the chain reads whole in the inspector, in a sunken well in the reading font ("Coinbase text", "OP_RETURN text", "Inscription text"); an inscription adds an "Inscription" fact, its content type and size, with "not shown" when it is not text. "Block height in script" shows only when the script carries the block's own height. Under 65em the panel moves under the flow and the inspector opens above the details, in the page's flow. Long input or output lists collapse after ten; each "Show more" adds a hundred, and the hidden rest travels as one ribbon, so a transaction with thousands of outputs never renders them all at once. Each fact is said once: the fee in sats and the virtual size under the fee rate, the fee in BTC on the flow's fee card, the counts of inputs and outputs under the amount. The Lightning note, for a transaction that opened or closed a channel, follows the flow and the panel.

**The privacy check** is, at 65em and up, a panel of its own in the side column, always with its heading. With findings, or only part checked, it opens the column, above "Details", so the marks on the cards and what they mean are on the first screen together (at 1280 × 900 it starts about 420 px down; "Details" follows at 710 to 990 px on the guide's examples). With nothing to report its one muted line follows "Details". Below 65em it sits under the flow, in the flow's panel, after a hairline, off the first screen, so the summary ends with a row of its own that leads to it ("2 things an observer can read", "…, only partly checked", or "What an observer can read: only partly checked"; no row when there is nothing to report). A full row, never a half-width cell, so it stays one line on a phone; the eye on its first line if it ever wraps. It is there from the first paint, so the summary never grows. It says what an observer can read from the transaction's shape ([`FRONTEND.md`](FRONTEND.md#privacy-check) has the rules and every sentence). Reuse or change fires on about half of mainnet's transactions, so it stays quiet: one signifier, an eye, beside every mark and finding; small marks at the end of a card's meta line ("Reused address", "Reads as change", "Reads as payment", "Equal amount"), below 40em one word each that never wraps in a 120 px card ("Reused", "Change", "Payment", "Equal"), the full words their accessible name and in the list; a short list, a finding's title in bold and its sentences under it, reasons as bullets; no banner and no box. The caution colour, with the filled eye, only where something is given away; a CoinJoin's shape in the text's colour with the open eye, neither warning nor praise. A transaction with nothing to report gets one muted line and the "What this checks" disclosure. Only part checked, muted lines after the findings say what could not be checked and what that may leave incomplete. It is worked out with the page, so it arrives with the cards and moves nothing. The two point at each other: each number in a finding is a link to its card, a small chip on the sunken surface, its target 24 px each way past the chip, and the list's lines 24 px apart, so neighbours in "0, 3 and 4" and on the lines above and below never share a target (WCAG 2.2's 24 px for a link in running text, which `targets.ts` holds them to); and each mark a link to its finding; following one scrolls the target into view (instantly with reduced motion), opens "Show more" first when the card is one press behind it (a card further down is never drawn: every card before it would be, thousands on a large payout, so its link opens that input's or output's details instead, as its own button would, and closing them returns the focus to the link), focuses the card's details button or the finding, and outlines the target for a moment. A count ("65 inputs") links nothing. Punctuation after a number or an address sits against it and never starts a line ("(input 11),"), the room the targets need taken after the mark. A shortened address may break after its "…", never inside its head or its tail, so with its mark it fits a phone's line at large text; a number never breaks. Where readings disagree, each starts with what it suggests ("Payment:", "Change:"), since there the direction is what disagrees; where they agree, the title says it and each reading gives only its comparison. When reuse is the only reading behind "reads as change" and names one address, the change finding points at it ("it pays the reused address.") rather than restating the match. "What this checks", opened, starts its text where a finding's text starts, the change readings one numbered item each.

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

A history row whose transaction names a lookalike address ([`FRONTEND.md`](FRONTEND.md#lookalike-addresses)) has a caution note under it, one with the row: the caution rule and a warning triangle beside a bold line that says what was found, then the two addresses one above the other, labelled, whole and wrapping, the ends where they agree bold with a caution underline and the middle where they differ muted, then one sentence saying it may be poisoning and to check every character before copying. Never the colour alone. On a phone the labels go above their addresses. Nothing in it is a target. When the loaded history holds one, the page also opens with a notice above the totals, in the same language on a panel's ground (the caution rule, the triangle, a heading): how many transactions, a lookalike of the address itself shown whole beside it, one sentence of advice and one button to the first marked row. An agreeing end of up to 12 characters never breaks across lines; a longer one breaks where a narrow screen needs it to. A history with no lookalike shows nothing new. Opened from a marked row, the transaction page carries the same language: the notice above its summary, on a panel's ground; the lookalike's flow card with the caution rule on its left edge and "Lookalike" in bold with a small triangle on its meta line; and in the inspector the address whole, its agreeing ends marked, over a sunken note with the caution rule that shows what it resembles. Opened any other way, it shows nothing new.

As of a past block (`?at=`), the live line gives way to a band that leads the page, so the page is never mistaken for the live one: a panel with one thick muted rule down its left edge and a small mark beside the heading, layers cut by a dashed line, a core sample read at one depth. (The edge was once drawn as three settled layers; stretched down a short band it read as a broken border, so the mark alone carries the layers.) From 65em it is one row of about 80 px: on the left "As of block N" at `--text-xl` with the block's time muted beside it (to the minute, then relative) and one short line under them, "Later blocks and unconfirmed transactions are left out; it never updates."; on the right "Back to now" as the one accent button, then "‹ Previous change", "Next change ›" and "Another block" (with the clock of "As of a block") outlined. On a phone the same pieces stack in about 170 px and the four controls share one row: the steps and "Another block" become 44 px squares showing "‹", "›" and the clock, named in full for assistive technology, and the two arrows sit under a small muted caption, "Changes" ("First use" when that is the only step), plain text with no border so it is not taken for a button, so a sighted reader too sees that they step between the address's changes and not one block. The caption takes height rather than width, which is what lets four controls fit at 320 px in a wide font. The time drops "Mined", and the sentence becomes "Confirmed through this block.", which says the same in four words: what is shown is what had confirmed by then. With 24 px text at 320 px the controls take two rows. If the next change cannot be looked up, a muted line under the sentence says so, with Try again, and while the server is busy it says the step is still being looked up: a step is never left greyed without a word. The steps go to the address's previous and next change, never one block, which would almost always show the same page; at a block before the first transaction the forward step reads "First used at block N", and the notice under the band offers the same, or, when the address's first transaction is further back than this page reads, "Show the address now", so the empty state is never a dead end. After choosing a block, or stepping, focus moves to the band's heading, so it is read out as the page's new subject; after "Back to now", to "As of a block". A block not mined yet says so on the time's line, with "Show block N" for the newest; every notice under the band is the band's width. The totals drop "Unconfirmed"; the balance's line reads "At block N", and a muted line under it says how it stands now ("Now 0.88 223 480 BTC, 10 transactions later"). The history's rows give each transaction's date and time (UTC) instead of an age counted from today. Live, "As of a block" sits quietly at the right end of the live line's row; from 65em it opens the block field over the page, under the button and flush with its right edge, so nothing moves, and on a phone in a sunken well under the row. Either way the field takes focus and has a close button.

A silent payments address (`sp1…`, `tsp1…`) has no balance or history to show, so its page has neither, and no live line:

```text
Address  (Silent payments)
sp1qqgste 7k9hx0qf tg6qmwlk qtwuy6cy …   [copy]
✓ Valid  Silent payments address for Mainnet
┌ Pay this address ──────────────────────────────────┐
│ Copy it into a wallet that supports silent payments│
│ ▸ How silent payments work                         │
└────────────────────────────────────────────────────┘
┌ What the address holds ────────────────────────────┐
│ Network     Mainnet (sp)                           │
│ Version     0                                      │
│ Scan key    0220bcfa c5b99e04 …            [copy]  │
│ Spend key   025cc985 6d6f8375 …            [copy]  │
└────────────────────────────────────────────────────┘
```

One that does not check out says which check failed (checksum, version, length, or a key not on the curve) in a caution notice, in place of both panels.

### Mining (not in the prototype)

```text
Mining                                        [24 h | 1 w | 1 m | 1 y | All]
(network note: signet, testnet4, regtest)
┌ Hashrate  Difficulty  Next adjustment ━━━━┿━  │ Blocks found  Paid to miners  Fees ┐
Hashrate and difficulty ═════ Daily 7-day avg │ Pools ════════ 971 blocks in the last week
[area: hashrate; dashed step: difficulty]     │ [share bar: six pools and the rest]
                                              │ ■ pool  share  blocks  hashrate  match
Blocks over time  [Fees|Fee rates|Size|Match rate|Pool shares]   (eight, then all)
[one chart at a time]                         │ Difficulty adjustments ══ Every 2 016 blocks
                                              │ block (age)  ↑ Up 5.54%  difficulty (six)
Recent blocks ═════════════════════════════════════════════════════════ All blocks
the same mined tiles as the strip, in one row
```

Decided while building it, where the layout above left it open:

- **The period is in the address** (`/mining?period=1m`), so a view can be linked; a week is the default. "All" joins the design's four periods, for the whole of history. The period is a row of links, the current one raised with an accent underline.
- **Charts are drawn in the series colours, never fee colours:** the main series a solid `--series-1` line over a pale area, a second series a dashed `--series-2` line on its own right-hand scale. The one exception is the fee-rate chart, whose axis carries the fee scale as its key.
- **Figures first, in one band.** The network now (hashrate over the last 24 hours on the 24-hour view and over the last 7 days on every other, by time, so a network whose blocks slowed shows its rate now; difficulty with its last change, the next adjustment's expected change over a bar of the retarget period with a tick at the ten-minute pace), a rule, then the period's own (blocks found against the ten-minute target, paid to miners, fees). Three to a row under 80em, two on a phone, where the band and the whole hashrate chart are the first screen.
- **Two columns on a desktop.** Charts on the left (7/12), the lists that explain them on the right (5/12): pools beside the hashrate, adjustments beside the block charts. Under 65em one column, in the order hashrate, pools, block charts, adjustments. Charts are 220 and 200 px tall on a desktop, 170 and 160 on a phone. Recent blocks are one row of ten tiles under both, which a phone scrolls sideways.
- **The pools' share is one bar, at every period,** over the table, which is its key: each row repeats its pool's colour in a swatch. Eight rows, then all of them a press away. Columns are share, blocks, an estimated hashrate (dropped on a phone) and the match rate of the pool's audited blocks; empty blocks are a quiet "N empty" beside a name only when there are some. Where both do not fit side by side the note wraps under the name rather than squeeze it, and it stays inside the pool's column, breaking between the figure and the word, never inside the figure. The pool's column is never narrower than its widest count as drawn, whatever sets the text's size, nor than 6.5em for the name, so where that is too wide the table drops its last columns and then scrolls. The name is what gives way: a long one is cut to one line with an ellipsis, filling the line whatever spaces it has.
- **Pool shares over time are strata,** a tab of the block charts from a month up, since they are counted by the week. Each pool is a layer, the biggest at the bottom, in its pool colour with a seam of the panel between them. The six biggest pools have their own layer and colour and the rest are one, "Other pools", in grey. The layer under the pointer turns the accent.
- **Summaries in magnitude.** Rewards read `2 793 BTC`, the exact amount in the title; how a pool's hashrate and match rate are made sits behind "How these figures are made". Totals cover at most the last 52 560 blocks, about a year, and say so.
- **Hashrate needs a week.** Each daily point averages the 7 days before it, so the 24-hour view draws the last week, and its caption says so.
- **Coverage is drawn, not hidden.** Where the server has not stored the start of the period yet, the chart keeps the whole period's width and hatches the part with no data ("No data stored"), and a note above says "Data from 22 Sep 2026 onward". The same hatch is the note's swatch. A period with nothing stored says so and offers all of history.
- **One readout, no tooltip.** Above each plot a line at a fixed height shows the point under the pointer (the latest otherwise): its time and every figure with its key. It never covers the data, works the same for touch and keys, and never moves the page. On a phone a stacked fee chart reads out its totals only, and the one band under the finger on a line held for it, which says "Tap a layer to name it" until then; every band is in the figures table.
- **The second level is a switch,** not more charts: fees, fee rates, size, match rate and pool shares share one chart slot under "Blocks over time", the switch a segmented row in the panel's head (one row that scrolls sideways on a phone, its far edge faded). Reward per block is not one of them: it is the subsidy plus fees, a nearly flat line, so fees carry the variation and the band the totals. The chart chosen stays chosen for the visit, so coming back from a block a point opened shows the same one.
- **Block health is what was watched,** the "Match rate" tab. Only blocks this server saw arrive have an audit, so a line over the chart says what share of the period's blocks they are and since when, hatches the time before the first and breaks wherever a block has none. The area stands on an axis from zero, so a bad block is a notch down from the top and an ordinary period a full band; past 1,000 blocks a point is the lowest of its run, so a bad block is never averaged away. A point opens its block: a click, a second tap, or Enter.
- **Past adjustments are a list, not a period's.** The latest six, newest first, each block's age under its height, each row opening the block that began its period, with all of them a press away; the next one is a figure in the band. Ups and downs read as an arrow and a word, never a colour.
- **Unknown is a pool.** It is ranked like any other, its page exists, and "How these figures are made" says it is the blocks no tag or address on the list names.
- **Test networks say what their figures mean.** Signet's blocks come from a few signers the list does not name; testnet4's minimum-difficulty rule makes its hashrate swing; regtest has no pools, a meaningless hashrate and no retargets; Testnet 5's figures read as mainnet's, so it has no note. A note under the title says so, and figures that mean nothing there say "Not meaningful on regtest".
- **A pool's page** has its name as the title (dataset text), its site as a plain link only when it is `http` or `https`, its blocks and shares, its weekly share and hashrate, and its blocks 25 at a time.
- **Nothing moves as it loads.** Each section holds the height its content will take; the coverage notes on a pool's page sit below its figures.

### Mempool history (not in the prototype)

```text
Mempool history  21% recorded, from 12 Nov, 11:14 UTC.   [2 h | 24 h | 1 w | … | 4 y | All]
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Waiting now      │ Change          │ Arriving              │ Next block reaches      │
│ 32.67 MvB        │ −793.87 kvB     │ 1 244 vB/s            │ 2 sat/vB                │
│ 78 902 txs       │ peak 34.66 MvB  │ blocks took 1 217 vB/s│ the dearest 1 MvB, now  │
│──────────────────────────────────────────────────────────────────────────────────────│
│ [stacked fee layers, cheapest at the bottom]             ┆ 17 Nov, 01:00 UTC         │
│                                                          ┆ 32.67 MvB                 │
│                                                          ┆ 78 902 tx, from 0.10      │
│ Flow, vB/s: arrived and left                             ┆ By fee rate  [From 0.15 up]│
│ [line: arrived; shades: mined, left otherwise]           ┆ ■ 10+        16.46 kvB    │
│ one time axis                                            ┆ …  ■ Arrived  862 vB/s    │
└──────────────────────────────────────────────────────────────────────────────────────┘
> How these figures are made
> Show the figures
Recent replacements ═════════════════════════════════════════════════ All replacements
```

- **One panel answers.** Four figures across its top, the plot under them. They are what the record can honestly say: what waits now and in how many transactions; how that changed over the period, with its peak; what arrived against what blocks took; and the rate the dearest block's worth now reaches down to ("Next block reaches", the cheapest band the dearest 1 MvB waiting reaches into). The record keeps no block's lowest rate, so it never claims one.
- **The mempool is the core sample laid on its side,** as pool shares are, but its layers are fee bands, so here they take the fee colors: color still carries fee and nothing else. No total line: the top of the stack is the total. The layer under the pointer keeps its colour and takes an outline in the text colour while the others fade; the accent is never drawn in a plot.
- **Size and flow share one time axis and one crosshair,** the size above, the flow below in its own strip and units (vB a second): a line for what arrived over shades for what blocks mined and what left otherwise, so where the line sits against the shades says filling or draining. A minute holds one block or none, so under ten-minute steps the flow reads in ten-minute means; coarser steps are drawn as recorded.
- **The key is the readout and the filter.** Beside the plot on a desktop, under it on a phone, it names each band with its figure at the crosshair (the latest point until the pointer, a finger or the keys move it), under the crosshair's time, total, count and lowest accepted rate, and the flow's three figures after it. A band pressed shows it and every dearer band on their own scale, the rest drawn as empty swatches; "From 0.15 up" offers the band above where nine tenths of the latest point lie, worked out from the data, so the block-by-block clearing over a cheap slab shows in one press. "Show all" undoes it. The rows keep their place, so nothing moves as the crosshair does.
- **Explanations are a second layer.** "How these figures are made" holds one short line each for the layers, the flow and "Next block reaches"; "Show the figures" opens every point as a table. Both sit under the panel, so opening them never changes it.
- **Honest about coverage,** as the mining charts are: a break wherever a step was not sampled (a lone minute is a sliver), and one muted line beside the title saying how many of the period's minutes are here and since when.
- **Opens on what is recorded, and says so in its choices.** With no period in the address, a view whose records begin inside it starts where they do, under one line ("Recorded since …"), and the period choices gain "Recorded", marked as the current one: a period's name always means its whole width, so choosing "24 h" shows the whole day, the time before the records hatched ("No data stored") across both strips, the line beside the title keyed with the same hatch.
- **A few missing minutes are bridged.** Up to five missing steps are drawn across rather than as thin stripes that look like faults; a longer pause in recording breaks the line, and the figures table lists only what was stored.
- **A phone's time axis names its ends:** too narrow for ticks a reader can place, a plot under 420 px labels its first and last moment instead ("9 Nov", "12 Nov"; "12 Nov 11:14", "20:35").
- **The intervals are one row** on a phone, under the title, scrolling sideways with their far edge faded and the chosen one in sight; the coverage is one short line under them ("49% recorded, from 12 Nov, 11:14 UTC.", the year said only when it is not this one), the figures two by two, and both strips and their time axis end on the first screen. The key's bands are three to a row of 44 px targets.
- **Live.** The page asks again just after each new minute is stored; the crosshair holds the moment it was put on.

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
- **Where it sits.** The header's Mempool is current on `/rbf`, which has a "← Mempool history" link above its title; the mempool's own pages are two, so they get no row of tabs (on a phone it would push the history chart off the first screen). The recent replacements panel, the newest five, is the home page's last panel, below everything the council placed, and the foot of `/mempool`, under its panel: the way to `/rbf` from both. On the narrowest phones its row gives way before its status does: the id's header reads "Tx", the id shortens, and the rate it rose to goes under the one it rose from, so "Not mined" is always whole.

### Fee track record (not in the prototype)

```text
Fee track record                                          [24 h | 1 w | 1 m | All]
How often this server's recommended fees … were mined in time, against an 85% target.
┌ Mined in time ──────────────────────────────────────── ┊ 85% target ▬ 95% interval ┐
│ No rush       75.2%                       0% [·····▐█▌··┊····] 100%  × Below target │
│ within a day  mined within the next 144                71.6–78.8%                  │
│ Low …                                                              ✓ Meets target │
│ These figures cover 14 Nov 2026, 13:16 to 21 Nov 2026, 13:16 UTC.                 │
└───────────────────────────────────────────────────────────────────────────────────┘
┌ What it cost ───────────────────────┐ ┌ What the figures rest on ─────────────────┐
│ level, recommended (median), over-  │ │ level, answers judged, blocks, left out    │
│ paid (mean · median), short (mean)  │ │ (total, each kind not zero named under it) │
└─────────────────────────────────────┘ └────────────────────────────────────────────┘
> How the score is kept
```

- **The evidence is the page.** It exists so a reader can check the home page's numbers, misses included: on mainnet a level under its target says "Below target" in the negative colour with a cross, never softened; one at or over it "Meets target" in the positive colour with a tick. Too few blocks is muted, with a dashed circle and no figure.
- **A test network is not a fair test.** Its blocks have room, and against a block with room an answer at the minimum reads as a miss, so there a share under the target says "Not a fair test here", muted with the dashed circle, the share mark in the text colour; the share, its interval and every table figure stay. One note under the rows, in the panel of the verdicts, says why. Red is kept for a real miss.
- **One drawing, the meter:** 0 to 100% on a sunken track, the 95% interval a band in `--color-line-strong` with its two ends written under it (the label centred on the band and slid to stay inside the line, so the resolution a 0 to 100 scale hides is readable), the share a mark in the verdict's colour, and the target a dashed line in the text colour from just above the track to its lower edge, so it never reaches the written interval under it. A key beside the panel's title names the dashed line and the band once, each swatch kept on the line of its words. It repeats the figures beside it, so it is hidden from screen readers. A level without a share keeps the track, dashed, with only the target.
- **Rows, not cards:** the four levels are rows of one panel, slowest first as the home panel lists them. On a desktop the name, the share, the meter and the verdict are one line. On a phone each level is two lines and its meter: the name over its window at the left, the share over its verdict at the right, then the line with the interval's ends beside it (the key says the lines run 0 to 100%), so the four levels are on a 360 × 780 first screen. Every row's line starts and ends at the same x at every width, whatever the row holds (a share or none, a short or a wide interval): the column before it is fixed, and the interval's ends have one reserved width, the widest they can be, so the target is one vertical line down the panel. The sentence on how sure a verdict is is read aloud always and shown only when it adds to the drawing: the interval reaches across the target, or there is no share yet. The counts behind each level are in the last table only.
- **Two tables side by side,** each in its own panel, wherever both hold their columns whole (`30rem` each, so larger text stacks them): what it cost and what the figures rest on. "Overpaid" is read against the median rate the level recommended, in the first figure column, since 1 sat/vB overpaid is double at the minimum and nothing at 50. Its mean and median share a column, side by side on a wide screen and on a phone one above the other in every row, so the medians are always the second line. What was left out is one column, its total and each kind that is not zero named under it, so no kind is dropped at any width. One sentence under each table; the definitions of the kinds left out, and the method, are behind "How the score is kept". Where a table does not fit its panel (a phone at large text, or signet's costs at 320 px), it is not scrolled: each level becomes a labelled group, its name over its figures, each figure beside its column's words. Whether it fits is measured, not guessed from the width, so it holds at any text size and in any font. Every layout of the rows follows one ruler, the levels' panel's width in its own text, so the rows hold at any text size, set by the page or by the browser, and no two layouts mix. Past 63em, where the desktop's four columns still leave the line a third of its row in a wide font too, a level is one row of four columns (about 1150 px and wider at default text; at exactly 63em it is still the layout below); from 35em it is its name and verdict, then its share beside its line, as on a tablet (from 640 px at default text, 960 px at 24 px, 1280 px at 32 px); under 35em it is a phone's, the share over its verdict and the line under both; and under 12em (under 390 px at 24 px text, 520 px at 32 px) each level's name, share, verdict and line stack in one column, so none of them wraps apart, the line the panel's full width with the interval's ends under it. Every line has a real width at every size, at least a third of its row.
- **The periods** sit at the right of the title where they fit, and wrapped under it they start at its left edge. Where the header is under 14em of its own text (a phone at 24 px text and larger) this page's four periods are a little narrower, each still a thumb's width, so all four show with no fade over the last; at 32 px they wrap rather than scroll. The shared `Periods` component is unchanged.

### Lightning (not in the prototype)

```text
Lightning  As of 12 Nov, 18:30 UTC                               [24 h | 1 w | 1 m]
┌ Channels │ Nodes │ Capacity │ Median channel │ Median fee rate │ Median base fee ┐
│ each a button: value, ↓ 54, a sparkline of the period; the pressed one is charted │
│ Nodes reached by [clearnet │ both │ Tor │ no address]                    More ▸     │
└──────────────────────────────────────────────────────────────────────────────────┘
<figure>, over time ════════════════ │ Closes by kind ══════════ Each day, UTC
[line: the pressed figure; its mean   │ [a bar a day, its kinds stacked]
 in the readout for a median]         │ since …: 9 cooperative, 1 force · Penalties
As it happens ══════ ● Live [Pause]   │ Movers ═══════ Net change, the last week
[All | Opens | Closes | Fee changes]  │ [Capacity | Channels] [Gained | Lost | Either way]
kind     node ↔ node    capacity      │ node, change, now
channel                 when          │   (the feed fills the movers' height)
Largest │ Most connected │ Newest nodes │ Nodes that left   (five rows each; a phone: one, picked)
Node page: name (text, cut), key grouped with copy, "the key is the identity";
  figures; its past │ its fee rates (two bars a row: it charges, its peers charge); addresses and features as chips; channels, open | closed, 25 a page
Channel page: id, its state as an icon and a word, the two nodes, capacity, age, the id in three forms;
  closed: how it ended (kind, block, closing transaction and fee; penalty sweep; "Continued as");
  open: who charges what (a lane each way) │ fee for this hop (an amount, the fee each way) │
        policies side by side, with their difference; then the life of the channel
```

Decided while building it:

- **The order answers the visit, for an operator, and uses the width:** the totals with their change over the period, then the network over time beside how channels closed, what is happening now beside who moved, then four five-row lists (largest, most connected, newest, left; the first two with their "Top 100"). Panels that belong together sit side by side on a wide screen and stack below 65em; on a phone the four lists share one panel behind a picker, and the title and period share the first line, so all six figures with their change and trend are on a 390 px first screen. Every Lightning page has the short Overview and Rankings row; a node or channel leads back to the list the reader came from.
- **Each figure is the chart's choice.** Pressing one draws it below (`?figure=`, kept across periods), so the chart can show the fee rate or the channel size, not only channels; a median's mean is in the readout. A figure's change reads `↓ 54` (the word is for screen readers); where the record is shorter than the period it runs from the record's first point, and one line says so once. Its sparkline spans the period, hatched before the record. "Nodes reached by" is one share bar in the series colours.
- **The feed is calm,** and has no running counts. Batches come at most every 30 s (about 23 fee changes a minute on mainnet, under one open): each lands at once with one flash, never row by row, and a burst says how many it left out. Opens and closes stay a press away in its kind picker when fee changes flood it. It pauses for its button, a pointer or focus in it, and starts paused under reduced motion. A close's kind is its tag: a penalty in the negative tone, a force close in `--ln-caution`. The same tones colour the bars of closes by kind; cooperative and other closes are neutrals.
- **What is ours is said, not hidden.** Under the figures, one line says only channels checked against the chain are counted; how, and what the fee figures leave out, is behind "How these figures are made". History starts when this server's peer first synced: the chart hatches the time before it and says since when; closes by kind start at the first recorded day (a week at least), so a young record fills the width instead of hatching it. The closed lists say they hold closes seen since then.
- **A close says how sure it is,** beside its kind: "Force close · Certain", "Cooperative close · Likely" (a splice that only takes funds out looks the same), "Penalty · Certain", "Other · Certain it is not a plain close". Lists give the kind in one word; the channel page gives the reason.
- **Charts are drawn in the series colours,** as the mining charts are: the main series an area or a line, a second a dashed line on its own scale. Capacity in the figures reads in magnitude (`3 199 BTC`).
- **Names are claims.** A node's name is text, cut short in lists and titles with the rest one press away, and isolated so its direction cannot run into the text beside it; its public key is always next to it. A node's announced colour appears once, in its Identity section, as a small swatch beside its `#rrggbb` value, a claim like its name; nowhere else does it colour anything.
- **The node page is for its operator.** Its name and short key, its capacity and open channels each with its rank, and when a policy on its channels last changed; then one view at a time, chosen by tabs in the address: Channels (a table on a wide screen, sortable by every figure; on a phone three-line cards, with a sort picker), Closed, Fees ("In figures", then the histogram, whose bars open the channels they count) and History. Under the views, the node at a glance (each figure's change over 7 days once the record is that old), then its Identity. While the reader sorts, filters or pages, the list holds its rows until the new ones arrive. A row's state says what gossip says: "Enabled" (both ends), "Disabled by this node", "Disabled by the peer", or, where a policy is missing, whose ("Peer policy missing"), never "Disabled"; the state chips count the server's four states, an end "off" when its policy is disabled or missing.
- **A node's close record is a record, not a verdict.** Its kinds keep their icon and word in the muted tone, never `--ln-caution` or the negative red: a tally of a node's force closes in warning colours would read as judging its operator, and a force close is in both its nodes' records. Its words say what the chain shows ("one end broadcast a commitment transaction; the chain does not say which end"). Its one drawing is a pair of share bars a kind, this node's in `--series-1` over every channel's in `--series-3`, only from the minimum of closes for a share; below it every channel's share is words, since a lone grey bar beside a node's count reads as the node's. The bars repeat the figures beside them, so screen readers skip them. No score, rank or colour sums it up, and no ratio to every channel's either: "0.02× all channels" reads as a grade. It is laid out so its list starts early: how it ended as wide as it needs, one line a kind with its words, its count and both shares, then the fees on the left beside the weeks over with whom on the right, with whom a sentence over the peers that repeat, every peer shown as cards across the record's width; the count in the opening sentence leads to the list; on a phone the weeks and with whom are folded to their sentences, since the list is what the view is named for; under the minimum of closes the whole record is a line beside every channel's shares, its tables a press away, and with no close it is one sentence and the closed list below it is not shown. A node with only closed channels is headed by its key, and the closed list follows its record, as its heading says. Nothing on a phone says what it left out: a figure without room for its column is a second line of its row.
- **Tables fit a 320 px phone,** and every column keeps a gutter at every width. A chart's figures do too, with no sideways scroll: a time takes two lines (the day, then the time of day, with "UTC" in the header), and a node's fee figures are one table each way, headed with the chart's own words, side by side only where the panel holds both whole and one over the other otherwise. Long headers take two lines and fee-rate ranges break before their upper end wherever room runs short, at any width. A channel row puts its id, kind, time and both ends in one cell; a node list drops, on a phone, the figure it is not ranked by.
- **The channel page is for the operators at its ends.** Each direction is drawn as a lane, coloured `--series-1` and `--series-2` across the lanes, the calculator and nothing else, saying in words which end charges what. What gossip says is said as advertised: "Enabled" is not "routable", and a missing policy reads "No policy", never "Disabled", which is only an advertised disabled flag. A closed channel has no policy to show, so it shows how it ended and its life, not empty drawings; one with no policy either way shows its lanes and no calculator or table. "Continued as" a new channel is inferred from the closing transaction, and said so. A figure is exact and one piece at every text size: never broken inside its digits (its groups are joined by no-break spaces) nor parted from its unit, except a long one where its room is too narrow, the line breaking between figures ("1 ppm" + "1 sat"); a channel's msat terms read as sats exact to the msat at any size (`20 000 000 sats`, `1.001 sats`), the msat in their title; at the largest sizes (below 15em: 320 or 390 px at 200% text) the page's gutters and panel padding halve, the display figures stop growing past the text round them, and a figure longer than 12 characters (an msat term, the capacity) may break before its unit, never inside its digits and never rounded; so may one in a hop fee's well narrower than 22em of its own text, at any size; so each fits whole in any reader's fonts. A name breaks anywhere, or is cut with its whole in the title. On a phone each policy term is a row over its two values, under the two ends' names; below 22.5em (a 320 px phone, or larger text) the values go one a line, each named for its node.
- **Switched off is a sentence,** not an empty chart: a network without Lightning says so, and a peer still syncing shows how far it has come and fills the page when done.

### Broadcast (not in the prototype)

```text
Broadcast a transaction
[Paste a signed transaction in hex                          ]
37d0355b…f83b66c6 [copy]
┌ summary: Fee · Amount · Size ────────────────────────────────────┐
└──────────────────────────────────────────────────────────────────┘
[notice, caution: Check before you send — what is wrong, one line each]
[notice, neutral: Once it is sent, anyone can read this from it — findings, then
 "It is not sent yet: a wallet can still change which coins it spends and where the change goes."]
[Broadcast]  or  [Broadcast anyway]  or  ✓ Sent: follow it on its page
┌ Inputs and outputs (the transaction page's flow) ────────────────┐
└──────────────────────────────────────────────────────────────────┘
```

It is read as soon as it is pasted, so the answer comes before the button: what it pays and where its coins go. The button is the accent only when nothing needs a second thought; with a warning it is outlined and reads "Broadcast anyway". A transaction the node already has gets a positive notice and a link instead of a button. Before the button, a neutral notice (the strong line colour on its left edge, never the caution's) says what an observer could read once it is sent: the transaction page's findings, coins spent together too, the same marks on the cards, and the closing line that a wallet can still change which coins it spends and where the change goes. Coins spent together carries "Shown only before sending" after its title, muted, since the transaction page never shows it. At 65em and up the findings sit two across, each at a reading measure. The output cards say nothing about being spent and keep no room for it: the outputs of a transaction the node does not have exist nowhere yet. They are readings, not faults, so the button stays as it is. With nothing to report the notice is still whole and quiet. Once Broadcast has been pressed, whatever came back, it says what the transaction page says and nothing about whether it was sent; only a transaction never pressed is "not sent yet". The decoder shows the same for pasted hex, its link to Broadcast after the notice. On a phone the fee and the size share a row and the amount has its own, as on the transaction page.

### Timestamp proofs (not in the prototype)

```text
Check a timestamp
What a proof shows, in one sentence. Your file is read here and never sent.
┌ Proof ─ ─ ─ [Choose a file] ┐ ┌ Your file ─ [Choose a file] ┐   empty: dashed
  The .ots file · or drop it here  Hashed here, never uploaded · or drop it here
Or its SHA-256, in hex, instead of the file       64 characters, 0 to 9 and a to f
[6fd9c1c4f096b77e6d4457bac1c7f51010d318db483f2868d3795843f098d378               ] (×)
┌ Proof            [Change] (×) ┐ ┌ Your file      [Choose a file] ┐   every state: two lines,
  two-blocks.ots  1 768 B           The digest below stands in for it    the same height
┌ (✓ Verified) ─────────────────────────────────────────────┐
│ This digest is committed to by block 449 397               │
│ Its header time                                            │
│ 21 Jan 2017, 23:47:07 UTC                                  │
│ 3 590 days ago                                             │
│ The header time is the miner's claim: … (one sentence)     │
│ What it proves and what it does not                        │
│ Also in this proof: block 449 399 (a link), calendars      │
│ > Show the 47 steps from the digest to the block           │
└────────────────────────────────────────────────────────────┘
```

The two inputs are drawn as the site draws what has not settled: a dashed outline while empty, solid once each holds its file (or, for "Your file", once a digest stands in for it), as a projected tile sets when mined. Every slot is the same lines in every state, so the two are always one height side by side (stacked, each is as tall as it holds, with no blank to fill): its label with its controls together at the right ("Choose a file", or "Change" and remove), which never shrink; then across the whole card what it takes ("The .ots file", "Hashed here, never uploaded", "The digest below stands in for it") or the file it holds, its name cut with an ellipsis only when it cannot fit (whole in its title) and its size never. Where the label and the controls do not fit side by side (a phone at large text), the controls go together onto the next line at the right; the label never shrinks under its words, and "Choose a file" wraps rather than leave the card at the largest text. Both slots' last control ends at the same inset. Remove is 44 px each way, as tall as Change beside it. "· or drop it here" ends the hint only where a pointer can drop and the card is wide enough to keep it one line (50em and up); the slot takes a drop either way. The verdict is on the first screen at 1280 × 900 and starts within a 360 × 780 one. The digest field sits under both slots, the full width, so neither card has an empty foot: a monospace field that shows all 64 characters at once where the window and the browser allow (where it needs more than the field's three rows and the browser has no `field-sizing`, or more than the window allows, as at 320 × 568 with 32 px text, a valid digest scrolls inside it) and wraps them on a phone (three lines there at least), never taller than ten lines or 70% of the window, whichever is less, so a wrong paste scrolls inside it with its clear control and message on screen, with what it takes said beside its label and a 44 px clear control once it holds anything.

The introduction is one sentence on what a proof shows and one that the file never leaves the browser; how the proof is followed, and what is asked of the server, is said inside "Show the steps".

The verdict is the answer: a status pill with an icon and a word (positive Verified, caution Pending or Not checked, negative for a different file or a proof that does not verify), then the sentence that says it as the page title's size. When a verdict comes, its heading takes focus and it is scrolled into view, or it is said in a live region and nothing moves, by the rule in [`FRONTEND.md`](FRONTEND.md#timestamp-proofs) ("When a verdict may move the reader"). The headline names the block, the proven fact, as a link. Under it, one figure in the summary style: the block's header time with its age in days, readable at a glance; then the one sentence that the time is the miner's claim and what a node checks of it, then the paragraph on what a timestamp does and does not prove, which says "this block" rather than give the height a third time. Every block named under "Also in this proof" that this node has is a link.

The steps are a core drawn down the page: one line from the file's digest at the top to the block's merkle root at the bottom, a small square at each step, larger ones at the two ends. Values are shortened, each kept whole on one line; "Show the values in full" (a toggle button, pressed state) writes every one out in monospace, wrapping, so no value needs a hover or a long press. On a phone each step's operation is its own line and each value its own. The two inputs sit side by side above 40em; stacked on a phone.

### Ark (not in the prototype)

```text
Ark                              (the entry: one box, whatever is pasted; no tabs)
[VTXO ID, hex or Ark address] [Open]
Not a VTXO or an Ark address     (only after Open, only when it opens nothing)

← Another VTXO
VTXO Bark  (Signatures OK) (Not settled yet) (Expires soon) (Exiting)
125985e9 e2bfa047 … 594b7567:0  [copy]
Amount 0.00010000 BTC / 10 000 sats │ Expires 1 210 blocks left / Block 101 010 / ▬▬▬── │ Exit 5 transactions / 3 tree, 2 transfers
Exit path ════════════════════════════════════════════════════════════════ [Play exit]
   ◦ 20 000 sats ╲ 2 ─ 3 ⌒ 4 ⌒ ◎ This VTXO 10 000 sats (then wait 2 016 blocks)
                  1
  ···■ Anchor 96 970 ··········· ▾ 1 210 blocks left ··········· | Expiry 101 010   (the Bitcoin line)
  key: exit transaction, other output, transfer;  a selected node's facts under it
Details (closed): server key, user key, policy, wait after exit, encoding, anchor
Transactions: # · Kind (Bark's word muted) · On chain · Signature · Other outputs · Fee · Txid
```

Decided while building it, with the owner:

- **Very little text.** The picture, the layout and short labels carry it: no helper paragraphs, nothing decorative. States are a short sentence each: not a VTXO ID, Bark does not know this VTXO, the Bark server did not answer, its answer did not check out. A VTXO from its hex (`/ark/bark/hex#…`) is the same page, with no word that it came from hex (the checks and the picture do not change); its states are no VTXO hex, not VTXO hex, this hex is not a Bark VTXO, this VTXO did not check out.
- **The visitor never picks an implementation.** The entry is a box, a placeholder naming what it takes and Open; no list of formats. What was pasted decides the page ([`ARK.md`](ARK.md#the-entry-page)); a `txid:vout` passes through a short "Asking Bark and Arkade" and lands on the page of the one that knows it.
- **Badges, not sentences,** in the order a reader needs them: "Signatures OK" only when the server rebuilt the whole chain, found the anchor on the node, found the expiry bound to it and verified every signature ("Not all signed" or "Not verified" otherwise); "Not settled yet" when the chain has arkoor transfers; "Expires soon" within three days of blocks; "Exiting" once an exit transaction is in the mempool or a block. Never "unspent": that cannot be known ([`ARK.md`](ARK.md#where-the-vtxo-comes-from)).
- **The Bitcoin line is the VTXO's life:** the anchor's block at the anchor, "now" with the blocks left, the expiry at the far end, to scale. The tree's transactions rise from the anchor; transfers run sideways as low arcs and wrap into rows, each above the last, as many to a row as the width holds; other outputs are dashed stubs with their amount where there is room. The VTXO is a ring at the end with its amount; its words go above it near the right edge, so they never fall on the tree.
- **Play exit** lights the transactions in broadcast order, one per `--dur-slow`, then shows the wait the exit delta imposes. Every node is a button with a 44 px target that selects its transaction; its facts show under the picture.
- **Two exceptions to the principles, approved by the owner for the Ark exit pictures alone.** (a) Quiet idle motion: the VTXO's ring breathes, opacity only, slowly (principle 6 otherwise forbids ambient motion). Reduced motion stops it, and Play exit then shows its end at once, so the picture is still. (b) The accent marks the VTXO's own path, its transactions and its ring (principle 3 otherwise keeps it for interaction); everything else in the picture stays neutral.

The Arkade VTXO page, `/ark/arkade/vtxo/<txid>:<vout>`, shares the entry, the back link, the figures and Play exit; its picture is the whole batch tree:

```text
VTXO  Arkade  (✓ Unspent) (◌ Not settled yet)
d922b2c3 811ec22a …  e79773fc:0  [copy]
┌ Amount ─────────┬ Expires ───────────┬ Exit ─────────────────────┐
│ 0.00001000 BTC  │ 21 days left       │ 10 transactions           │
│ 1 000 sats      │ 7 Dec 2026 ▬▬──    │ 8 tree, 1 checkpoint, …   │
└─────────────────┴────────────────────┴───────────────────────────┘
┌ Exit path ─────────────────────────────────────────── [Play exit] ┐
│                         ◎ This VTXO                               │
│ ⋮⋮⋮⋮⋮⋮⋮⋮⋮⋮⋮⋮⋮⋮ the batch's leaves ⋮⋮⋮⋮⋮ ● checkpoint             │
│      quiet ink, this VTXO's branch in the accent                  │
│ ·····■ Commitment ·········▾ 21 days left ··········| Expiry ····· │
└───────────────────────────────────────────────────────────────────┘
Details (folded) · Transactions, in broadcast order
```

- **Arkade's badges are arkd's own words:** Unspent, Spent or Swept, and Not settled yet (dashed) while it is preconfirmed; Exiting when its exit is on our chain; Expires soon inside a week. Nothing on the page says arkd's claims were checked: they were not ([`ARK.md`](ARK.md#arkade)).
- **The tree in quiet ink, this VTXO's branch in the accent,** its checkpoints and transfer above the leaves; the line under it is the Bitcoin chain and the VTXO's lifetime, commitment to expiry. A swept VTXO's path is dashed in the muted ink, not the accent. A transaction already on chain turns the positive green, in the picture and the table alike. The halo is the breathing exception above.

The Arkade address page, `/ark/arkade/address/<address>`, lists what arkd says the address holds:

```text
← Ark
Address  Arkade
tark1qz9 l2ctqalr kjyftxcw …   [copy]
┌ VTXOs ──────────────┬ Spendable on this page ─┐
│ 25 on this page     │ 0.00003000 BTC          │
└─────────────────────┴─────────────────────────┘
VTXO (to its page)   Amount, BTC   Status                      Expires
5362156e… :0         0.00001000    ✓ Unspent ◌ Not settled yet 7 Dec 2026
[Previous]                 Page 1 of 11                 [Next]
```

- **The figures count this page only,** and say so when there are more; one page's figures are exact. Status is the VTXO page's words and icons. Its states are a few words each: not an Arkade address, a Bark address (its VTXOs cannot be listed), an unknown Ark address version, an address for another network, another Arkade server's, no VTXOs.

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
