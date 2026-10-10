import { ReactiveStore } from "@luna/core";
import { LunaButtonSetting, LunaSettings, LunaSwitchSetting, LunaTextSetting } from "@luna/ui";
import React from "react";

import { onSettingsChanged } from ".";

export const settings = await ReactiveStore.getPluginStorage("NoRemix", {
	skipCurrent: true,
	notify: true,
	keepAnniversaryMixes: true,
	extraWords: "",
	allowWords: "",
	// Track ids you chose with right click -> "No Remix: allow this track" / "treat as a remix"
	allowedIds: "",
	remixIds: "",
});

const countIds = (ids: string) => ids.split(",").filter((id) => id.trim() !== "").length;

type WordSetting = "extraWords" | "allowWords";

/**
 * Shows how many tracks you picked with the right click menu, with a button to forget them.
 */
const ChoiceListSetting = ({ setting, title, desc }: { setting: "allowedIds" | "remixIds"; title: string; desc: string }) => {
	const [count, setCount] = React.useState(countIds(settings[setting]));
	// Right click choices can change while this is open
	React.useEffect(() => {
		const interval = setInterval(() => setCount(countIds(settings[setting])), 1000);
		return () => clearInterval(interval);
	}, [setting]);
	return (
		<LunaButtonSetting
			title={`${title} (${count})`}
			desc={desc}
			disabled={count === 0}
			onClick={() => {
				settings[setting] = "";
				setCount(0);
				onSettingsChanged();
			}}
			children="Clear"
		/>
	);
};

/**
 * Text box that only applies its value when you press Enter, click away or close the settings,
 * so a half typed word can't remove tracks from the queue.
 */
const WordListSetting = ({ setting, title, desc }: { setting: WordSetting; title: string; desc: string }) => {
	const [value, setValue] = React.useState(settings[setting]);
	// What you typed that isn't applied yet
	const typed = React.useRef<string | undefined>(undefined);
	const apply = () => {
		const text = typed.current;
		typed.current = undefined;
		if (text === undefined || settings[setting] === text) return;
		settings[setting] = text;
		onSettingsChanged();
	};
	// Closing the settings doesn't always count as clicking away
	React.useEffect(() => apply, [setting]);
	return (
		<LunaTextSetting
			title={title}
			desc={desc}
			value={value}
			onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
				setValue(e.target.value);
				typed.current = e.target.value;
			}}
			onBlur={apply}
			onKeyDown={(e: React.KeyboardEvent) => e.key === "Enter" && apply()}
		/>
	);
};

export const Settings = () => {
	const [skipCurrent, setSkipCurrent] = React.useState(settings.skipCurrent);
	const [notify, setNotify] = React.useState(settings.notify);
	const [keepAnniversaryMixes, setKeepAnniversaryMixes] = React.useState(settings.keepAnniversaryMixes);
	return (
		<LunaSettings>
			<LunaSwitchSetting
				title="Skip remix if it's playing"
				desc="If a remix starts playing (e.g. you clicked it directly) skip it"
				checked={skipCurrent}
				onChange={(_: unknown, checked?: boolean) => {
					setSkipCurrent((settings.skipCurrent = checked ?? false));
					onSettingsChanged();
				}}
			/>
			<LunaSwitchSetting
				title="Show notification"
				desc="Show a message when remixes are removed from the queue"
				checked={notify}
				onChange={(_: unknown, checked?: boolean) => setNotify((settings.notify = checked ?? false))}
			/>
			<LunaSwitchSetting
				title="Keep anniversary mixes"
				desc={`Keep new mixes of the original recording like "Come Together - 2019 Mix" or "Dolby Atmos Mix". Turn off to remove them too`}
				checked={keepAnniversaryMixes}
				onChange={(_: unknown, checked?: boolean) => {
					setKeepAnniversaryMixes((settings.keepAnniversaryMixes = checked ?? false));
					onSettingsChanged();
				}}
			/>
			<WordListSetting
				setting="extraWords"
				title="Extra words to remove"
				desc="Comma separated, press Enter to apply. Remixes, VIPs, DJ edits, club mixes, sped up, slowed, nightcore and many more are already built in"
			/>
			<WordListSetting
				setting="allowWords"
				title="Never remove tracks containing"
				desc="Comma separated, press Enter to apply. e.g. the name of a remixer you actually like"
			/>
			<ChoiceListSetting
				setting="allowedIds"
				title="Tracks you allowed"
				desc={`Right click a track -> "No Remix: allow this track" to always keep it`}
			/>
			<ChoiceListSetting
				setting="remixIds"
				title="Tracks you marked as remixes"
				desc={`Right click a track -> "No Remix: treat as a remix" to always remove it`}
			/>
		</LunaSettings>
	);
};
