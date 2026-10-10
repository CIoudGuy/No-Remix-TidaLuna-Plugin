// Pure matching logic (no @luna imports): decides from a title and version whether a track is a remix.

// In every word list below a space or hyphen means "space, hyphen or nothing", so "sped up" also matches
// "sped-up" and "spedup", and "+" or "&" means any joiner, so "slowed + reverb" also matches "slowed and reverb".
// Words in scripts written without spaces (Chinese, Japanese, Thai, ...) also match when glued to other text.

/**
 * Words that mean "remix" no matter where they show up in a track's title or version.
 */
export const strongWords = [
	"remix",
	"remixed",
	"remixes",
	"rmx",
	"mashup",
	"megamix",
	"remezcla",
	"nightcore",
	"daycore",
	"sped up",
	"slowed + reverb",
	"super slowed",
	"bass boosted",
	"8d audio",
	"chopped & screwed",
	"chopped not slopped",
	"ремикс",
	"ремікс",
	"リミックス",
	"리믹스",
	"重混",
	"混音版",
	"DJ版",
	"电音版",
	"加速版",
	"慢速版",
	"降调版",
	"電音版",
	"降調版",
	"重新混音",
	"抖音版",
	"รีมิกซ์",
	"ريمكس",
	"ریمیکس",
	"רמיקס",
	"रीमिक्स",
];

/**
 * Words that only count as "remix" when they are in the track's version field or a
 * bracketed / dashed part of the title, e.g. "Song (Club Mix)" or "Song - VIP".
 * This stops songs that are just *called* "Flip" or "Bootleg Rascal" from being removed.
 * "mix" and "edit" are special: "Club Mix" or "Kygo Edit" count, "Original Mix" or "Radio Edit" don't.
 */
export const qualifierWords = [
	"mix",
	"edit",
	"re-work",
	"re-worked",
	"re-edit",
	"re-edited",
	"bootleg",
	"flip",
	"flipped",
	"vip",
	"dub",
	"re-imagined",
	"re-fix",
	"re-rub",
	"re-mode",
	"re-touch",
	"re-interpretation",
	"re-interpreted",
	"speed up",
	"speed version",
	"reverb",
	"reverbed",
	"pitched",
	"pitch up",
	"pitch down",
	"screwed",
	"8d",
	"bass boost",
	"full bass",
	"dj slow",
	"phonk",
	"hardstyle",
	"hypertechno",
	"jersey club",
	"vaporwave",
	"brazilian funk",
	"mash up",
	"mashed up",
	"club version",
	"dance version",
	"dj version",
	"hızlandırılmış",
	"yavaşlatılmış",
	"ускоренная",
	"замедленная",
	"แดนซ์",
];

// Letters of alphabets that put spaces between words, plus digits. For the strong words anything else next to
// a word (spaces, brackets, Chinese / Japanese / Thai text...) counts as a word boundary, so "曲名Remix版" matches.
const WORD_CHAR = "[\\p{sc=Latin}\\p{sc=Cyrillic}\\p{sc=Greek}\\p{N}]";
// The weaker words need a real boundary, so "(VIPルーム)" (a VIP room) doesn't count
const ANY_WORD_CHAR = "[\\p{L}\\p{N}]";
// After a word, Chinese titles glue on "版" (version) or "环绕" (surround): "Lofi版", "8D环绕"
const ANY_WORD_CHAR_AFTER = "(?!版|环绕|環繞)[\\p{L}\\p{N}]";
// Scripts where words are glued together (or take glued prefixes like Arabic "ال"), matched without boundaries
const NO_SPACE_SCRIPT = /[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Thai}\p{sc=Arabic}\p{sc=Hebrew}\p{sc=Devanagari}]/u;
// What "+" and "&" in a word list stand for: "+", "&", "/", ",", "x", "and", "n", "'n'" or nothing
const JOINER = "(?:[\\s-]*(?:[+&/,×x]|and|'?n'?)[\\s-]*|[\\s-]?)";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordPattern = (word: string) =>
	word
		.trim()
		.split(/\s*[+&]\s*/)
		.map((piece) => piece.split(/[\s-]+/).map(escape).join("[\\s:-]?"))
		.join(JOINER);
