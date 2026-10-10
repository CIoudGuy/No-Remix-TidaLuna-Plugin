// Loads the *built* plugin (dist/) against a fake Tidal redux store to check it really edits the queue.
// Run `pnpm build` first.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { pathToFileURL } from "node:url";

const tracks: Record<string, { id: number; title: string; version?: string | null }> = {};
const addTrack = (id: number, title: string, version?: string) => (tracks[id] = { id, title, version });
addTrack(1, "Levels");
addTrack(2, "Levels", "Skrillex Remix");
addTrack(3, "Strobe (Original Mix)");
addTrack(4, "Titanium - David Guetta Remix");
addTrack(5, "Animals (VIP)");
addTrack(6, "Wake Me Up");
addTrack(7, "Clarity (Tiësto Remix)"); // not in the store, the plugin has to "fetch" it
addTrack(8, "Broken Track"); // fetching always fails
addTrack(9, "Hey Brother");
addTrack(10, "Silence (Tiësto Remix)"); // not in the store and slow to fetch
addTrack(11, "Summer"); // not in the store and slow to fetch
for (let id = 20; id < 32; id++) addTrack(id, `Remix Number ${id}`);

type Element = { uid: string; mediaItemId: number; context: { type: "UNKNOWN" }; priority: "priority_none" };
type State = {
	content: { mediaItems: Record<string, { item: object; type: string }> };
	playQueue: { currentIndex: number; elements: Element[]; repeatMode: number };
	playbackControls: { desiredPlaybackState: string };
};
const storeItems = () => Object.fromEntries(Object.entries(tracks).filter(([id]) => !["7", "8", "10", "11"].includes(id)).map(([id, item]) => [id, { item, type: "track" }]));
let state: State;
const listeners = new Set<() => void>();
let dispatched: { type: string; payload?: any; fetchesSoFar: number[] }[] = [];
let fetches: number[] = [];
let skipNextDoesNothing = false;
let removeDoesNothing = false;

const update = (playQueue: Partial<State["playQueue"]>) => {
	state = { ...state, playQueue: { ...state.playQueue, ...playQueue } };
	listeners.forEach((l) => l());
};
const dispatch = (type: string, payload?: any) => {
	dispatched.push({ type, payload, fetchesSoFar: [...fetches] });
	const q = state.playQueue;
	switch (type) {
		case "playQueue/REMOVE_ELEMENT": {
			if (removeDoesNothing) return;
			const index = q.elements.findIndex((e) => e.uid === payload.uid);
			return update({ elements: q.elements.filter((e) => e.uid !== payload.uid), currentIndex: index < q.currentIndex ? q.currentIndex - 1 : q.currentIndex });
		}
		case "playQueue/MOVE_NEXT":
			return update({ currentIndex: Math.min(q.currentIndex + 1, q.elements.length - 1) });
		case "playQueue/MOVE_PREVIOUS":
			return update({ currentIndex: Math.max(q.currentIndex - 1, 0) });
		case "playbackControls/SKIP_NEXT":
			if (skipNextDoesNothing) return;
			return update({ currentIndex: q.repeatMode === 1 && q.currentIndex === q.elements.length - 1 ? 0 : Math.min(q.currentIndex + 1, q.elements.length - 1) });
		case "playbackControls/PAUSE":
			state = { ...state, playbackControls: { desiredPlaybackState: "NOT_PLAYING" } };
			return;
	}
};
let uidCounter = 0;
const setQueue = (ids: number[], currentIndex = 0, repeatMode = 0) =>
	update({ currentIndex, repeatMode, elements: ids.map((id) => ({ uid: `u${uidCounter++}`, mediaItemId: id, context: { type: "UNKNOWN" }, priority: "priority_none" })) });
const queueIds = () => state.playQueue.elements.map((e) => e.mediaItemId);
const currentId = () => state.playQueue.elements[state.playQueue.currentIndex]?.mediaItemId;
const types = () => dispatched.map((d) => d.type);

