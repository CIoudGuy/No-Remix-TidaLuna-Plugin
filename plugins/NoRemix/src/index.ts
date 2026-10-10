import { LunaUnload, Tracer } from "@luna/core";
import { ContextMenu, MediaItem, PlayState, redux } from "@luna/lib";

import { type MatchOptions, parseWordList, remixMatch } from "./isRemix";
import { settings } from "./Settings";

export const { trace, errSignal } = Tracer("[NoRemix]");
export { Settings } from "./Settings";

// Functions in unloads are called when plugin is unloaded.
export const unloads = new Set<LunaUnload>();
let unloaded = false;
unloads.add(() => (unloaded = true));

type TrackInfo = { id?: redux.ItemId; title?: string; version?: string | null };
type QueueElement = redux.PlayQueueElement;

const key = (id: unknown) => String(id);
const getState = () => redux.store.getState();

// #region TIDAL state
const getQueue = () => {
	const playQueue = getState().playQueue;
	const elements: QueueElement[] = Array.isArray(playQueue?.elements) ? playQueue.elements : [];
	const currentIndex = typeof playQueue?.currentIndex === "number" ? playQueue.currentIndex : -1;
	return { elements, currentIndex, current: elements[currentIndex] as QueueElement | undefined };
};
const isCurrent = (uid: string) => getQueue().current?.uid === uid;
const isUpcoming = (uid: string) => {
	const { elements, currentIndex } = getQueue();
	return elements.findIndex((el) => el.uid === uid) > currentIndex;
};
const isNext = (uid: string) => {
	const { elements, currentIndex } = getQueue();
	return elements[currentIndex + 1]?.uid === uid;
};

const isPlaying = () => getState().playbackControls?.desiredPlaybackState === "PLAYING";

/**
 * The track TIDAL's player is actually playing. Usually the queue's current track, but not always:
 * TIDAL lines up the next track ~15s before the end and plays it even if it was removed from the queue since.
 */
const playingProductId = (): string | undefined => {
	const controls = getState().playbackControls;
	const id = controls?.playbackContext?.actualProductId ?? controls?.mediaProduct?.productId;
	return id === undefined || id === null || id === "" ? undefined : key(id);
};

// Playing on another device with TIDAL Connect, the local player isn't the one playing
const isRemote = () => {
	const state = getState() as { activePlayer?: { activePlayer?: string }; playbackControls?: { playbackContext?: { playbackSessionId?: string } } };
	return state.activePlayer?.activePlayer === "REMOTE_PLAYBACK" || state.playbackControls?.playbackContext?.playbackSessionId === "tidal-connect";
};
// #endregion

// #region Your choices (right click a track)
const parseIds = (ids: string | undefined) =>
	new Set(
		(ids ?? "")
			.split(",")
			.map((id) => id.trim())
			.filter((id) => id !== ""),
	);
let allowedIds = parseIds(settings.allowedIds);
let remixIds = parseIds(settings.remixIds);

type Override = "allow" | "remix" | undefined;
const getOverride = (itemId: redux.ItemId): Override => (allowedIds.has(key(itemId)) ? "allow" : remixIds.has(key(itemId)) ? "remix" : undefined);
const setOverride = (itemId: redux.ItemId, override: Override) => {
	allowedIds.delete(key(itemId));
	remixIds.delete(key(itemId));
	if (override === "allow") allowedIds.add(key(itemId));
	if (override === "remix") remixIds.add(key(itemId));
	settings.allowedIds = [...allowedIds].join(",");
	settings.remixIds = [...remixIds].join(",");
	onSettingsChanged();
};
// #endregion

// #region Remix lookup
// itemId -> matched remix word ("" when not a remix), so tracks aren't re-checked on every queue change
const verdicts = new Map<string, string>();
// itemId -> failed lookups, retried with a growing delay so a broken track isn't refetched on every pass
const failures = new Map<string, { count: number; at: number }>();
const retryDelay = (count: number) => [2_000, 10_000, 60_000][count - 1] ?? 5 * 60_000;
const retryTimeouts = new Set<ReturnType<typeof setTimeout>>();
unloads.add(() => retryTimeouts.forEach(clearTimeout));

// Parsed once per settings change instead of for every track
let matchOptions: MatchOptions | undefined;
const getMatchOptions = () =>
	(matchOptions ??= {
		extraWords: parseWordList(settings.extraWords),
		allowWords: parseWordList(settings.allowWords),
		keepAnniversaryMixes: settings.keepAnniversaryMixes,
	});

