import { LunaUnload, Tracer } from "@luna/core";
import { ContextMenu, MediaItem, PlayState, redux, TidalApi } from "@luna/lib";

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
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const TIMED_OUT = Symbol("timed out");
/** Resolves with the promise's value, or TIMED_OUT if it takes longer than `ms` (or fails) */
const within = <T>(promise: Promise<T>, ms: number) =>
	new Promise<T | typeof TIMED_OUT>((resolve) => {
		const timeout = setTimeout(() => resolve(TIMED_OUT), ms);
		promise.then(
			(value) => (clearTimeout(timeout), resolve(value)),
			() => (clearTimeout(timeout), resolve(TIMED_OUT)),
		);
	});

// #region TIDAL state
const getQueue = () => {
	const playQueue = getState().playQueue;
	const elements: QueueElement[] = Array.isArray(playQueue?.elements) ? playQueue.elements : [];
	const currentIndex = typeof playQueue?.currentIndex === "number" ? playQueue.currentIndex : -1;
	return { elements, currentIndex, current: elements[currentIndex] as QueueElement | undefined };
};
// Queue entries are compared by uid and track, a new queue can reuse uids
const sameEntry = (a: QueueElement | undefined, b: QueueElement) => a !== undefined && a.uid === b.uid && key(a.mediaItemId) === key(b.mediaItemId);
const isCurrent = (element: QueueElement) => sameEntry(getQueue().current, element);
const isUpcoming = (element: QueueElement) => {
	const { elements, currentIndex } = getQueue();
	return elements.findIndex((el) => sameEntry(el, element)) > currentIndex;
};
const isNext = (element: QueueElement) => {
	const { elements, currentIndex } = getQueue();
	return sameEntry(elements[currentIndex + 1], element);
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
	// An explicit choice beats "leave it alone"
	leftAlone.delete(key(itemId));
	settings.allowedIds = [...allowedIds].join(",");
	settings.remixIds = [...remixIds].join(",");
	onSettingsChanged();
};

// A remix that comes straight back after being skipped is being picked on purpose (e.g. from your phone): leave it be for a while
const leftAlone = new Map<string, number>();
const isLeftAlone = (itemId: redux.ItemId) => (leftAlone.get(key(itemId)) ?? 0) > Date.now();
// #endregion

// #region Remix lookup
// Verdicts are the matched remix word, or "" when it's not a remix.
// Per stored object, so a fuller copy of a track TIDAL stores later gets judged again
let storeVerdicts = new WeakMap<object, string>();
// For tracks we had to fetch ourselves
const fetchedVerdicts = new Map<string, string>();
// itemId -> failed lookups, retried with a growing delay so a broken track isn't refetched on every pass
const failures = new Map<string, { count: number; at: number }>();
const retryDelay = (count: number) => [2_000, 10_000, 60_000][count - 1] ?? 5 * 60_000;
const retryTimeouts = new Set<ReturnType<typeof setTimeout>>();
unloads.add(() => retryTimeouts.forEach(clearTimeout));
const LOOKUP_TIMEOUT_MS = 8000;

// Parsed once per settings change instead of for every track
let matchOptions: MatchOptions | undefined;
const getMatchOptions = () =>
	(matchOptions ??= {
		extraWords: parseWordList(settings.extraWords),
		allowWords: parseWordList(settings.allowWords),
		keepAnniversaryMixes: settings.keepAnniversaryMixes,
	});

const judge = (info: TrackInfo, version = info.version) => {
	const word = remixMatch(info.title, version, getMatchOptions()) ?? "";
	if (word !== "") trace.log(`"${info.title}${version ? ` (${version})` : ""}" is a remix (matched "${word}")`);
	return word;
};

/**
 * The matched remix word, "" if it's not a remix, or undefined if we don't know yet. Never waits.
 */
const verdictNow = (itemId: redux.ItemId | undefined | null): string | undefined => {
	if (itemId === undefined || itemId === null) return undefined;
	const id = key(itemId);
	if (allowedIds.has(id) || isLeftAlone(id)) return "";
	if (remixIds.has(id)) return "marked as remix";

	const storedItem = getState().content?.mediaItems?.[id];
	const stored = storedItem?.item as TrackInfo | undefined;
	if (stored?.title !== undefined) {
		const cached = storeVerdicts.get(stored);
		if (cached !== undefined) return cached;
		// Some views store tracks without their version (where "Skrillex Remix" lives): those need fetching,
		// unless the title alone already says it's a remix. Videos can't be fetched as tracks, judge what's there.
		const complete = "version" in stored || storedItem?.type === "video";
		const word = judge(stored, complete ? stored.version : undefined);
		if (complete || word !== "") {
			storeVerdicts.set(stored, word);
			return word;
		}
	}
	return fetchedVerdicts.get(id);
};

