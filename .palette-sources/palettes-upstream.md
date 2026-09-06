# Upstream palette values, fetched from source (all MIT)

Fetched 2026-09-02 from the projects' own repositories, not from any
reimplementation.

## Dracula — dracula/dracula-theme, MIT
README section is titled "Color Palette (OSS)" and contains BOTH variants,
so Alucard is open source and not PRO-only.

### Dracula (dark)
Background #282a36 · Current Line #44475a · Selection #44475a
Foreground #f8f8f2 · Comment #6272a4
Cyan #8be9fd · Green #50fa7b · Orange #ffb86c · Pink #ff79c6
Purple #bd93f9 · Red #ff5555 · Yellow #f1fa8c

### Alucard (light)
Background #fffbeb · Current Line #6c664b · Selection #cfcfde
Foreground #1f1f1f · Comment #6c664b
Cyan #036a96 · Green #14710a · Orange #a34d14 · Pink #a3144d
Purple #644ac9 · Red #cb3a2a · Yellow #846e15

## Gruvbox — morhetz/gruvbox, MIT
dark0_hard #1d2021 · dark0 #282828 · dark0_soft #32302f · dark1 #3c3836
dark2 #504945 · dark3 #665c54 · dark4 #7c6f64 · gray #928374
light0_hard #f9f5d7 · light0 #fbf1c7 · light0_soft #f2e5bc · light1 #ebdbb2
light2 #d5c4a1 · light3 #bdae93 · light4 #a89984
bright: red #fb4934 green #b8bb26 yellow #fabd2f blue #83a598 purple #d3869b aqua #8ec07c orange #fe8019
neutral: red #cc241d green #98971a yellow #d79921 blue #458588 purple #b16286 aqua #689d6a orange #d65d0e
faded:  red #9d0006 green #79740e yellow #b57614 blue #076678 purple #8f3f71 aqua #427b58 orange #af3a03

## Rosé Pine — rose-pine/palette, MIT (palette.json)
### main (dark)
base #191724 surface #1f1d2e overlay #26233a muted #6e6a86 subtle #908caa text #e0def4
love #eb6f92 gold #f6c177 rose #ebbcba pine #31748f foam #9ccfd8 iris #c4a7e7
### dawn (light)
base #faf4ed surface #fffaf3 overlay #f2e9e1 muted #9893a5 subtle #797593 text #464261
love #b4637a gold #ea9d34 rose #d7827e pine #286983 foam #56949f iris #907aa9

## Tokyo Night — enkia/tokyo-night-vscode-theme, MIT
### Night (dark)
bg #1a1b26 · bg_dark #16161e · fg #a9b1d6 · line numbers #363b54 · border #101014
selection #202330 · link #6183bb
accents: purple #bb9af7 · text-bright #c0caf5 · red #f7768e · cyan #0db9d7
blue #7aa2f7 · light-cyan #7dcfff · yellow #e0af68 · teal #73daca · green #9ece6a
### Day (light)
bg #e6e7ed · bg_dark #d6d8df · fg #343b59 · line numbers #9da0ab · border #c1c2c7
link #2959aa
accents: purple #65359d · red #8c4351 · cyan #006c86 · blue #2959aa
yellow #8f5e15 · teal #33635c · green #385f0d

---

Fetched 2026-09-06 from the projects' own repositories, same rule as above.
Where a project publishes fewer background tiers than ihasmail needs, the
missing one is derived and marked **derived** here rather than passed off as
upstream. Body text is lifted to 7:1 by the build script for most of these —
they target their own ~4.5:1 — and every shift is printed in the generated CSS.

## Catppuccin — catppuccin/palette, MIT (palette.json)
Cited from the palette repo rather than the hub README; it is the normative
machine-readable source.

### Mocha (dark)
base #1e1e2e · mantle #181825 · crust #11111b · surface0 #313244 · surface1 #45475a
text #cdd6f4 · subtext0 #a6adc8 · overlay1 #7f849c
mauve #cba6f7 · blue #89b4fa · red #f38ba8 · peach #fab387 · green #a6e3a1
yellow #f9e2af · pink #f5c2e7

### Latte (light)
base #eff1f5 · mantle #e6e9ef · crust #dce0e8 · surface0 #ccd0da · surface1 #bcc0cc
text #4c4f69 · subtext0 #6c6f85
mauve #8839ef · blue #1e66f5 · red #d20f39 · peach #fe640b · green #40a02b
yellow #df8e1d · pink #ea76cb

Latte publishes no tier lighter than `base`, so `base` is used as the elevated
surface and `mantle` as the page behind it.