const judge = (itemId: redux.ItemId, info: TrackInfo) => {
	const word = remixMatch(info.title, info.version, getMatchOptions()) ?? "";
	verdicts.set(key(itemId), word);
	if (word !== "") trace.log(`"${info.title}${info.version ? ` (${info.version})` : ""}" is a remix (matched "${word}")`);
	return word;
};

/**
 * The matched remix word, "" if it's not a remix, or undefined if the track isn't loaded yet. Never waits.
 */
const verdictNow = (itemId: redux.ItemId | undefined | null): string | undefined => {
	if (itemId === undefined || itemId === null) return undefined;
	const override = getOverride(itemId);
	if (override === "allow") return "";
	if (override === "remix") return "marked as remix";
	const cached = verdicts.get(key(itemId));
	if (cached !== undefined) return cached;
	const stored = getState().content?.mediaItems?.[key(itemId)]?.item as TrackInfo | undefined;
	if (stored?.title === undefined) return undefined;
	return judge(itemId, stored);
};

/**
 * Like verdictNow, but loads the track from TIDAL when it isn't loaded yet. undefined if that fails.
 */
const verdict = async (itemId: redux.ItemId): Promise<string | undefined> => {
	const now = verdictNow(itemId);
	if (now !== undefined) return now;

	const id = key(itemId);
	const failed = failures.get(id);
	if (failed !== undefined && Date.now() - failed.at < retryDelay(failed.count)) return undefined;
	try {
		const contentType = getState().content?.mediaItems?.[id]?.type ?? "track";
		const info = (await MediaItem.fromId(itemId, contentType))?.tidalItem as TrackInfo | undefined;
		// Make sure the response is actually for the item we asked for
		if (info?.title !== undefined && (info.id === undefined || key(info.id) === id)) {
			failures.delete(id);
			return verdictNow(itemId) ?? judge(itemId, info);
		}
	} catch (err) {
		trace.warn(`Failed to load track ${id}`, err);
	}
	const count = (failed?.count ?? 0) + 1;
	failures.set(id, { count, at: Date.now() });
	// Check it again once the wait is over instead of only on the next queue change
	const retry = setTimeout(() => {
		retryTimeouts.delete(retry);
		scheduleClean();
	}, retryDelay(count) + 100);
	retryTimeouts.add(retry);
	return undefined;
};
const isRemix = async (itemId: redux.ItemId) => !!(await verdict(itemId));

/**
 * Call when settings change, forgets every verdict and re-checks the queue.
 */
export const onSettingsChanged = () => {
	matchOptions = undefined;
	allowedIds = parseIds(settings.allowedIds);
	remixIds = parseIds(settings.remixIds);
	verdicts.clear();
	scheduleClean();
};
// #endregion

// #region Notifications
const notify = (message: string) => {
	trace.log(message);
	if (settings.notify && !unloaded) trace.msg.log(message);
};

let removedCount = 0;
let notifyTimeout: ReturnType<typeof setTimeout> | undefined;
// TIDAL loads big lists in pages, so batch removals into one message
const notifyRemoved = () => {
	removedCount++;
	clearTimeout(notifyTimeout);
	notifyTimeout = setTimeout(() => {
		notify(`Removed ${removedCount} remix${removedCount === 1 ? "" : "es"} from the queue`);
		removedCount = 0;
	}, 1500);
};
unloads.add(() => clearTimeout(notifyTimeout));
// #endregion

// #region Lining up the next track
// What TIDAL last asked its player to line up next. The player plays that even after it's removed from the queue.
let lastPreload: { productId: string; referenceId?: string } | undefined;

const preloadNext = () => {
	if (unloaded || isRemote()) return;
	try {
		// No payload: TIDAL lines up whatever is next in the queue
		(redux.actions["player/PRELOAD_NEXT_ITEM"] as (payload?: unknown) => unknown)();
	} catch (err) {
		trace.warn("Failed to line up the next track", err);
	}
};
// TIDAL's player can finish an older line up after a newer one, so ask again a moment later to be sure ours wins
let relineUpTimeout: ReturnType<typeof setTimeout> | undefined;
const relineUpNext = () => {
	trace.log("Lining up the next track again");
	preloadNext();
	clearTimeout(relineUpTimeout);
	relineUpTimeout = setTimeout(preloadNext, 3000);
};
unloads.add(() => clearTimeout(relineUpTimeout));

