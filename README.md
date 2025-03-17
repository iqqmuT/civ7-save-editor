# Civilization VII Save Editor

Tool to edit Civilization 7 save files. You can:

- Edit a player's gold.
- Edit a player's accumulated influence.
- Extract the raw uncompressed save data from the save file for editing in a hex editor.
- Stitch back the edited raw save data into a save file.

## Download

- **[Windows](https://github.com/iqqmuT/civ7-save-editor/releases/latest/download/civ7-save-editor-win.exe)**
- **[MacOS](https://github.com/iqqmuT/civ7-save-editor/releases/latest/download/civ7-save-editor-macos)**
- **[Linux](https://github.com/iqqmuT/civ7-save-editor/releases/latest/download/civ7-save-editor-linux)**

Run the downloaded executable in the command line or terminal, and pass the Civ7Save file as the first argument.

## Running With Node.js

If you have Node.js installed, this is the easiest way:

```shell
$ npx civ7-save-editor YourGame.Civ7Save
```

## Save File Location

- **Windows:** `%USERPROFILE%\Documents\My Games\Sid Meier's Civilization VII\Saves`
- **MacOS:** `~/Library/Application Support/Civilization VII/Saves`
- **Linux:** `~/My Games/Sid Meier's Civilization VII/Saves`