// Your own words are taken as written ("+" and "&" are just characters), so no word can make matching slow
const literalWordPattern = (word: string) => word.trim().split(/[\s-]+/).map(escape).join("[\\s-]?");

/**
 * One regex matching any of `words` as whole words, plus raw regex fragments with (`bounded`) or without
 * (`unbounded`) word boundaries.
 */
const buildRegex = (words: string[], bounded: string[] = [], unbounded: string[] = [], boundary = WORD_CHAR, pattern = wordPattern, after = boundary) => {
	bounded = [...bounded];
	unbounded = [...unbounded];
	for (const word of words) (NO_SPACE_SCRIPT.test(word) ? unbounded : bounded).push(pattern(word));
	const alternatives: string[] = [];
	if (bounded.length > 0) alternatives.push(`(?<!${boundary})(?:${bounded.join("|")})(?!${after})`);
	alternatives.push(...unbounded);
	return alternatives.length > 0 ? new RegExp(alternatives.join("|"), "iu") : undefined;
};

// Compiled regexes are cached so the user's word lists aren't recompiled for every track
const regexCache = new Map<string, RegExp | undefined>();
const wordRegex = (words: string[]) => {
	if (words.length === 0) return undefined;
	const key = words.join("\0");
	if (!regexCache.has(key)) {
		if (regexCache.size > 50) regexCache.clear();
		regexCache.set(key, buildRegex(words, [], [], WORD_CHAR, literalWordPattern));
	}
	return regexCache.get(key);
};

const strongRegex = buildRegex(
	strongWords,
	[
		// remix, remixed, remixes, remixé(e), remixado, re-mix, re:mix, remixx
		"re[\\s:-]?mix(?:x|e[sd]?|é|ée|és|ées|ad[oa]s?|at[oa])?",
		"rmx[sd]?",
		"remiks",
		"ρεμ[ιί]ξ",
		"mash-?up",
		"mega[\\s-]?mix",
		"remezcla(?:d[oa]s?|s)?",
		"speeded[\\s-]?up",
		`slowed${JOINER}reverb(?:ed)?`,
		"(?:super|ultra)[\\s-]?slowed",
		"(?:8|9|10|12|16|32)d[\\s-]?audio",
		wordPattern("screwed & chopped"),
		"ремикс(?:а|у|ом|е|ы|ов)?",
		"ремікс(?:а|у|ом|і|и|ів)?",
		"м[эе]шап",
	],
	[
		// "Remix2023", "Remix2k23"
		"(?<!\\p{sc=Latin})remix(?=\\d)",
		// "DJ版", "DJ抖音版", "DJ阿卓版" (a Chinese DJ's version)
		"(?<!\\p{sc=Latin})dj[^()[\\]【】〖〗~]{0,12}?版",
		"(?:快速|倍速|[减減]速|降速|升[调調])版",
		// "慢摇" (DJ slow-rock style), but not "慢慢摇" (sway slowly)
		"(?<!慢)慢[摇搖]",
		"ريميكس",
	],
)!;

// Genres that are unmistakably a DJ / producer flip on their own, "(Techno)", "(Phonk)", "- Hardstyle"
const flipGenres =
	"(?:hard[\\s-]?|hyper[\\s-]?|melodic[\\s-]?)?techno|hard[\\s-]?style|psy[\\s-]?trance|dubstep|drum[\\s-]*(?:&|and|n|'n')[\\s-]*bass|dnb|d&b|" +
	"(?:deep|tech|afro|slap|future|bass|big[\\s-]?room)[\\s-]?house|edm|phonk|jersey[\\s-]?club|baile[\\s-]?funk|brazilian[\\s-]?funk|amapiano|" +
	"moombahton|lo[\\s-]?fi|vinahouse|vaporwave|jungle|(?:uk|speed)[\\s-]?garage|eurodance|hands[\\s-]?up|gabber|frenchcore|breakbeat|discofox" +
	"|(?:hard[\\s-]?)?tekk|hard[\\s-]?tek|schranz|rawstyle|jumpstyle|happy[\\s-]?hardcore|hard[\\s-]?bass";