const wasLinedUp = (element: QueueElement) =>
	isNext(element.uid) || (lastPreload !== undefined && (lastPreload.referenceId === element.uid || lastPreload.productId === key(element.mediaItemId)));

const removeElement = (element: QueueElement) => {
	trace.log(`Removing ${element.mediaItemId} from the queue`);
	redux.actions["playQueue/REMOVE_ELEMENT"]({ uid: element.uid });
	notifyRemoved();
};

/**
 * Removes upcoming remixes whose verdict is already known, without waiting on any lookups.
 */
const removeKnownUpcomingRemixes = () => {
	const { elements, currentIndex } = getQueue();
	for (const element of elements.slice(currentIndex + 1)) {
		if (verdictNow(element.mediaItemId) && isUpcoming(element.uid)) removeElement(element);
	}
};

// Stop TIDAL from lining up a remix in the first place, then make it line up the right track
const blockedPreloads = { uid: undefined as string | undefined, count: 0 };
redux.intercept("player/PRELOAD_ITEM", unloads, (product) => {
	if (unloaded || product?.productId === undefined || isRemote()) return;
	const productId = key(product.productId);
	const word = verdictNow(productId);
	if (!word) {
		lastPreload = { productId, referenceId: product.referenceId };
		// Not loaded yet: let it through and check it right away, it gets fixed up if it's a remix
		if (word === undefined) scheduleClean(0);
		return;
	}

	const { elements, currentIndex, current } = getQueue();
	// TIDAL tags what it lines up with the queue entry's uid, fall back to the track id
	const byUid = product.referenceId === undefined ? -1 : elements.findIndex((el) => el.uid === product.referenceId);
	const index = byUid !== -1 ? byUid : elements.findIndex((el, i) => i > currentIndex && key(el.mediaItemId) === productId);
	// Not an upcoming track (e.g. repeat all wrapping around to the start), the audio check catches it if it plays
	if (index <= currentIndex) {
		lastPreload = { productId, referenceId: product.referenceId };
		return;
	}
	// Never fight TIDAL forever over the same track
	if (blockedPreloads.uid !== current?.uid) {
		blockedPreloads.uid = current?.uid;
		blockedPreloads.count = 0;
	}
	if (++blockedPreloads.count > 5) {
		lastPreload = { productId, referenceId: product.referenceId };
		return;
	}

	trace.log(`Stopped TIDAL from lining up a remix (${productId})`);
	setTimeout(() => {
		if (unloaded) return;
		removeKnownUpcomingRemixes();
		preloadNext();
	});
	return true;
});
// #endregion

// #region Skipping what's playing
// True when the last track change was a "previous" (the old track is now right after the current one),
// so pressing previous onto a remix keeps going backwards instead of bouncing forward again
let movedBackwards = false;

// Safety net against fighting the user/TIDAL in an endless loop, reset whenever a non remix is playing
const recentSkips: number[] = [];
const canSkip = () => {
	const now = Date.now();
	while (recentSkips.length > 0 && now - recentSkips[0] > 15000) recentSkips.shift();
	if (recentSkips.length >= 8) {
		recentSkips.length = 0;
		PlayState.pause();
		notify("Too many remixes in a row, pausing");
		return false;
	}
	recentSkips.push(now);
	return true;
};

// If skipping didn't work (nothing to skip to), pause instead of letting the remix play
let pauseCheck: ReturnType<typeof setTimeout> | undefined;
const pauseIfStillPlaying = (stillStuck: () => boolean, delay = 2000) => {
	clearTimeout(pauseCheck);
	pauseCheck = setTimeout(() => {
		if (unloaded || !isPlaying() || !stillStuck()) return;
		PlayState.pause();
		notify("Paused a remix that couldn't be skipped");
	}, delay);
};
unloads.add(() => clearTimeout(pauseCheck));

const skipCurrent = (current: QueueElement, backwards: boolean) => {
	if (!canSkip()) return;
	const { elements, currentIndex } = getQueue();
	if (backwards && currentIndex > 0) {
		trace.log("Skipping remix (backwards)");
		return PlayState.previous();
	}
	if (currentIndex < elements.length - 1) {
		trace.log("Skipping remix");
		return PlayState.next();
	}
	// Last track in the queue. Let TIDAL's own next button handle it (autoplay / repeat all),
	// and if that doesn't move off the remix, pause it.
	trace.log("Skipping remix (end of queue)");
	redux.actions["playbackControls/SKIP_NEXT"]();
	pauseIfStillPlaying(() => isCurrent(current.uid));
};

