import assert from "node:assert/strict";
import { test } from "node:test";

import { isRemix, parseWordList, remixMatch } from "../plugins/NoRemix/src/isRemix.ts";

const remixes: [string, string?][] = [
	["Levels (Skrillex Remix)"],
	["Levels", "Skrillex Remix"],
	["Titanium - David Guetta Remix"],
	["One More Time [Remixed]"],
	["Strobe (Club Mix)"],
	["Animals (Martin Garrix VIP)"],
	["Bangarang - Dub"],
	["Song (Sped Up)"],
	["Song (Slowed + Reverb)"],
	["Song (Nightcore)"],
	["Song (Bootleg)"],
	["Song (Flip)"],
	["Song (Rework)"],
	["Song", "Re-Edit"],
	["Song (RMX)"],
	["Song (Extended Remix)"],
	["Mashup of the Year"],
	["SONG [REMIX]"],
	["Song (Re\u2011Edit)"],
	["Song (Mash\u2011Up)"],
	["Song \u2013 Club Mix"],
	["Song (sped-up)"],
	["Song (spedup)"],
	["Song (Daycore)"],
	["Song (8D Audio)"],
	["Song (feat. Someone) [Diplo Remix]"],
	["Песня (Ремикс)"],
	["Canción (Remezcla)"],
	["Song (Armand Van Helden Mix)"],
	["Song (2019 Club Mix)"],
	["Café Del Mar", "Michael Woods 2006 Remix"],
	["Sandstorm (Darude 2019 Remix)"],
	["2002", "Remix"],
	["1979 (Remix)"],
	["Song (With You Mix)"],
	["Song (Re-Work)"],
	["Song (Flipped)"],
	["Song (\uFF32\uFF25\uFF2D\uFF29\uFF38)"],
	["曲名リミックス"],
];

const notRemixes: [string, string?][] = [
	["Strobe (Original Mix)"],
	["Strobe (Extended Mix)"],
	["Strobe", "Radio Mix"],
	["Bohemian Rhapsody", "Remastered 2011"],
	["Love Story (Taylor's Version)"],
	["Flip"],
	["Bootleg Rascal"],
	["Mix Tape"],
	["Mixed Emotions"],
	["Song (Live)"],
	["Song (Acoustic Version)"],
	["Song - Radio Edit"],
	["Dubai Nights"],
	["Song (feat. Dub FX)"],
	["Song (feat. Mix Master Mike)"],
	["Song (Prod. by VIP)"],
	["Song (with Flip)"],
	["Come Together", "2019 Mix"],
	["Animals", "2018 Remix"],
	["Song (2009 Stereo Remix)"],
	["Song (Dolby Atmos Mix)"],
	["Song (Stereo Mix)"],
	["Song (Spatial Audio Mix)"],
	["Song (Instrumental)"],
	["Song (Mixtape Version)"],
	["Song (Mix-tape)"],
	["Song (Mix Cut)"],
	["Song", "Mix Cut"],
	["Song (From \"Bootleg\")"],
	['Song (From the Motion Picture "Flip")'],
	["Song (with Calvin Harris)"],
	["Song", "feat. Dub FX"],
	[""],
];

for (const [title, version] of remixes) {
	test(`removes: ${title}${version ? ` / ${version}` : ""}`, () => assert.equal(isRemix(title, version), true, `matched ${remixMatch(title, version)}`));
}
for (const [title, version] of notRemixes) {
	test(`keeps: ${title}${version ? ` / ${version}` : ""}`, () => assert.equal(isRemix(title, version), false, `matched ${remixMatch(title, version)}`));
}

test("extra words", () => {
	assert.equal(isRemix("Song (Cover)", undefined), false);
	assert.equal(isRemix("Song (Cover)", undefined, { extraWords: ["cover"] }), true);
	assert.equal(isRemix("Song (Live)", undefined, { extraWords: parseWordList(" live , , cover") }), true);
});

test("anniversary mixes can be removed too", () => {
	assert.equal(isRemix("Come Together", "2019 Mix", { keepAnniversaryMixes: false }), true);
	assert.equal(isRemix("Animals", "2018 Remix", { keepAnniversaryMixes: false }), true);
	assert.equal(isRemix("Song (Dolby Atmos Mix)", undefined, { keepAnniversaryMixes: false }), true);
});

test("single characters in word lists are ignored", () => {
	assert.deepEqual(parseWordList("a, i ,live,, cover, --, ..."), ["live", "cover"]);
	assert.equal(isRemix("A Sky Full of Stars", undefined, { extraWords: parseWordList("a") }), false);
});

test("allow words", () => {
	assert.equal(isRemix("Song (Skrillex Remix)", undefined, { allowWords: ["skrillex"] }), false);
	assert.equal(isRemix("Song (Diplo Remix)", undefined, { allowWords: ["skrillex"] }), true);
});
