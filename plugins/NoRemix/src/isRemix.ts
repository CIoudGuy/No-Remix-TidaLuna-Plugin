// Pure matching logic (no @luna imports): decides from a title and version whether a track is a remix.

// In every word list below a space or hyphen means "space, hyphen or nothing",
// so "sped up" also matches "sped-up" and "spedup".

/**
 * Words that mean "remix" no matter where they show up in a track's title or version.
 */
export const strongWords = ["remix", "remixed", "remixes", "rmx", "mashup", "remezcla", "ремикс", "リミックス", "리믹스"];
// Languages written without spaces, matched even when glued to other words e.g. "曲名リミックス"
const noBoundaryWords = ["リミックス", "리믹스"];

/**
 * Words that only count as "remix" when they are in the track's version field or a
 * bracketed / dashed part of the title, e.g. "Song (Club Mix)" or "Song - VIP".
 * This stops songs that are just *called* "Flip" or "Bootleg Rascal" from being removed.
 */
export const qualifierWords = [
	"mix",
	"re-work",
	"re-worked",
	"re-edit",
	"bootleg",
	"flip",
	"flipped",
	"vip",
	"dub",
	"re-imagined",
	"refix",
	"sped up",
	"speed up",
	"slowed",
	"nightcore",
	"daycore",
	"8d",
	"8d audio",
];

/**
 * Phrases that contain a qualifier word but are NOT remixes.
 * "Original Mix" / "Extended Mix" are just the normal track on electronic releases.
 */
const notRemixPhrases = ["original mix", "extended mix", "extended original mix", "radio mix", "album mix", "single mix", "main mix", "mix cut", "mix tape"];

/**
 * Anniversary / reissue mixes of the original recording, e.g. The Beatles "Come Together - 2019 Mix",
 * "Animals - 2018 Remix", "(Dolby Atmos Mix)", "(Stereo Mix)". Only when that is the *whole* version,
 * "(Darude 2019 Remix)" is still a remix. Kept unless the setting says otherwise.
 */
const anniversaryRegex =
	/^\s*(?:(?:19|20)\d{2}\s+(?:(?:stereo|mono|remaster(?:ed)?)\s+)?(?:re)?mix|(?:dolby\s+)?atmos\s+mix|spatial(?:\s+audio)?\s+mix|stereo\s+mix|mono\s+mix)\s*$/iu;

/**
 * Bracketed parts that are credits rather than a version, e.g. "(feat. Dub FX)", "(Prod. by VIP)"
 * or '(From "Bootleg")'. "(With You Mix)" ends with a mix so it's still a version.
 */
const creditRegex = /^\s*(?:feat|ft|featuring|with|prod|produced by|starring|from)\b/iu;
const endsWithMix = /(?:mix|edit)\s*$/iu;
const isCredit = (part: string) => creditRegex.test(part) && !endsWithMix.test(part);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordPattern = (word: string) => word.split(/[\s-]+/).map(escape).join("[\\s-]?");
// Compiled regexes are cached so the user's word lists aren't recompiled for every track
const regexCache = new Map<string, RegExp>();
const wordRegex = (words: string[], flags = "iu") => {
	if (words.length === 0) return undefined;
	const key = `${flags}\0${words.join("\0")}`;
	let regex = regexCache.get(key);
	if (regex === undefined) {
		if (regexCache.size > 50) regexCache.clear();
		regex = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(wordPattern).join("|")})(?![\\p{L}\\p{N}])`, flags);
		regexCache.set(key, regex);
	}
	return regex;
};

const strongRegex = wordRegex([...strongWords, "re-mix", "mash-up"])!;
const noBoundaryRegex = new RegExp(noBoundaryWords.join("|"), "u");
const qualifierRegex = wordRegex(qualifierWords)!;
const notRemixRegex = wordRegex(notRemixPhrases, "giu")!;

/**
 * Unify fullwidth letters ("ＲＥＭＩＸ") and the many unicode dashes ("Re‑Edit", "Song – Remix").
 */
export const normalize = (text: string | undefined | null) =>
	(text ?? "").normalize("NFKC").replace(/[‐-―−﹘﹣－]/g, "-");

/**
 * The bracketed / dashed parts of a title, with the text to cut out to remove them.
 */
const versionParts = (title: string) => {
	const parts: { text: string; whole: string }[] = [];
	for (const match of title.matchAll(/\(([^)]*)\)|\[([^\]]*)\]|\{([^}]*)\}/g)) parts.push({ text: match[1] ?? match[2] ?? match[3], whole: match[0] });
	const dash = title.match(/\s-\s(.+)$/);
	if (dash) parts.push({ text: dash[1], whole: dash[0] });
	return parts;
};

/**
 * Pulls out the parts of a title that usually describe the version:
 * anything in (), [] or {} and anything after " - ". Credits like "(feat. X)" are skipped.
 */
export const qualifierParts = (title: string): string[] =>
	versionParts(title)
		.map((part) => part.text)
		.filter((part) => !isCredit(part));

/**
 * Removes anniversary mix parts from a title, e.g. "Come Together - 2019 Mix" -> "Come Together".
 */
const stripAnniversaryParts = (title: string) => {
	for (const part of versionParts(title)) if (anniversaryRegex.test(part.text)) title = title.replace(part.whole, " ");
	return title;
};

/**
 * Splits a user supplied comma separated list into lowercase words.
 */
export const parseWordList = (list: string | undefined): string[] =>
	(list ?? "")
		.split(",")
		.map((w) => w.trim().toLowerCase())
		// Ignore single characters and punctuation only entries, so a half typed word can't match everything
		.filter((w) => w.length > 1 && /[\p{L}\p{N}]/u.test(w));

export interface MatchOptions {
	/** Extra words that should be treated as "remix" anywhere in the title or version */
	extraWords?: string[];
	/** Words that, if present, mean the track is never removed */
	allowWords?: string[];
	/** Keep reissue mixes of the original recording like "2019 Mix" or "Dolby Atmos Mix" (default true) */
	keepAnniversaryMixes?: boolean;
}

/**
 * Returns the word that marks this track as a remix, or undefined if it isn't one.
 */
export const remixMatch = (title: string | undefined | null, version: string | undefined | null, opts: MatchOptions = {}): string | undefined => {
	title = normalize(title);
	version = normalize(version);
	if (`${title}${version}`.trim() === "") return undefined;
	const fullText = `${title} ${version}`;

	if (wordRegex(opts.allowWords ?? [])?.test(fullText)) return undefined;

	const extra = fullText.match(wordRegex(opts.extraWords ?? []) ?? /$^/);
	if (extra) return extra[0];

	if (opts.keepAnniversaryMixes !== false) {
		title = stripAnniversaryParts(title);
		if (anniversaryRegex.test(version)) version = "";
	}

	const text = `${title} ${version}`;
	const strong = text.match(strongRegex) ?? text.match(noBoundaryRegex);
	if (strong) return strong[0];

	const parts = [...(version && !isCredit(version) ? [version] : []), ...qualifierParts(title)];
	for (const part of parts) {
		// Remove known "not a remix" phrases first so "Original Mix" doesn't match "mix"
		const match = part.replace(notRemixRegex, " ").match(qualifierRegex);
		if (match) return match[0];
	}
	return undefined;
};

export const isRemix = (title: string | undefined | null, version: string | undefined | null, opts?: MatchOptions) => remixMatch(title, version, opts) !== undefined;