// The last queue entry that was playing (and wasn't a remix), to know where to continue from
let lastGoodUid: string | undefined;

/**
 * TIDAL started playing a remix the queue doesn't think is playing (it was lined up before we removed it).
 * Play the right track from the queue instead, or pause if there's nothing left.
 */
const fixWrongTrack = (productId: string) => {
	if (!canSkip()) return;
	const { elements, currentIndex, current } = getQueue();
	const remixIndex = elements.findIndex((el) => key(el.mediaItemId) === productId);
	const lastGoodIndex = lastGoodUid === undefined ? -1 : elements.findIndex((el) => el.uid === lastGoodUid);
	let start: number;
	// The queue hasn't caught up with the player yet: continue after the remix
	if (remixIndex > currentIndex) start = remixIndex + 1;
	// The queue lost track of what's playing: continue after the last track that played
	else if (current === undefined) start = lastGoodIndex + 1;
	// The queue is still on the track that just finished
	else if (current.uid === lastGoodUid) start = currentIndex + 1;
	// The queue already moved on to the track that should be playing
	else start = currentIndex;

	let target = -1;
	for (let i = Math.max(start, 0); i < elements.length; i++) {
		if (key(elements[i].mediaItemId) !== productId && !verdictNow(elements[i].mediaItemId)) {
			target = i;
			break;
		}
	}
	notify("Skipped a remix TIDAL had already lined up");
	if (target !== -1) {
		trace.log(`Remix ${productId} is playing instead of the queue's track, playing queue entry ${target}`);
		PlayState.moveTo(target);
	} else {
		trace.log(`Remix ${productId} is playing and nothing is left in the queue`);
		redux.actions["playbackControls/SKIP_NEXT"]();
	}
	pauseIfStillPlaying(() => playingProductId() === productId, 2500);
};
// #endregion

// #region Queue cleaning
// Set when the player starts a different track, checked once TIDAL has had a moment to update its queue
let startedProduct: { productId: string; at: number } | undefined;
const QUEUE_SYNC_MS = 600;

const cleanOnce = async () => {
	const { current } = getQueue();
	const backwards = movedBackwards;

	// 1. What's actually playing. If it's a remix the queue doesn't think is playing, play the right track instead.
	const started = startedProduct;
	if (started !== undefined && Date.now() - started.at < QUEUE_SYNC_MS) {
		// Give TIDAL a moment to move its queue to the new track first
		scheduleClean(started.at + QUEUE_SYNC_MS - Date.now());
	} else if (started !== undefined) {
		startedProduct = undefined;
		const outOfSync = () => isPlaying() && !isRemote() && started.productId === playingProductId() && key(getQueue().current?.mediaItemId) !== started.productId;
		if (outOfSync() && (await isRemix(started.productId))) {
			if (unloaded) return;
			if (outOfSync()) return fixWrongTrack(started.productId);
		}
	}

	// 2. The queue's current track. Only skipped while playing, so opening TIDAL paused on a remix doesn't
	// start playback. It gets skipped as soon as you press play.
	const currentIsRemix = settings.skipCurrent && current !== undefined && (await isRemix(current.mediaItemId));
	if (unloaded) return;
	const skipNow = currentIsRemix && isPlaying();
	if (!currentIsRemix) recentSkips.length = 0;

	// Pressed previous onto a remix: keep going back, the next pass handles the rest
	if (skipNow && backwards && isCurrent(current!.uid) && getQueue().currentIndex > 0) return skipCurrent(current!, true);

	// 3. Everything coming up. Once we know what will play next (the first upcoming track that isn't a remix)
	// skip the current remix to it, or line it up if we removed what TIDAL had lined up. Done as early as possible,
	// the rest of the queue is cleaned after.
	let settled = false;
	let removedLinedUp = false;
	const settle = () => {
		if (settled) return;
		settled = true;
		if (skipNow && isCurrent(current!.uid)) skipCurrent(current!, false);
		else if (removedLinedUp) relineUpNext();
	};

	const { elements, currentIndex } = getQueue();
	for (const element of elements.slice(currentIndex + 1)) {
		if (!(await isRemix(element.mediaItemId))) {
			if (unloaded) return;
			settle();
			continue;
		}
		if (unloaded) return;
		// The queue may have changed while we were looking tracks up, only remove what's still upcoming
		if (!isUpcoming(element.uid)) continue;
		const linedUp = wasLinedUp(element);
		removeElement(element);
		// TIDAL Connect syncs each edit with the server, too many at once get rejected
		if (isRemote()) await new Promise((resolve) => setTimeout(resolve, 400));
		if (linedUp) {
			if (settled) relineUpNext();
			else removedLinedUp = true;
		}
	}
	settle();
};