## Solarized — altercation/solarized, MIT (README "The Values")
base03 #002b36 · base02 #073642 · base01 #586e75 · base00 #657b83
base0 #839496 · base1 #93a1a1 · base2 #eee8d5 · base3 #fdf6e3
yellow #b58900 · orange #cb4b16 · red #dc322f · magenta #d33682
violet #6c71c4 · blue #268bd2 · cyan #2aa198 · green #859900

The accents are shared by both modes by design. Two tiers are **derived**: the
sunken dark surface #001f28 (below base03) and the raised light surface
#fffdf6 (above base3), neither of which Solarized publishes, plus the two
rule colours #0d4552 and #e6dfc8.

## Everforest — sainnhe/everforest, MIT (palette.md), medium contrast
### Dark
bg_dim #232a2e · bg0 #2d353b · bg1 #343f44 · bg3 #475258
fg #d3c6aa · grey1 #859289
red #e67e80 · orange #e69875 · yellow #dbbc7f · green #a7c080 · aqua #83c092
blue #7fbbb3 · purple #d699b6

### Light
bg_dim #efebd4 · bg0 #fdf6e3 · bg3 #e6e2cc · bg5 #bdc3af
fg #5c6a72 · grey1 #939f91
red #f85552 · orange #f57d26 · yellow #dfa000 · green #8da101 · aqua #35a77c
blue #3a94c5 · purple #df69ba

Light uses bg_dim as the page and bg0 as the raised surface, so the card the
reader looks at is the colour Everforest calls its background.

## Kanagawa — rebelot/kanagawa.nvim, MIT (lua/kanagawa/colors.lua)
### Wave (dark)
sumiInk0 #16161D · sumiInk3 #1F1F28 · sumiInk4 #2A2A37 · sumiInk5 #363646
fujiWhite #DCD7BA · fujiGray #727169
crystalBlue #7E9CD8 · springBlue #7FB4CA · samuraiRed #E82424 · roninYellow #FF9E3B
springGreen #98BB6C · carpYellow #E6C384 · sakuraPink #D27E99

### Lotus (light)
lotusWhite0 #d5cea3 · lotusWhite1 #dcd5ac · lotusWhite2 #e5ddb0 · lotusWhite3 #f2ecbc
lotusInk1 #545464 · lotusGray2 #716e61
lotusViolet4 #624c83 · lotusBlue4 #4d699b · lotusRed #c84053 · lotusOrange #cc6d00
lotusGreen #6f894e · lotusYellow #77713f · lotusPink #b35b79

## Ayu — ayu-theme/ayu-colors, MIT (themes/dark.yaml, themes/light.yaml)
The YAMLs give the base palette and the surfaces as literals but express syntax
roles as references (`$palette.indigo.l2`), and the resolved files are not
committed. The two signature accents are taken from the same organisation's
MIT-licensed ayu-theme/vscode-ayu build.

### Dark
surface base #0D1017 · lift #10141C (sunk is `base -L0.1`, **derived** here as #070a0f)
ui line #1B1F29 · ui fg #5A6378 · editor fg #BFBDB6
red #F07178 · orange #FF8F40 · yellow #FFB454 · green #AAD94C · teal #95E6CB
indigo #39BAE6 · blue #59C2FF · purple #D2A6FF · accent #E6B450 (vscode-ayu)

### Light
surface sunk #EBEEF0 · base #F8F9FA · lift #FCFCFC
ui fg #828E9F · editor fg #5C6166 · rule #dfe2e5 (**derived**)
red #F07171 · orange #FA8532 · yellow #EBA400 · green #86B300 · teal #4CBF99
indigo #55B4D4 · blue #22A4E6 · purple #A37ACC · accent #F29718 (vscode-ayu)

## Primer — primer/primitives, MIT (src/tokens/base/color/{dark,light})
Named "Primer" after the design system. The colour values are MIT; "GitHub"
and the Invertocat are trademarks, and nothing here is endorsed by them.

### Dark
neutral #0D1117 #151B23 #212830 #262C36 #2A313C #2F3742 #3D444D #656C76
        #9198A1 #B7BDC8 #D1D7E0 #F0F6FC · black #010409
blue #79c0ff #58a6ff · green #56d364 #3fb950 · yellow #e3b341 #d29922
red #ff7b72 · purple #d2a8ff

### Light
neutral #F6F8FA #EFF2F5 #E6EAEF #E0E6EB #DAE0E7 #D1D9E0 #C8D1DA #818B98
        #59636E #454C54 #393F46 #25292E
blue #0969da #0550ae · green #1a7f37 #116329 · yellow #bf8700 #9a6700
red #cf222e · purple #8250df