// Plus everyday words that only mean a flip next to "Version": "(Club Version)", "(Trance Ver.)", "(Versión Dance)".
// "(Acoustic Version)", "(Salsa Version)" or "(Rock Ver.)" are new recordings of the song and are kept.
const genres = `${flipGenres}|house|trance|trap|drill|jersey|club|dance|dj|rave|party|electro|ele?c?tr[oóô]nica|electronic`;
const genreOnlyRegex = new RegExp(`^\\s*(?:${flipGenres})\\s*$`, "iu");

const qualifierRegex = buildRegex(
	qualifierWords.filter((word) => word !== "mix" && word !== "edit"),
	[
		"v\\.i\\.p\\.?",
		// "Lo-Fi" / "Lofi Version", but not a "Lo-Fi Demo"
		"lo[\\s-]?fi(?![\\s-]*demo)",
		"hyper[\\s-]?techno",
		"(?:16|32)d",
		`(?:${genres})[\\s-]*(?:ver(?:sion|siyon|s|\\.)?|版)`,
		`(?:versi[oó]n[ei]?|versão|versiyon|wersja|verze|ver\\.?)[\\s-]+(?:${genres}|(?:brega[\\s-]?)?funk)`,
		"tik[\\s-]?tok[\\s-]+ver(?:sion|\\.)?|hot[\\s-]+tik[\\s-]?tok|viral[\\s-]+tik[\\s-]?tok|tik[\\s-]?tok[\\s-]+viral",
		"h[ıi]zland[ıi]r[ıi]lm[ıi][şs]",
		"yava[şs]lat[ıi]lm[ıi][şs]",
		"ускоренн(?:ая|ый|ое)",
		"замедленн(?:ая|ый|ое)",
		"клубн(?:ая|ый)\\s+(?:версия|микс)",
		// sped up or slowed down by a factor, "(0.8x)", "(1.25x)", "(x1.2)"
		"(?:[01]\\.\\d{1,2}|2\\.0)\\s*[x×]|[x×]\\s*(?:[01]\\.\\d{1,2}|2\\.0)",
		// #10 Ukrainian and Brazilian/Spanish sped up and club wording
		"прискорен(?:а|ий|е)",
		"[су]?повільнен(?:а|ий|е)",
		"клубн(?:а|ий)\\s+(?:версія|мікс)",
		"(?:versi[oó]n|versão)[\\s-]+acelerad[oa]",
		// "(Slowed)", but not The Beatles' "Slowed Down For Master Tape"
		"slowed(?![\\s-]+down[\\s-]+for[\\s-]+(?:the[\\s-]+)?master)",
	],
	["倍速"],
	ANY_WORD_CHAR,
	wordPattern,
	ANY_WORD_CHAR_AFTER,
)!;

// "mix" / "edit" with what is directly in front of it, so "Clubmix" and "Kygo Edit" can be told apart from "Radio Edit"
const mixRegex = new RegExp(`(?<!${ANY_WORD_CHAR})(\\p{sc=Latin}*)mix(?!${ANY_WORD_CHAR_AFTER})`, "giu");
const editRegex = new RegExp(`(?<!${ANY_WORD_CHAR})edit(?!${ANY_WORD_CHAR_AFTER})`, "giu");

/** Words that can come before "mix" without making it a remix, e.g. "Original Mix", "Extended Vocal Mix", '7" Mix' */
const plainMixWords = new Set(
	(
		"original extended radio album single main short long full vocal vocals instrumental inst acapella acappella a cappella acoustic " +
		"live demo rough early alternate alt alternative unreleased previously outtake outtakes session sessions rehearsal take reference " +
		"final clean explicit dirty censored edit edited version ver the and us uk 7 7in 7inch inch 45 lp ep cd video tv promo 1st first unnumbered trial underdubbed"
	).split(" "),
);
/** Words that can come before "edit" without making it a DJ edit, e.g. "Radio Edit", "Single Edit", "Director's Edit" */
const plainEditWords = new Set([
	...plainMixWords,
	...(
		"shortened mono stereo promotional remaster remastered new intro outro usa film movie trailer teaser commercial ad digital special quick " +
		"fade fadeout director directors piano orchestral orchestra strings string sax saxophone guitar choir gospel unplugged stripped " +
		"christmas xmas holiday spotify apple amazon deezer tidal youtube mtv vevo bbc fm am kiss clip lyric lyrics rap without no super " +
		"length dialogue dialog spoken narration english spanish french german italian portuguese japanese korean chinese spanglish " +
		"second 2nd part pt mix amended uncensored vinyl international intl"
	).split(" "),
]);
/** "Radiomix" counts as "Radio Mix", while "Clubmix" or "Partymix" is a remix */
const plainMixPrefixes = new Set(["radio", "album", "single", "original", "extended", "main"]);

