import { LunaUnload, Tracer } from "@luna/core";
import { MediaItem, PlayState, redux } from "@luna/lib";

import { parseWordList, remixMatch } from "./isRemix";
import { settings } from "./Settings";

export const { trace, errSignal } = Tracer("[NoRemix]");
export { Settings } from "./Settings";

// Functions in unloads are called when plugin is unloaded.
export const unloads = new Set<LunaUnload>();
let unloaded = false;
unloads.add(() => (unloaded = true));

type TrackInfo = { id?: redux.ItemId; title?: string; version?: string | null };

// #region Remix lookup
// itemId -> matched remix word ("" when not a remix), so tracks aren't re-checked on every queue change
const verdicts = new Map<string, string>();
// itemId -> time a lookup failed, so a broken track isn't refetched on every pass
const failures = new Map<string, number>();
const FAILURE_RETRY_MS = 5 * 60 * 1000;

const getTrackInfo = async (itemId: redux.ItemId): Promise<TrackInfo | undefined> => {
	const stored = redux.store.getState().content.mediaItems[itemId];
	if ((stored?.item as TrackInfo | undefined)?.title !== undefined) return stored!.item as TrackInfo;

	const failedAt = failures.get(String(itemId));
	if (failedAt !== undefined && Date.now() - failedAt < FAILURE_RETRY_MS) return;
	try {
		const mediaItem = await MediaItem.fromId(itemId, stored?.type ?? "track");
		const info = mediaItem?.tidalItem as TrackInfo | undefined;
		// Make sure the response is actually for the item we asked for
		if (info?.title !== undefined && (info.id === undefined || String(info.id) === String(itemId))) {
			failures.delete(String(itemId));
			return info;
		}
	} catch (err) {
		trace.warn(`Failed to load track ${itemId}`, err);
	}
	failures.set(String(itemId), Date.now());
};

/**
 * Returns the matched remix word if `itemId` is a remix, "" if it is not, or undefined if it could not be looked up.
 */
const checkItem = async (itemId: redux.ItemId): Promise<string | undefined> => {
	const key = String(itemId);
	const cached = verdicts.get(key);
	if (cached !== undefined) return cached;

	const info = await getTrackInfo(itemId);
	if (info === undefined) return;
	const verdict =
		remixMatch(info.title, info.version, {
			extraWords: parseWordList(settings.extraWords),
			allowWords: parseWordList(settings.allowWords),
			keepAnniversaryMixes: settings.keepAnniversaryMixes,
		}) ?? "";
	verdicts.set(key, verdict);
	if (verdict !== "") trace.log(`"${info.title}${info.version ? ` (${info.version})` : ""}" is a remix (matched "${verdict}")`);
	return verdict;
};
const isRemix = async (itemId: redux.ItemId) => !!(await checkItem(itemId));

/**
 * Call when settings change, forgets every verdict and re-checks the queue.
 */
export const onSettingsChanged = () => {
	verdicts.clear();
	scheduleClean();
};
// #endregion

// #region Notifications
let removedCount = 0;
let notifyTimeout: ReturnType<typeof setTimeout> | undefined;
// Tidal loads big lists in pages, so batch removals into one message
const notifyRemoved = () => {
	removedCount++;
	clearTimeout(notifyTimeout);
	notifyTimeout = setTimeout(() => {
		trace.log(`Removed ${removedCount} remix(es) from the play queue`);
		if (settings.notify && !unloaded) trace.msg.log(`Removed ${removedCount} remix${removedCount === 1 ? "" : "es"} from the queue`);
		removedCount = 0;
	}, 1500);
};
unloads.add(() => clearTimeout(notifyTimeout));
// #endregion

// #region Skipping the current track
// Direction of the last track change, so pressing "previous" onto a remix keeps going backwards
let movedBackwards = false;
const recentSkips: number[] = [];
let stuckCheck: ReturnType<typeof setTimeout> | undefined;
unloads.add(() => clearTimeout(stuckCheck));

