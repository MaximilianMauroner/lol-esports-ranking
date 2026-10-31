# DPS source and evidence

rift-delta combines the LoL Esports Power Index and the former dps.lol project.
Both projects are by Maximilian Mauroner. The import receipt in `tools/dev/dps-import.json` records each original path and source hash.
The dps.lol GitHub repository has been deleted. Its original repository and issue links remain as historical identifiers and no longer resolve.

The damage lab uses patch-pinned formulas and inspectable expected values.
Its expected critical strikes are not a kill probability. A fixture, manual target, or synthetic test does not prove live game behavior.
Data Dragon has names, stats, recipes, and tooltips. It does not define every combat interaction.
Mechanics need independent validation against a named patch and retained evidence.

The original mechanics references include [Data Dragon 16.18.1](https://ddragon.leagueoflegends.com/cdn/16.18.1/data/en_US/),
[CommunityDragon 16.18 Yunara data](https://raw.communitydragon.org/16.18/game/data/characters/yunara/yunara.bin.json),
and the [League Wiki Yunara page](https://wiki.leagueoflegends.com/en-us/Yunara).
These references support independent formulas. They are not copied game code.
Riot Games owns the game assets and trademarks. Riot Games does not endorse this project.

Private match records and archives require server-side access controls.
Public ranking evidence does not grant access to private DPS cohorts.
Schema names, storage identifiers, archive formats, and production resource names persist independently of the product name.

The Inter font is bundled locally under the [SIL Open Font License](../public/licenses/inter-OFL.txt). The lab does not need an external font stylesheet to start.
