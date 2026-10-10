import { ReactiveStore } from "@luna/core";
import { LunaSettings, LunaSwitchSetting, LunaTextSetting } from "@luna/ui";
import React from "react";

import { onSettingsChanged } from ".";
import { qualifierWords, strongWords } from "./isRemix";

export const settings = await ReactiveStore.getPluginStorage("NoRemix", {
	skipCurrent: true,
	notify: true,
	keepAnniversaryMixes: true,
	extraWords: "",
	allowWords: "",
});

type WordSetting = "extraWords" | "allowWords";

/**
 * Text box that only applies its value when you press Enter or click away,
 * so a half typed word can't remove tracks from the queue.
 */
const WordListSetting = ({ setting, title, desc }: { setting: WordSetting; title: string; desc: string }) => {
	const [value, setValue] = React.useState(settings[setting]);
	const apply = () => {
		if (settings[setting] === value) return;
		settings[setting] = value;
		onSettingsChanged();
	};
	return (
		<LunaTextSetting
			title={title}
			desc={desc}
			value={value}
			onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
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
				desc={`Comma separated, press Enter to apply. Built in: ${[...strongWords, ...qualifierWords].join(", ")}`}
			/>
			<WordListSetting
				setting="allowWords"
				title="Never remove tracks containing"
				desc="Comma separated, press Enter to apply. e.g. the name of a remixer you actually like"
			/>
		</LunaSettings>
	);
};