const messages: string[] = [];
const noop = () => {};
const tracer = { log: noop, warn: noop, err: noop, debug: noop, msg: { log: (m: string) => messages.push(m), warn: noop, err: noop } };
const settings = { skipCurrent: true, notify: true, keepAnniversaryMixes: true, extraWords: "", allowWords: "" };
const redux = {
	store: { getState: () => state, subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)) },
	actions: new Proxy({}, { get: (_, type: string) => (payload: unknown) => dispatch(type, payload) }),
};
const PlayState = {
	get playQueue() {
		return state.playQueue;
	},
	get playing() {
		return state.playbackControls.desiredPlaybackState === "PLAYING";
	},
	next: () => dispatch("playQueue/MOVE_NEXT"),
	previous: () => dispatch("playQueue/MOVE_PREVIOUS"),
	pause: () => dispatch("playbackControls/PAUSE"),
};
const MediaItem = {
	fromId: async (id: number) => {
		fetches.push(id);
		await new Promise((r) => setTimeout(r, id === 10 || id === 11 ? 300 : 20));
		if (id === 8) throw new Error("not available");
		return { tidalItem: tracks[id] };
	},
};

(globalThis as any).luna = {
	core: {
		LunaPlugin: { getByName: () => ({ addDependant: noop }) },
		modules: {
			"@luna/core": { Tracer: () => ({ trace: tracer, errSignal: {} }), ReactiveStore: { getPluginStorage: async () => settings } },
			"@luna/lib": { redux, PlayState, MediaItem },
			"@luna/ui": {},
			react: {},
		},
	},
};

const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
const resetState = () => {
	state = { content: { mediaItems: storeItems() }, playQueue: { currentIndex: 0, elements: [], repeatMode: 0 }, playbackControls: { desiredPlaybackState: "PLAYING" } };
	dispatched = [];
	fetches = [];
	skipNextDoesNothing = false;
	removeDoesNothing = false;
	messages.length = 0;
};
resetState();
const plugin = await import(pathToFileURL(`${process.cwd()}/dist/cioudguy.no-remix.mjs`).href);
await wait();

beforeEach(async () => {
	// Let the previous test's batched notification and pause timers fire before resetting
	await wait(2100);
	resetState();
});

test("removes upcoming remixes, including ones not loaded yet, with one notification", async () => {
	setQueue([1, 2, 3, 4, 5, 6, 7]);
	await wait(2000);
	assert.deepEqual(queueIds(), [1, 3, 6]);
	assert.deepEqual(messages, ["Removed 4 remixes from the queue"]);
});

test("lines up the new next track when the next track was removed", async () => {
	setQueue([1, 2, 6]);
	await wait();
	assert.deepEqual(queueIds(), [1, 6]);
	assert.ok(types().includes("player/PRELOAD_NEXT_ITEM"));
});

test("does not preload when only later tracks were removed", async () => {
	setQueue([1, 6, 2]);
	await wait();
	assert.deepEqual(queueIds(), [1, 6]);
	assert.ok(!types().includes("player/PRELOAD_NEXT_ITEM"));
});

test("skips a remix that is playing", async () => {
	setQueue([2, 6, 4, 1]);
	await wait(800);
	assert.equal(currentId(), 6);
	assert.deepEqual(queueIds(), [2, 6, 1]);
});

test("pressing previous onto a remix keeps going back instead of bouncing forward", async () => {
	setQueue([1, 2, 6], 2);
	await wait();
	dispatch("playQueue/MOVE_PREVIOUS"); // user presses previous onto the remix in history
	await wait(800);
	assert.equal(currentId(), 1);
	assert.equal(state.playQueue.currentIndex, 0);
});

test("a remix at index 0 when going back moves forward instead", async () => {
	setQueue([2, 6], 1);
	await wait();
	dispatch("playQueue/MOVE_PREVIOUS");
	await wait(800);
	assert.equal(currentId(), 6);
});

test("a remix that is the last track is paused when there is nothing to skip to", async () => {
	skipNextDoesNothing = true;
	setQueue([6, 2], 1);
	await wait(3000);
	assert.ok(types().includes("playbackControls/SKIP_NEXT"));
	assert.ok(types().includes("playbackControls/PAUSE"));
});

test("a remix that is the last track wraps around with repeat all", async () => {
	setQueue([6, 2], 1, 1);
	await wait(2500); // past the 2s "nothing to skip to" check
	assert.equal(currentId(), 6);
	assert.ok(!types().includes("playbackControls/PAUSE"));
});