let cleaning = false;
let cleanAgain = false;
let reportedError = false;
const clean = async () => {
	if (cleaning) {
		cleanAgain = true;
		return;
	}
	cleaning = true;
	try {
		do {
			cleanAgain = false;
			await cleanOnce();
		} while (cleanAgain && !unloaded);
		// Clear an earlier error from Luna's plugin list once things work again
		if (reportedError && errSignal) {
			reportedError = false;
			errSignal._ = undefined;
		}
	} catch (err) {
		reportedError = true;
		trace.err("Failed to clean play queue", err);
		// Don't lose a re-check that was requested while this pass was running
		if (cleanAgain) scheduleClean();
	} finally {
		cleaning = false;
	}
};

let cleanTimeout: ReturnType<typeof setTimeout> | undefined;
let cleanDue = Infinity;
const scheduleClean = (delay = 250) => {
	if (unloaded) return;
	const due = Date.now() + delay;
	// Already scheduled sooner
	if (cleanTimeout !== undefined && cleanDue <= due) return;
	clearTimeout(cleanTimeout);
	cleanDue = due;
	cleanTimeout = setTimeout(() => {
		cleanTimeout = undefined;
		cleanDue = Infinity;
		clean();
	}, delay);
};
unloads.add(() => clearTimeout(cleanTimeout));

// Re-check whenever the queue, the playing track or play/pause changes
let last: { elements?: unknown; currentIndex?: number; currentUid?: string; productId?: string; playing?: boolean } = {};
const unsubscribe = redux.store.subscribe(() => {
	const { elements, currentIndex, current } = getQueue();
	const productId = playingProductId();
	const playing = isPlaying();
	if (elements === last.elements && currentIndex === last.currentIndex && productId === last.productId && playing === last.playing) return;

	if (current?.uid !== last.currentUid) {
		movedBackwards = last.currentUid !== undefined && elements[currentIndex + 1]?.uid === last.currentUid;
	}
	if (productId !== last.productId) {
		// What was lined up is playing now
		lastPreload = undefined;
		if (productId !== undefined) startedProduct = { productId, at: Date.now() };
	}
	if (current !== undefined && productId === key(current.mediaItemId) && !verdictNow(productId)) lastGoodUid = current.uid;
	// React quickly when what's playing changes, give queue edits a moment to settle
	const urgent = currentIndex !== last.currentIndex || productId !== last.productId || playing !== last.playing;
	last = { elements, currentIndex, currentUid: current?.uid, productId, playing };
	scheduleClean(urgent ? 50 : 250);
});
unloads.add(unsubscribe);

// Clean whatever is already queued when the plugin loads
scheduleClean();
// #endregion

// #region Right click menu
try {
	const menuButton = ContextMenu.addButton(unloads);
	ContextMenu.onMediaItem(unloads, async ({ mediaCollection, contextMenu }) => {
		// Only for a single track
		const items = (mediaCollection as { tMediaItems?: { item?: { id?: redux.ItemId }; type?: string }[] }).tMediaItems;
		if (items?.length !== 1 || (items[0].type !== undefined && items[0].type !== "track")) return;
		const itemId = items[0].item?.id;
		if (itemId === undefined) return;

		const override = getOverride(itemId);
		const detected = override === undefined && !!(await verdict(itemId));
		const [text, next, message]: [string, Override, string] =
			override === "allow"
				? ["No Remix: stop allowing this track", undefined, "No Remix will decide about this track again"]
				: override === "remix"
					? ["No Remix: stop treating as a remix", undefined, "No Remix will decide about this track again"]
					: detected
						? ["No Remix: allow this track", "allow", "No Remix will keep this track"]
						: ["No Remix: treat as a remix", "remix", "No Remix will remove this track"];
		menuButton.text = text;
		menuButton.onClick(() => {
			setOverride(itemId, next);
			trace.msg.log(message);
			try {
				redux.actions["contextMenu/CLOSE"]();
			} catch {}
		});
		await menuButton.show(contextMenu);
	});
} catch (err) {
	trace.err("Failed to add the right click menu", err);
}
// #endregion