/** The text between the last separator and `index`, at most 80 characters back */
const clauseBefore = (part: string, index: number) =>
	part
		.slice(Math.max(0, index - 80), index)
		.split(/\s[-~|]\s|[/;,:()[\]{}+]/)
		.pop() ?? "";
/** Its words, lowercased and without quotes or dots */
const wordsOf = (clause: string) =>
	clause
		.toLowerCase()
		.replace(/["'.]/g, "")
		.split(/[\s&-]+/)
		.filter((word) => word !== "");

const mixMatch = (part: string) => {
	for (const match of part.matchAll(mixRegex)) {
		const prefix = match[1].toLowerCase();
		if (prefix !== "") {
			if (!plainMixPrefixes.has(prefix)) return match[0];
			continue;
		}
		const index = match.index!;
		// "Mix Cut" / "Mix Tape" (a track from a DJ-mix album or a mixtape) and anything called "Original ... Mix"
		if (/^[\s-]?(?:cut|tape)(?![\p{L}\p{N}])/iu.test(part.slice(index + 3))) continue;
		if (/(?<![\p{L}\p{N}])original(?![\p{L}\p{N}])/iu.test(part)) continue;
		// OutKast "Hey Ya! - Radio Mix / Club Mix" is the album version
		if (/radio\s+mix\s*\/\s*club\s+mix/iu.test(part)) continue;
		const clause = clauseBefore(part, index);
		const words = wordsOf(clause);
		// "Mono Single Mix" / "Alternate Stereo Mix" are plain, a bare "Stereo Mix" is an anniversary mix (see below)
		const other = words.filter((word) => !plainMixWords.has(word));
		if (words.length > other.length && other.every((word) => word === "mono" || word === "stereo")) continue;
		return `${clause}${match[0]}`.trim();
	}
};

const editMatch = (part: string) => {
	for (const match of part.matchAll(editRegex)) {
		const clause = clauseBefore(part, match.index!);
		if (wordsOf(clause).every((word) => plainEditWords.has(word) || /^\d+$/.test(word))) continue;
		return `${clause}${match[0]}`.trim();
	}
};

/**
 * Anniversary / reissue mixes of the original recording, e.g. The Beatles "Come Together - 2019 Mix",
 * "Animals - 2018 Remix", "(Dolby Atmos Mix)", "(Stereo Mix)", "(50th Anniversary Mix)", John Lennon "Imagine - Ultimate Mix".
 * Only when that is the *whole* version, "(Darude 2019 Remix)" is still a remix. Kept unless the setting says otherwise.
 */
const anniversaryWords = new Set(
	(
		"stereo mono master remaster remastered version edition anniversary dolby atmos spatial audio binaural quad quadraphonic surround " +
		"5.1 7.1 7.1.4 360 reality ra immersive headphone headphones original new deluxe super the and"
	).split(" "),
);
const anniversaryMarker =
	/^(?:stereo|mono|atmos|spatial|binaural|quad|quadraphonic|surround|5\.1|7\.1(?:\.4)?|360|immersive|headphones?|anniversary|ultimate)$/;
const versionWords = (part: string) =>
	part
		.toLowerCase()
		.split(/(?:[\s/;,&+()[\]"-]|版|环绕|環繞)+/)
		.filter((word) => word !== "");
const isAnniversary = (part: string) => {
	let mixed = false;
	let marked = false;
	// EMI mix numbers on reissues, "Mono Mix RM 11", "Stereo Mix RS6"
	for (const word of versionWords(part.replace(/(?<![\p{L}\p{N}])r[ms]\s*\d{1,3}(?![\p{L}\p{N}])/giu, " "))) {
		if (word === "mix" || word === "remix" || word === "remixed") mixed = true;
		// A year only counts in front of the mix, "2019 Mix" but not "Remix 2019"
		else if (/^(?:19|20)\d{2}$/.test(word)) marked ||= !mixed;
		// "50th Anniversary Mix" is fine, but "(2nd Mix)" alone is just a second remix
		else if (/^\d{1,3}(?:st|nd|rd|th)$/.test(word)) continue;
		else if (anniversaryMarker.test(word)) marked = true;
		else if (!anniversaryWords.has(word)) return false;
	}
	return mixed && marked;
};

/**
 * "Single Remix" is the original artist's single version (Queen "I Want To Break Free - Single Remix"), never removed.
 */
const singleRemixWords = new Set(["single", "remix", "remaster", "remastered", "version", "mono", "stereo", "7", "the"]);
const isSingleRemix = (part: string) => {
	const words = versionWords(part);
	return words.includes("single") && words.includes("remix") && words.every((word) => singleRemixWords.has(word) || /^(?:19|20)\d{2}$/.test(word));
};

/**
 * Parts that are not remixes despite saying "mix": single remixes always, anniversary mixes when they're kept.
 */
const isPlainPart = (part: string, keepAnniversaryMixes: boolean) =>
	/mix/i.test(part) && (isSingleRemix(part) || (keepAnniversaryMixes && isAnniversary(part)));

/**
 * A part without its plain pieces ("Single Version / Mono Mix" -> "Single Version"), or "" if it's all plain.
 */
const cutPlain = (part: string, keepAnniversaryMixes: boolean) => {
	if (isPlainPart(part, keepAnniversaryMixes)) return "";
	const pieces = part.split(/([/;,]|\s-\s)/);
	if (pieces.length < 3) return part;
	let kept = "";
	let cut = false;
	for (let i = 0; i < pieces.length; i += 2) {
		if (pieces[i].trim() !== "" && isPlainPart(pieces[i], keepAnniversaryMixes)) {
			cut = true;
			continue;
		}
		kept += (kept === "" ? "" : pieces[i - 1]) + pieces[i];
	}
	return cut ? kept : part;
};

/**
 * Bracketed parts that are credits rather than a version, e.g. "(feat. Dub FX)", "(Prod. by VIP)",
 * '(From "Bootleg")' or "(Originally Performed by Flip) [Karaoke]". "(With You Mix)" ends with a mix so it's still a version.
 */
const creditRegex =
	/^\s*(?:(?:feat|ft|featuring|with|duet with|live with|prod|produced by|sung by|starring|from|theme from|music from|taken from|as featured in|featured in|as heard in|as seen in|inspired by|originally performed by|originally by|as made famous by|made famous by|in the style of|as performed by|performed by|a tribute to|tribute to|written by|composed by|arranged by|arr|narr|con)\b|w\/|part\.)/iu;
const endsWithMix = /(?:mix|edit)\s*$/iu;
const isCredit = (part: string) => creditRegex.test(part) && !endsWithMix.test(part);

// Names in quotes are titles of something else, e.g. '(Theme from "VIP")' or '(TVアニメ「MIX」オープニングテーマ)'
const quotedRegex = /"[^"]*"|«[^«»]*»|「[^「」]*」|『[^『』]*』|《[^《》]*》|〈[^〈〉]*〉/g;

// Unicode dashes become "-", curly quotes become straight ones and "ʀᴇᴍɪx" small capitals become letters
const replacements: Record<string, string> = {};
for (const c of "‐‑‒–—―−⁃⸗⸺⸻⹀﹘﹣") replacements[c] = "-";
for (const c of "“”„‟″") replacements[c] = '"';
for (const c of "‘’‚‛′") replacements[c] = "'";
[..."ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘʀꜱᴛᴜᴠᴡʏᴢ"].forEach((c, i) => (replacements[c] = "abcdefghijklmnoprstuvwyz"[i]));
// ...and invisible formatting characters (zero width spaces, soft hyphens, direction marks) are dropped
const cleanupRegex = new RegExp(`\\p{Cf}|[${Object.keys(replacements).join("")}]`, "gu");

/**
 * Unify fullwidth and "fancy text" letters ("ＲＥＭＩＸ", "𝐒𝐩𝐞𝐝 𝐔𝐩", "ʀᴇᴍɪx"), the many unicode dashes ("Re‑Edit",
 * "Song – Remix") and curly quotes, and drop invisible characters (a zero width space inside "Remix").
 */
export const normalize = (text: string | undefined | null) => {
	text ??= "";
	// Plain ASCII, most titles, needs none of this
	if (!/[^\x00-\x7f]/.test(text)) return text;
	return text.normalize("NFKC").replace(cleanupRegex, (c) => replacements[c] ?? "");
};

// (), [], {}, 【】, 〖〗, 〔〕, ~ ~ and 〜 〜 (a bracket left open at the end of the title counts too)
const bracketRegex = /\(([^)]*)(?:\)|$)|\[([^\]]*)(?:\]|$)|\{([^{}]*)\}|【([^【】]*)】|〖([^〖〗]*)〗|〔([^〔〕]*)〕|~([^~]+)~|〜([^〜]+)〜/g;
// " - ", "Song -VIP-", "Song- VIP" and " | "
const dashRegex = /(?:\s-|-\s|\s\|\s)\s*(.+)$/;

/**
 * The bracketed / dashed parts of a title, with the text to cut out to remove them.
 */
const versionParts = (title: string) => {
	const parts: { text: string; whole: string }[] = [];
	for (const match of title.matchAll(bracketRegex)) parts.push({ text: match.slice(1).find((group) => group !== undefined) ?? "", whole: match[0] });
	const dash = title.match(dashRegex);
	if (dash) parts.push({ text: dash[1], whole: dash[0] });
	return parts;
};

/** Splits parts on " - " and drops credits like "(feat. X)" */
const usableParts = (parts: string[]) => parts.flatMap((part) => part.split(/\s-\s/)).filter((part) => part.trim() !== "" && !isCredit(part));

/**
 * Pulls out the parts of a title that usually describe the version:
 * anything in brackets and anything after " - ". Credits like "(feat. X)" are skipped.
 */
export const qualifierParts = (title: string): string[] => usableParts(versionParts(title).map((part) => part.text));

/**
 * The remix word in one version part, e.g. "VIP" in "Song (VIP)" or "Kygo Edit" in "Song (Kygo Edit)".
 */
const partMatch = (part: string) => {
	part = part.replace(quotedRegex, " ");
	const qualifier = part.match(qualifierRegex);
	if (qualifier) return qualifier[0];
	if (genreOnlyRegex.test(part)) return part.trim();
	return (/mix/i.test(part) ? mixMatch(part) : undefined) ?? (/edit/i.test(part) ? editMatch(part) : undefined);
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

	// Cut out anniversary mixes ("Come Together - 2019 Mix" -> "Come Together") and single remixes
	const keepAnniversaryMixes = opts.keepAnniversaryMixes !== false;
	let parts = versionParts(title);
	let cut = false;
	for (const part of parts) {
		const text = cutPlain(part.text, keepAnniversaryMixes);
		if (text === part.text) continue;
		title = title.replace(part.whole, () => (text.trim() === "" ? " " : part.whole.replace(part.text, () => text)));
		cut = true;
	}
	if (cut) parts = versionParts(title);
	version = cutPlain(version, keepAnniversaryMixes);

	const strong = `${title} ${version}`.match(strongRegex);
	if (strong) return strong[0];

	for (const part of usableParts([version, ...parts.map((part) => part.text)])) {
		const match = partMatch(part);
		if (match) return match;
	}
	return undefined;
};

export const isRemix = (title: string | undefined | null, version: string | undefined | null, opts?: MatchOptions) => remixMatch(title, version, opts) !== undefined;
