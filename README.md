# TidaLuna Plugins

Plugins for [TidaLuna](https://github.com/Inrixia/TidaLuna).

## Install

In Tidal go to **Luna Settings → Plugin Store**, paste this URL, then enable the plugins you want:

```
https://github.com/CIoudGuy/TidaLuna-Plugins/releases/download/latest/store.json
```

## No Remix

Removes every remix from your play queue, and skips one if it starts playing, including remixes TIDAL had already lined up to play next.

**Removed:** tracks whose title or version marks them as a remix or remix-like version:
- remix, rmx, mashup, megamix, VIP, dub, bootleg, flip, rework, re-edit, DJ/producer edits ("Kygo Edit", "Club Edit"), club and DJ mixes
- sped up, slowed + reverb, nightcore, daycore, 8D audio, bass boosted, chopped & screwed, TikTok/club/dance versions, DJ genre versions like "(Techno)" or "(Phonk)"
- the same in other languages (Spanish, Russian, Japanese, Korean, Chinese, Arabic, ...)

**Kept:** Original/Extended/Radio Mix, Radio/Single/Album Edit, remasters, live, acoustic, instrumentals, vocal mixes, single remixes, songs that are just named "Flip" etc., and `(feat. …)` credits. Anniversary mixes like "2019 Mix" or "Dolby Atmos Mix" are kept unless you turn that off.

**Right click a track** → "No Remix: allow this track" to always keep it, or "No Remix: treat as a remix" to always remove it.

**Settings**
- **Skip remix if it's playing**: on by default
- **Show notification**: on by default
- **Keep anniversary mixes**: on by default
- **Extra words to remove**: e.g. `cover, live`
- **Never remove tracks containing**: e.g. a remixer you like
- **Tracks you allowed / marked as remixes**: clear your right click choices
