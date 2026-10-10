// Pure matching logic, kept free of @luna imports so it can be tested with plain node.

// In every word list below a space or hyphen means "space, hyphen or nothing",
// so "sped up" also matches "sped-up" and "spedup".

/**
 * Words that mean "remix" no matter where they show up in a track's title or version.
 */
export const strongWords = ["remix", "remixed", "remixes", "rmx", "mashup", "remezcla", "ремикс", "リミックス", "리믹스"];

/**
 * Words that only count as "remix" when they are in the track's version field or a
 * bracketed / dashed part of the title, e.g. "Song (Club Mix)" or "Song - VIP".
 * This stops songs that are just *called* "Flip" or "Bootleg Rascal" from being removed.
 */
export const qualifierWords = [
	"mix",
	"rework",
	"reworked",
	"re-edit",
	"bootleg",
	"flip",
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
const notRemixPhrases = ["original mix", "extended mix", "extended original mix", "radio mix", "album mix", "single mix", "main mix"];

/**
 * Anniversary / reissue mixes of the original recording, e.g. The Beatles "Come Together - 2019 Mix",
 * "Animals - 2018 Remix", "(Dolby Atmos Mix)", "(Stereo Mix)". Kept unless the setting says otherwise.
 */
const anniversaryRegex = /(?<![\p{L}\p{N}])(?:(?:19|20)\d{2}(?:\s+(?:stereo|mono|remaster(?:ed)?))?\s+(?:re)?mix|(?:dolby\s+)?atmos\s+mix|spatial(?:\s+audio)?\s+mix|stereo\s+mix|mono\s+mix)(?![\p{L}\p{N}])/giu;

/**
 * Bracketed parts that are credits rather than a version, e.g. "(feat. Dub FX)" or "(Prod. by VIP)".
 */
const creditRegex = /^\s*(?:feat|ft|featuring|with|prod|produced by|starring)\b/iu;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordPattern = (word: string) => word.split(/[\s-]+/).map(escape).join("[\\s-]?");
const wordRegex = (words: string[], flags = "iu") =>
	words.length === 0 ? undefined : new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map(wordPattern).join("|")})(?![\\p{L}\\p{N}])`, flags);

const strongRegex = wordRegex([...strongWords, "re-mix", "mash-up"])!;
const qualifierRegex = wordRegex(qualifierWords)!;
const notRemixRegex = wordRegex(notRemixPhrases, "giu")!;

/**
 * Unify the many unicode dashes/hyphens so "Re‑Edit" (non-breaking hyphen) or "Song – Remix" match.
 */
export const normalize = (text: string | undefined | null) => (text ?? "").replace(/[‐-―−﹘﹣－]/g, "-");

/**
 * Pulls out the parts of a title that usually describe the version:
 * anything in (), [] or {} and anything after " - ". Credits like "(feat. X)" are skipped.
 */
export const qualifierParts = (title: string): string[] => {
	const parts: string[] = [];
	for (const match of title.matchAll(/\(([^)]*)\)|\[([^\]]*)\]|\{([^}]*)\}/g)) parts.push(match[1] ?? match[2] ?? match[3]);
	const dash = title.match(/\s-\s(.+)$/);
	if (dash) parts.push(dash[1]);
	return parts.filter((part) => !creditRegex.test(part));
};

/**
 * Splits a user supplied comma separated list into lowercase words, ignoring single characters
 * so a half typed word like "a" can't wipe out the queue.
 */
export const parseWordList = (list: string | undefined): string[] =>
	(list ?? "")
		.split(",")
		.map((w) => w.trim().toLowerCase())
		.filter((w) => w.length > 1);

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
	const fullText = `${title} ${version}`.trim();
	if (fullText === "") return undefined;

	if (wordRegex(opts.allowWords ?? [])?.test(fullText)) return undefined;

	const scrub = (text: string) => (opts.keepAnniversaryMixes === false ? text : text.replace(anniversaryRegex, " "));

	const strong = scrub(fullText).match(strongRegex) ?? fullText.match(wordRegex(opts.extraWords ?? []) ?? /$^/);
	if (strong) return strong[0];

	const parts = [...(version ? [version] : []), ...qualifierParts(title)];
	for (const part of parts) {
		// Remove known "not a remix" phrases first so "Original Mix" doesn't match "mix"
		const match = scrub(part).replace(notRemixRegex, " ").match(qualifierRegex);
		if (match) return match[0];
	}
	return undefined;
};

export const isRemix = (title: string | undefined | null, version: string | undefined | null, opts?: MatchOptions) => remixMatch(title, version, opts) !== undefined;
