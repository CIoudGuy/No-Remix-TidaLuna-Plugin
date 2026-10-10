# TidaLuna Plugins

Plugins for [TidaLuna](https://github.com/Inrixia/TidaLuna).

## Install

In Tidal go to **Luna Settings → Plugin Store**, paste this URL, then enable the plugins you want:

```
https://github.com/CIoudGuy/TidaLuna-Plugins/releases/download/latest/store.json
```

## No Remix

Removes every remix from your play queue, and skips one if it starts playing.

**Removed:** tracks whose title or version contains
- **anywhere:** remix, rmx, mashup, remezcla, ремикс, リミックス, 리믹스
- **in brackets or after " - ":** mix, VIP, dub, flip, bootleg, rework, re-edit, refix, re-imagined, sped up, slowed, nightcore, daycore, 8D

**Kept:** Original/Extended/Radio Mix, remasters, live, acoustic, instrumentals, radio edits, songs that are just named "Flip" etc., and `(feat. …)` credits. Anniversary mixes like "2019 Mix" or "Dolby Atmos Mix" are kept unless you turn that off.

**Settings**
- **Skip remix if it's playing**: on by default
- **Show notification**: on by default
- **Keep anniversary mixes**: on by default
- **Extra words to remove**: e.g. `cover, live`
- **Never remove tracks containing**: e.g. a remixer you like