const fetchTrack = async (itemId: redux.ItemId): Promise<TrackInfo | undefined> => {
	// A plain request for the track, doesn't depend on (or mess with) what TIDAL has stored
	if (typeof TidalApi?.track === "function") return (await TidalApi.track(itemId)) as TrackInfo | undefined;
	return (await MediaItem.fromId(itemId))?.tidalItem as TrackInfo | undefined;
};

/**
 * Like verdictNow, but fetches the track from TIDAL when needed. undefined if that fails.
 */
const verdict = async (itemId: redux.ItemId): Promise<string | undefined> => {
	const now = verdictNow(itemId);
	if (now !== undefined) return now;

	const id = key(itemId);
	const failed = failures.get(id);
	if (failed !== undefined && Date.now() - failed.at < retryDelay(failed.count)) return undefined;
	try {
		const info = await within(fetchTrack(itemId), LOOKUP_TIMEOUT_MS);
		// Make sure the response is actually for the item we asked for
		if (info !== TIMED_OUT && info?.title !== undefined && (info.id === undefined || key(info.id) === id)) {
			failures.delete(id);
			fetchedVerdicts.set(id, judge(info));
			return verdictNow(itemId);
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

/**
 * Call when settings change, forgets every verdict and re-checks the queue.
 */
export const onSettingsChanged = () => {
	matchOptions = undefined;
	allowedIds = parseIds(settings.allowedIds);
	remixIds = parseIds(settings.remixIds);
	storeVerdicts = new WeakMap();
	fetchedVerdicts.clear();
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
	isNext(element) || (lastPreload !== undefined && (lastPreload.referenceId === element.uid || lastPreload.productId === key(element.mediaItemId)));

// Entries we removed, so ones another plugin puts back (e.g. RealMAX restoring an old copy of the queue) are removed quietly
const removedUids = new Set<string>();
// Entries we asked TIDAL to remove that are still there (it ignored us), not asked again until they leave the queue
const pendingRemovals = new Set<string>();
const isRemovalIgnored = (element: QueueElement) => pendingRemovals.has(element.uid);
const forgetFinishedRemovals = (elements: QueueElement[]) => {
	if (pendingRemovals.size === 0) return;
	const present = new Set(elements.map((el) => el.uid));
	for (const uid of pendingRemovals) if (!present.has(uid)) pendingRemovals.delete(uid);
};
const removeElement = (element: QueueElement) => {
	if (isRemovalIgnored(element)) return;
	trace.log(`Removing ${element.mediaItemId} from the queue`);
	const before = getQueue().elements.length;
	redux.actions["playQueue/REMOVE_ELEMENT"]({ uid: element.uid });
	if (getQueue().elements.length >= before) {
		pendingRemovals.add(element.uid);
		// TIDAL ignored it (with TIDAL Connect it's removed once the server confirms)
		if (!isRemote()) return;
	}
	if (removedUids.has(element.uid)) return;
	if (removedUids.size > 5000) removedUids.clear();
	removedUids.add(element.uid);
	notifyRemoved();
};

/**
 * Removes upcoming remixes we already know about, without waiting on any lookups.
 */
const removeKnownUpcomingRemixes = () => {
	const { elements, currentIndex } = getQueue();
	for (const element of elements.slice(currentIndex + 1)) {
		if (verdictNow(element.mediaItemId) && isUpcoming(element)) removeElement(element);
	}
};

// Stop TIDAL from lining up a remix in the first place, then make it line up the right track
const blockedPreloads = { uid: undefined as string | undefined, count: 0 };
redux.intercept("player/PRELOAD_ITEM", unloads, (product) => {
	if (unloaded || product?.productId === undefined || product.productType === "video" || isRemote()) return;
	const productId = key(product.productId);
	const linedUp = { productId, referenceId: product.referenceId };
	const word = verdictNow(productId);
	if (!word) {
		lastPreload = linedUp;
		// Don't know yet: let it through and check it right away, it gets fixed up if it's a remix
		if (word === undefined) scheduleClean(0);
		return;
	}

	const { elements, currentIndex, current } = getQueue();
	// TIDAL tags what it lines up with the queue entry's uid, fall back to the track id
	const byUid = product.referenceId === undefined ? -1 : elements.findIndex((el) => el.uid === product.referenceId);
	const index = byUid !== -1 ? byUid : elements.findIndex((el, i) => i > currentIndex && key(el.mediaItemId) === productId);
	// Not an upcoming track (e.g. repeat all wrapping around to the start), or one TIDAL won't let us remove:
	// the check on what's playing catches it
	if (index <= currentIndex || isRemovalIgnored(elements[index])) {
		lastPreload = linedUp;
		return;
	}
	// Never fight TIDAL forever over the same track
	if (blockedPreloads.uid !== current?.uid) {
		blockedPreloads.uid = current?.uid;
		blockedPreloads.count = 0;
	}
	if (++blockedPreloads.count > 5) {
		lastPreload = linedUp;
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

// Safety net against fighting the user/TIDAL in an endless loop
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
const pauseIfStillPlaying = (stillStuck: () => boolean, delay: number) => {
	clearTimeout(pauseCheck);
	pauseCheck = setTimeout(() => {
		if (unloaded || !isPlaying() || !stillStuck()) return;
		PlayState.pause();
		notify("Paused a remix that couldn't be skipped");
	}, delay);
};
unloads.add(() => clearTimeout(pauseCheck));

// Tracks we just moved off ourselves. The player keeps reporting the old track until the next one has loaded
// (seconds on a slow connection), that's not a remix playing behind the queue's back.
const movedOff = new Map<string, number>();
const markMovedOff = (productId: string) => {
	const now = Date.now();
	for (const [id, at] of movedOff) if (now - at > 10_000) movedOff.delete(id);
	movedOff.set(productId, now);
};
const wasMovedOff = (productId: string) => Date.now() - (movedOff.get(productId) ?? 0) < 10_000;

let lastSkipped = { id: "", at: 0, bounces: 0 };
const skipCurrent = (current: QueueElement, backwards: boolean) => {
	const id = key(current.mediaItemId);
	const bounces = lastSkipped.id === id && Date.now() - lastSkipped.at < 3000 ? lastSkipped.bounces + 1 : 0;
	lastSkipped = { id, at: Date.now(), bounces };
	if (bounces >= 2) {
		leftAlone.set(id, Date.now() + 5 * 60_000);
		notify("This remix keeps being picked, leaving it alone");
		return;
	}
	if (!canSkip()) return;
	markMovedOff(id);

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
	// and if that doesn't move off the remix (autoplay can take a few seconds), pause it.
	trace.log("Skipping remix (end of queue)");
	redux.actions["playbackControls/SKIP_NEXT"]();
	pauseIfStillPlaying(() => isCurrent(current), 5000);
};

// The last queue entry that was playing (and wasn't a remix), to know where to continue from
let lastGoodUid: string | undefined;

/**
 * TIDAL started playing a remix the queue doesn't think is playing (it was lined up before we removed it).
 * Play the right track from the queue instead, or pause if there's nothing left.
 */
const fixWrongTrack = (productId: string) => {
	if (!canSkip()) return;
	markMovedOff(productId);
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
	// TIDAL needs a moment to load the right track, only give up when there's nothing to play or it never loads
	pauseIfStillPlaying(() => playingProductId() === productId, target === -1 ? 4000 : 15000);
};
// #endregion

// #region Queue cleaning
// Set when the player starts a different track, checked once TIDAL has had a moment to update its queue
let startedProduct: { productId: string; at: number } | undefined;
const QUEUE_SYNC_MS = 600;
// Don't hold up skipping or lining up the next track behind a slow lookup for longer than this
const SETTLE_DEADLINE_MS = 500;

const cleanOnce = async () => {
	const { current } = getQueue();
	const backwards = movedBackwards;
	movedBackwards = false;

	// 1. What's actually playing. If it's a remix the queue doesn't think is playing, play the right track instead.
	const started = startedProduct;
	if (started !== undefined && Date.now() - started.at < QUEUE_SYNC_MS) {
		// Give TIDAL a moment to move its queue to the new track first
		scheduleClean(started.at + QUEUE_SYNC_MS - Date.now());
	} else if (started !== undefined) {
		startedProduct = undefined;
		const outOfSync = () =>
			isPlaying() && !isRemote() && !wasMovedOff(started.productId) && started.productId === playingProductId() && key(getQueue().current?.mediaItemId) !== started.productId;
		if (outOfSync() && (await verdict(started.productId))) {
			if (unloaded) return;
			if (outOfSync()) return fixWrongTrack(started.productId);
		}
	}

	// 2. The queue's current track. Only skipped while playing, so opening TIDAL paused on a remix doesn't
	// start playback. It gets skipped as soon as you press play.
	let currentIsRemix = false;
	if (settings.skipCurrent && current !== undefined) {
		const lookup = verdict(current.mediaItemId);
		const word = await within(lookup, SETTLE_DEADLINE_MS);
		// Still looking it up: carry on, and check again once we know
		if (word === TIMED_OUT) lookup.then(() => scheduleClean(0));
		else currentIsRemix = !!word;
	}
	if (unloaded) return;
	const skipNow = currentIsRemix && isPlaying();

	// Pressed previous onto a remix: keep going back, the next pass handles the rest
	if (skipNow && backwards && isCurrent(current!) && getQueue().currentIndex > 0) return skipCurrent(current!, true);

	// 3. Everything coming up. Once we know what will play next (the first upcoming track that isn't a remix)
	// skip the current remix to it, or line it up if we removed what TIDAL had lined up. Done as early as possible,
	// the rest of the queue is cleaned after.
	let settled = false;
	let removedLinedUp = false;
	const settle = () => {
		if (settled) return;
		settled = true;
		if (skipNow && isCurrent(current!)) skipCurrent(current!, false);
		else if (removedLinedUp) relineUpNext();
	};

	const { elements, currentIndex } = getQueue();
	let removals = 0;
	for (const element of elements.slice(currentIndex + 1)) {
		if (unloaded) return;
		// Gone already (e.g. a new queue replaced this one): don't waste a lookup on it
		if (!isUpcoming(element)) continue;
		const lookup = verdict(element.mediaItemId);
		if (!settled && (await within(lookup, SETTLE_DEADLINE_MS)) === TIMED_OUT) {
			if (unloaded) return;
			settle();
		}
		const word = await lookup;
		if (unloaded) return;
		if (!word) {
			settle();
			continue;
		}
		// The queue may have changed while we were looking it up, only remove what's still upcoming
		if (!isUpcoming(element) || isRemovalIgnored(element)) continue;
		const linedUp = wasLinedUp(element);
		removeElement(element);
		if (linedUp) {
			if (settled) relineUpNext();
			else removedLinedUp = true;
		}
		// TIDAL Connect syncs each edit with the server, too many at once get rejected
		if (isRemote()) await sleep(400);
		// Let TIDAL breathe on huge queues
		else if (++removals % 100 === 0) await sleep(0);
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
const onStoreChange = () => {
	const { elements, currentIndex, current } = getQueue();
	const productId = playingProductId();
	const playing = isPlaying();
	if (elements === last.elements && currentIndex === last.currentIndex && productId === last.productId && playing === last.playing) return;
	if (elements !== last.elements) forgetFinishedRemovals(elements);

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
};
const unsubscribe = redux.store.subscribe(() => {
	// Runs inside TIDAL's own dispatch, never throw into it
	try {
		onStoreChange();
	} catch (err) {
		trace.warn("Failed to handle a TIDAL state change", err);
	}
});
unloads.add(unsubscribe);

// Clean whatever is already queued when the plugin loads
scheduleClean();
// #endregion

// #region Right click menu
try {
	const menuButton = ContextMenu.addButton(unloads);
	let openedMenus = 0;
	ContextMenu.onMediaItem(unloads, async ({ mediaCollection, contextMenu }) => {
		const menu = ++openedMenus;
		// Only for a single track
		const items = (mediaCollection as { tMediaItems?: { item?: { id?: redux.ItemId }; type?: string }[] }).tMediaItems;
		if (items?.length !== 1 || (items[0].type !== undefined && items[0].type !== "track")) return;
		const itemId = items[0].item?.id;
		if (itemId === undefined) return;

		const override = getOverride(itemId);
		const show = (detected: boolean) => {
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
		};
		// Show what we know right away, update it if the track still has to be looked up
		const known = override === undefined ? verdictNow(itemId) : "";
		show(!!known);
		await menuButton.show(contextMenu);
		if (override !== undefined || known !== undefined) return;
		const detected = !!(await verdict(itemId));
		// A newer menu was opened meanwhile
		if (menu !== openedMenus || unloaded) return;
		show(detected);
	});
} catch (err) {
	trace.err("Failed to add the right click menu", err);
}
// #endregion
