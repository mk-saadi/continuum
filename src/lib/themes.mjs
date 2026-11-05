// Theme picker registry. Palettes remain in index.css; mode only tunes materials.
export const themeGroups = [
	{
		heading: "Default",
		themes: [
			{
				id: "light",
				mode: "light",
				label: "Light",
				description: "Clean white · neutral gray · blue",
				swatches: ["#ffffff", "#f0f0f0", "#2563eb"],
			},
			{
				id: "dark",
				mode: "dark",
				label: "Dark",
				description: "Charcoal · neutral gray · blue",
				swatches: ["#1a1a1a", "#292929", "#5b9bff"],
			},
		],
	},
	{
		heading: "More looks",
		themes: [
			{
				id: "ember",
				mode: "light",
				label: "Ember Studio Light",
				description: "Parchment · mineral gray · burnt copper",
				swatches: ["#E9E8E0", "#F7F6F0", "#B85F3D"],
			},
			{
				id: "ember-dark",
				mode: "dark",
				label: "Ember Studio Dark",
				description: "Charcoal slate · smoky plum · warm amber",
				swatches: ["#131725", "#3c3545", "#efa26f"],
			},
			{
				id: "gruvbox",
				mode: "light",
				label: "Gruvbox Light",
				description: "Cream paper · red · olive green · mustard",
				swatches: ["#f9f5d7", "#e8dc8e", "#b57614"],
			},
			{
				id: "gruvbox-dark",
				mode: "dark",
				label: "Gruvbox Dark",
				description: "Near-black · red · banana green · mustard",
				swatches: ["#1d2021", "#43421a", "#fabd2f"],
			},
			{
				id: "lilac",
				mode: "light",
				label: "Lilac Lounge Light",
				description: "Soft lavender · airy lilac · violet",
				swatches: ["#faf7fe", "#eee0fb", "#956bd2"],
			},
			{
				id: "lilac-dark",
				mode: "dark",
				label: "Lilac Lounge Dark",
				description: "Deep plum · dusk purple · soft lilac",
				swatches: ["#1d1925", "#463552", "#c5a1f3"],
			},
			{
				id: "matcha",
				mode: "light",
				label: "Matcha Notebook Light",
				description: "Sage cream · fresh mint · forest green",
				swatches: ["#f1f8f1", "#dff2e4", "#268c70"],
			},
			{
				id: "matcha-dark",
				mode: "dark",
				label: "Matcha Notebook Dark",
				description: "Deep forest · moss green · mint",
				swatches: ["#14231f", "#32523e", "#8bdcb4"],
			},
			{
				id: "midnight-light",
				mode: "light",
				label: "Midnight Find Light",
				description: "Indigo paper · dark indigo text · rose & amber",
				swatches: ["#f6f6fb", "#d94b60", "#daa541"],
			},
			{
				id: "midnight-find",
				mode: "dark",
				label: "Midnight Find",
				description: "Deep indigo · lavender text · rose & yellow",
				swatches: ["#15172a", "#eb5e73", "#f3df6e"],
			},
			{
				id: "mochi",
				mode: "light",
				label: "Mochi Light",
				description: "Warm ivory · soft rose",
				swatches: ["#F7F0F2", "#FFFAFB", "#D95F89"],
			},
			{
				id: "mochi-dark",
				mode: "dark",
				label: "Mochi Dark",
				description: "Deep plum · muted mauve · rose",
				swatches: ["#211B23", "#2B222D", "#E982A3"],
			},
			{
				id: "onyx",
				mode: "light",
				label: "Onyx Light",
				description: "Crisp paper · graphite ink · petrol",
				swatches: ["#ffffff", "#0b0c0e", "#175a75"],
			},
			{
				id: "onyx-dark",
				mode: "dark",
				label: "Onyx Dark",
				description: "True black · graphite · ice blue",
				swatches: ["#000000", "#0b0b0d", "#8ecdf7"],
			},
			{
				id: "papaya",
				mode: "light",
				label: "Papaya Punch Light",
				description: "Warm cream · papaya orange · deep teal",
				swatches: ["#fff7ef", "#c4470f", "#0f7a6c"],
			},
			{
				id: "papaya-dark",
				mode: "dark",
				label: "Papaya Punch Dark",
				description: "Deep teal night · mango · hot pink",
				swatches: ["#0d1b19", "#ff8a3d", "#ff5c8a"],
			},
			{
				id: "solarized",
				mode: "light",
				label: "Solarized Light",
				description: "Cream paper · slate text · blue",
				swatches: ["#f7f0dc", "#c9e0e3", "#268bd2"],
			},
			{
				id: "solarized-dark",
				mode: "dark",
				label: "Solarized Dark",
				description: "Deep teal · slate text · blue",
				swatches: ["#00212b", "#155060", "#268bd2"],
			},
			{
				id: "tokyo",
				mode: "light",
				label: "Tokyo Night Light",
				description: "Fog gray · cool blue · cyan",
				swatches: ["#e1e2e7", "#f7f8fb", "#2e7de9"],
			},
			{
				id: "tokyo-dark",
				mode: "dark",
				label: "Tokyo Night Dark",
				description: "Midnight navy · periwinkle · violet",
				swatches: ["#1a1b26", "#2f3a63", "#7aa2f7"],
			},
		],
	},
];

export const themes = themeGroups.flatMap(group => group.themes);
export function themeModeFor(id) { return themes.find(theme => theme.id === id)?.mode || "dark"; }
export function applyTheme(root, id) {
	root.dataset.theme = id;
	root.dataset.themeMode = themeModeFor(id);
}