test("a queue full of remixes pauses when there is nothing left to play", async () => {
	skipNextDoesNothing = true;
	setQueue([2, 4, 5, 7], 0);
	await wait(3000);
	assert.deepEqual(queueIds(), [2]);
	assert.equal(state.playbackControls.desiredPlaybackState, "NOT_PLAYING");
	// It didn't keep dispatching
	const count = dispatched.length;
	await wait(1000);
	assert.equal(dispatched.length, count);
});

test("loop guard pauses after 8 skips in a row even if Tidal ignores removals", async () => {
	removeDoesNothing = true;
	setQueue([1, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]);
	await wait(); // a non-remix playing resets the guard
	update({ currentIndex: 1 }); // user clicks the first remix
	await wait(6000);
	assert.equal(types().filter((t) => t === "playQueue/MOVE_NEXT").length, 8);
	assert.equal(state.playbackControls.desiredPlaybackState, "NOT_PLAYING");
	assert.ok(messages.includes("Too many remixes in a row, pausing"));
});

test("a run of remixes after the current remix is removed and skipped in one go", async () => {
	setQueue([2, 4, 5, 7, 20, 21, 6, 1, 22]);
	await wait(1000);
	assert.deepEqual(queueIds(), [2, 6, 1]);
	assert.equal(currentId(), 6);
	assert.equal(types().filter((t) => t === "playQueue/MOVE_NEXT").length, 1);
	assert.ok(!types().includes("playbackControls/PAUSE"));
});

test("previous followed by playing a new queue doesn't skip backwards", async () => {
	setQueue([1, 3, 6, 9], 3);
	await wait();
	dispatch("playQueue/MOVE_PREVIOUS"); // index 2, a non-remix
	await wait();
	setQueue([1, 3, 2, 6, 9, 3, 1], 2); // new album of the same length, user clicks its 3rd track: a remix
	await wait(800);
	// Skipped forward to the 4th track, not back to the 2nd
	assert.equal(state.playQueue.currentIndex, 3);
	assert.equal(currentId(), 6);
});

test("lines up the new next track before slow lookups of later tracks finish", async () => {
	setQueue([1, 2, 6, 11]);
	await wait(1000);
	const preload = dispatched.find((d) => d.type === "player/PRELOAD_NEXT_ITEM");
	assert.ok(preload);
	assert.ok(!preload.fetchesSoFar.includes(11));
});

test("tracks that fail to load are kept and not refetched on every change", async () => {
	setQueue([1, 8, 6]);
	await wait();
	update({ elements: [...state.playQueue.elements] });
	await wait();
	assert.deepEqual(queueIds(), [1, 8, 6]);
	assert.deepEqual(fetches, [8]);
});

test("ignores a fetch that returns a different track", async () => {
	const original = MediaItem.fromId;
	MediaItem.fromId = async () => ({ tidalItem: tracks[2] });
	try {
		setQueue([1, 77]);
		await wait();
		assert.deepEqual(queueIds(), [1, 77]);
	} finally {
		MediaItem.fromId = original;
	}
});

test("skip setting off leaves the current remix playing", async () => {
	settings.skipCurrent = false;
	plugin.onSettingsChanged();
	try {
		setQueue([2, 6, 4]);
		await wait();
		assert.equal(currentId(), 2);
		assert.deepEqual(queueIds(), [2, 6]);
	} finally {
		settings.skipCurrent = true;
	}
});

test("changing settings re-checks the queue", async () => {
	setQueue([1, 9, 6]);
	await wait();
	assert.deepEqual(queueIds(), [1, 9, 6]);
	settings.extraWords = "brother";
	plugin.onSettingsChanged();
	await wait();
	assert.deepEqual(queueIds(), [1, 6]);
	settings.extraWords = "";
	plugin.onSettingsChanged();
});

test("unloading mid-pass stops it touching the queue", async () => {
	setQueue([1, 6]);
	await wait();
	setQueue([1, 10, 10]); // 10 needs a slow fetch
	await wait(350); // pass has started and is waiting on the fetch
	assert.deepEqual(fetches, [10]);
	for (const unload of plugin.unloads) unload();
	await wait(500);
	assert.deepEqual(queueIds(), [1, 10, 10]);
	setQueue([1, 2]);
	await wait();
	assert.deepEqual(queueIds(), [1, 2]);
});