const skipCurrent = (current: redux.PlayQueueElement) => {
	const { elements, currentIndex } = PlayState.playQueue;

	// Safety net: never fight the user/Tidal in an endless skip loop
	const now = Date.now();
	while (recentSkips.length > 0 && now - recentSkips[0] > 15000) recentSkips.shift();
	if (recentSkips.length >= 8) {
		trace.msg.log("Too many remixes in a row, pausing");
		recentSkips.length = 0;
		return PlayState.pause();
	}
	recentSkips.push(now);

	if (movedBackwards && currentIndex > 0) {
		trace.log("Skipping remix (backwards)");
		return PlayState.previous();
	}
	if (currentIndex < elements.length - 1) {
		trace.log("Skipping remix");
		return PlayState.next();
	}
	// Last track in the queue. Let Tidal's own next button handle it (autoplay / repeat all),
	// and if that doesn't move off the remix, pause it.
	trace.log("Skipping remix (end of queue)");
	redux.actions["playbackControls/SKIP_NEXT"]();
	clearTimeout(stuckCheck);
	stuckCheck = setTimeout(() => {
		const queue = PlayState.playQueue;
		if (!unloaded && queue.elements[queue.currentIndex]?.uid === current.uid && PlayState.playing) {
			trace.log("Nothing to skip to, pausing remix");
			PlayState.pause();
		}
	}, 2000);
};
// #endregion

// #region Queue cleaning
const isUpcoming = (uid: string) => {
	const { elements, currentIndex } = PlayState.playQueue;
	return elements.findIndex((el: redux.PlayQueueElement) => el.uid === uid) > currentIndex;
};
const isNext = (uid: string) => {
	const { elements, currentIndex } = PlayState.playQueue;
	return elements[currentIndex + 1]?.uid === uid;
};

const cleanOnce = async () => {
	// Deal with whatever is playing right now first, it's the most noticeable
	const current = PlayState.playQueue.elements[PlayState.playQueue.currentIndex];
	if (settings.skipCurrent && current !== undefined && (await isRemix(current.mediaItemId))) {
		if (unloaded) return;
		const stillCurrent = PlayState.playQueue.elements[PlayState.playQueue.currentIndex]?.uid === current.uid;
		// Moving changes currentIndex which schedules another pass, so stop here
		if (stillCurrent) return skipCurrent(current);
	}

	// Then everything coming up, in order, removing each remix as soon as it's found
	const upcoming = PlayState.playQueue.elements.slice(PlayState.playQueue.currentIndex + 1);
	let removedNext = false;
	for (const element of upcoming) {
		if (!(await isRemix(element.mediaItemId))) continue;
		if (unloaded) return;
		// The queue may have changed while we were looking tracks up, only remove what's still upcoming
		if (!isUpcoming(element.uid)) continue;
		removedNext ||= isNext(element.uid);
		redux.actions["playQueue/REMOVE_ELEMENT"]({ uid: element.uid });
		notifyRemoved();
	}

	// Tidal preloads the next track, if we removed it make Tidal line up the new next track
	if (removedNext) {
		try {
			(redux.actions["player/PRELOAD_NEXT_ITEM"] as (payload?: unknown) => unknown)();
		} catch (err) {
			trace.warn("Failed to preload next item", err);
		}
	}
};

let cleaning = false;
let cleanAgain = false;
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
	} catch (err) {
		trace.err("Failed to clean play queue", err);
	} finally {
		cleaning = false;
	}
};

let cleanTimeout: ReturnType<typeof setTimeout> | undefined;
const scheduleClean = () => {
	if (unloaded) return;
	clearTimeout(cleanTimeout);
	cleanTimeout = setTimeout(clean, 250);
};
unloads.add(() => clearTimeout(cleanTimeout));

// Re-check whenever the queue contents or position changes
let lastElements: redux.PlayQueueElement[] | undefined;
let lastIndex: number | undefined;
const unsubscribe = redux.store.subscribe(() => {
	const { elements, currentIndex } = redux.store.getState().playQueue;
	if (elements === lastElements && currentIndex === lastIndex) return;
	// Only a single step back in the same queue counts as "previous", clicking a track or playing something new does not
	if (currentIndex !== lastIndex) movedBackwards = elements.length === lastElements?.length && lastIndex !== undefined && currentIndex === lastIndex - 1;
	lastElements = elements;
	lastIndex = currentIndex;
	scheduleClean();
});
unloads.add(unsubscribe);

// Clean whatever is already queued when the plugin loads
scheduleClean();
// #endregion
