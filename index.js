#!/usr/bin/env node

const fs = require('fs/promises');
const zlib = require('zlib');
const readline = require('readline');

const HEADER_TMP_FILE = '1-header.dat';
const BODY_TMP_FILE = '2-body.dat';
const FOOTER_TMP_FILE = '3-footer.dat';

const COMPRESSED_DATA_START = Buffer.from([0, 0, 1, 0, 0x78, 0x9c]);
const GOLD_MARKER = Buffer.from([0x35, 0xcf, 0xc8, 0x6e]);
const INFLUENCE_MARKER = Buffer.from([0x50, 0x3c, 0xa8, 0x4a]);
const PLAYER_SLOT_MARKERS = [
  Buffer.from([0xb8, 0x61, 0xf0, 0xf4]), // player slot #1
  Buffer.from([0x2e, 0x51, 0xf7, 0x83]), // player slot #2
  Buffer.from([0xd4, 0xab, 0x9f, 0x19]), // player slot #3
  Buffer.from([0x02, 0x30, 0xf9, 0x6d]), // player slot #4
  Buffer.from([0xa1, 0xa5, 0x9d, 0xf3]), // player slot #5
  Buffer.from([0x37, 0x95, 0x9a, 0x84]), // player slot #6
  Buffer.from([0x8d, 0xc4, 0x93, 0x1d]), // player slot #7
  Buffer.from([0x1b, 0xf4, 0x94, 0x6a]), // player slot #8
];
const LEADER_MARKER = Buffer.from([0x0f, 0xfb, 0x8c, 0xc1]);

/**
 * @typedef {Object} Player
 * @property {string} leader The leader name.
 * @property {number} goldPos Buffer position for gold treasury.
 * @property {number} influencePos Buffer position for accumulated influence.
 */

/**
 * @typedef {Object} SaveFileData
 * @property {Buffer} header Header part of the save file.
 * @property {Buffer} body Uncompressed body part of the save file.
 * @property {Buffer} footer Footer part of the save file.
 * @property {Array.<Player>} players - Array of player data.
 */

/**
 * @typedef {Object} MenuOption
 * @template T
 * @property {string} label The display text.
 * @property {T} value The value to return when selected.
 */

/**
 * @typedef {Object} CommandOptions
 * @property {string} saveFile Path to the save file.
 * @property {boolean} extract Flag for extract mode.
 * @property {boolean} stitch Flag for stitch mode.
 */

/**
 * Helper function that wraps rl.question in a promise.
 * @param {readline.Interface} rl Readline interface.
 * @param {string} query The query to display.
 * @returns {Promise<string>} Promise that resolves with the user's input.
 */
function questionAsync(rl, query) {
  return new Promise((resolve) => rl.question(query, resolve));
}

/**
 * Reads a Civ7Save file and returns a SaveFileData object.
 * @param {string} path Path to the save file.
 * @returns {Promise<SaveFileData>}
 */
async function readSaveFile(path) {
  const buffer = Buffer.from(await fs.readFile(path));
  if (buffer.subarray(0, 4).toString() !== 'CIV7') {
    throw new Error('Not a Civilization 7 save file.');
  }

  const compressedStart = buffer.indexOf(COMPRESSED_DATA_START);
  if (compressedStart === -1) {
    throw new Error('Invalid Civilization 7 save file format.');
  }

  const header = buffer.subarray(0, compressedStart);
  const [body, bytesRead] = readCompressedData(
    buffer.subarray(compressedStart),
  );
  const footer = buffer.subarray(compressedStart + bytesRead);

  const data = { header, body, footer };
  data.players = parsePlayers(data);
  return data;
}

// Default chunk size used with compressed data
let defaultChunkSize = 64 * 1024;

/**
 * Reads compressed data from a buffer and returns the decompressed data and
 * number of bytes read.
 * @param {Buffer} buffer Buffer containing compressed data.
 * @returns {[Buffer, number]}
 */
function readCompressedData(buffer) {
  const chunks = [];
  let pos = 0;
  let chunkSize = buffer.readUInt32LE(pos);
  pos += 4;
  defaultChunkSize = chunkSize; // set default chunk size to this
  while (chunkSize > 1) {
    chunks.push(buffer.subarray(pos, pos + chunkSize));
    pos += chunkSize;
    chunkSize = buffer.readUInt32LE(pos);
    pos += 4;
  }
  pos -= 4;
  // concatenate chunks and decompress
  const compressed = Buffer.concat(chunks);
  return [
    zlib.inflateSync(compressed, {
      finishFlush: zlib.constants.Z_SYNC_FLUSH,
    }),
    pos,
  ];
}

/**
 * Compresses the given data using the deflate algorithm.
 * @param {Buffer} data Data to compress.
 * @returns {Buffer} Compressed data with chunk headers.
 */
function compressData(data) {
  // use deflate algorithm
  const compressed = zlib.deflateSync(data, {
    finishFlush: zlib.constants.Z_SYNC_FLUSH,
  });

  let pos = 0;
  const chunks = [];

  const addLengthBytes = (len) => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(len);
    chunks.push(buf);
  };

  // add data in chunks
  while (pos + defaultChunkSize < compressed.length) {
    addLengthBytes(defaultChunkSize);
    chunks.push(compressed.subarray(pos, pos + defaultChunkSize));
    pos += defaultChunkSize;
  }

  // add the last chunk
  addLengthBytes(compressed.length - pos);
  chunks.push(compressed.subarray(pos));

  return Buffer.concat(chunks);
}

/**
 * Writes the combined header, compressed body, and footer to the specified
 * output file.
 * @param {{header: Buffer, body: Buffer, footer: Buffer}} data Save file data.
 * @param {string} output Output file path.
 * @returns {Promise<void>}
 */
async function writeFile(data, output) {
  const { header, body, footer } = data;
  const buffer = Buffer.concat([header, compressData(body), footer]);
  await fs.writeFile(output, buffer);
  console.log(`${output} rewritten.`);
}

/**
 * Reads a Civilization VII 24-bit value embedded in a 32-bit low-endian
 * integer. The value is stored in the 3 most significant bytes, with the least
 * significant byte used as a header for special cases.
 *
 * @param {Buffer} body The buffer that contains the data.
 * @param {number} pos The position in the buffer where the value is stored.
 * @returns {number} The extracted 24-bit integer.
 */
function readCiv24BitValue(body, pos) {
  // e.g. 00 FF FF 7F -> 0x7FFFFF
  const value = body.readUInt32LE(pos);
  const mainBody = value >> 8;

  // Civ VII custom format: first byte is FF when at max (i.e. +1 to the value).
  // e.g. FF FF FF 7F -> 0x800000
  // Get first byte, check if it is FF, and add 1 to the main body if so.
  const header = value & 0xff;

  return header === 0xff ? mainBody + 1 : mainBody;
}

/**
 * Writes a 24-bit value back into the body at the specified position. The value
 * is stored in the 3 most significant bytes of a 32-bit low-endian integer.
 *
 * @param {Buffer} body The buffer that contains the data.
 * @param {number} pos The position in the buffer where the value will be written.
 * @param {number} value The 24-bit integer to write back.
 * @returns {void}
 */
function writeCiv24BitValue(body, pos, value) {
  // Throw if the value is out of bounds.
  if (value < 0 || value > 0x800000) {
    throw new Error(
      'Value out of bounds. Must be between 0 and 8388608, inclusive.',
    );
  }

  // For values less than 0x800000, we can write the value directly.
  if (value < 0x800000) {
    body.writeUInt32LE(value << 8, pos);
    return;
  }

  // For values at 0x800000, we need to write a value of 0x7fffff with a header
  // of 0xff.
  body.writeUInt32LE(0x7fffffff, pos);
}

/**
 * Finds positions by scanning the buffer for a given marker and adding an
 * offset.
 * @param {Buffer} body Buffer to scan.
 * @param {Buffer} marker Marker to search for.
 * @param {number} offset Number of bytes to skip after the marker.
 * @param {number} max Maximum number of positions to return.
 * @returns {number[]} Array of positions.
 */
function findPositions(body, marker, offset, max) {
  const positions = [];
  let pos = 0;
  while (pos < body.length && positions.length < max) {
    pos = body.indexOf(marker, pos);
    if (pos === -1) break;
    pos += offset;
    positions.push(pos);
  }
  return positions;
}

/**
 * Extracts the leader name from the header given a player slot marker.
 * @param {Buffer} header Header buffer.
 * @param {Buffer} playerMarker Marker identifying the player slot.
 * @returns {string|null} The leader name without the "LEADER_" prefix, or null.
 * if not found.
 */
function getPlayerLeader(header, playerMarker) {
  const pos = header.indexOf(playerMarker);
  if (pos === -1) return null;
  let leaderPos = header.indexOf(LEADER_MARKER, pos);
  if (leaderPos === -1) return null;
  leaderPos += 20;
  const end = header.indexOf(0, leaderPos);
  if (end === -1) return null;
  // Remove the "LEADER_" prefix.
  return header.subarray(leaderPos, end).toString().substring(7);
}

/**
 * Parses player data from the header and body portions of the save file.
 * @param {{header: Buffer, body: Buffer}} data Save file data.
 * @returns {Array.<Player>} Array of player objects.
 */
function parsePlayers({ header, body }) {
  const goldPositions = findPositions(
    body,
    GOLD_MARKER,
    24,
    PLAYER_SLOT_MARKERS.length,
  );
  const influencePositions = findPositions(
    body,
    INFLUENCE_MARKER,
    24,
    PLAYER_SLOT_MARKERS.length,
  );
  return PLAYER_SLOT_MARKERS.map((marker, idx) => {
    const leader = getPlayerLeader(header, marker);
    if (!leader) return null;
    return {
      leader,
      goldPos: goldPositions[idx],
      influencePos: influencePositions[idx],
    };
  }).filter(Boolean);
}

/**
 * Displays a prompt menu, validates user input, and returns a promise that
 * resolves with the choice.
 * @param {readline.Interface} rl Readline interface.
 * @param {string} promptText Text to display as prompt.
 * @param {Array.<MenuOption>} options Array of menu option objects.
 * @param {boolean} allowBack If true, allows going back.
 * @returns {Promise<any>} The user's choice.
 */
async function promptMenu(rl, promptText, options, allowBack) {
  console.log('\n' + promptText);
  options.forEach((opt, index) => {
    console.log(`  (${index + 1}) ${opt.label}`);
  });
  if (allowBack) {
    console.log('  (b) Back');
  }
  const input = await questionAsync(rl, 'Enter your choice: ');
  if (allowBack && input.toLowerCase() === 'b') {
    return 'back';
  }
  const choice = parseInt(input, 10);
  if (isNaN(choice) || choice < 1 || choice > options.length) {
    console.error('Invalid selection. Please try again.');
    return await promptMenu(rl, promptText, options, allowBack);
  }
  return options[choice - 1].value;
}

/**
 * Edits a numeric value (gold or influence) for a given player.
 * @param {readline.Interface} rl Readline interface.
 * @param {SaveFileData} data Save file data.
 * @param {string} type Type of value ('gold' or 'influence').
 * @param {Player} player Player object containing the position key.
 * @returns {Promise<void>}
 */
async function editValue(rl, data, type, player) {
  /**
   * @type {{read: function(Buffer, number): number, write: function(Buffer, number, number), prompt: string, posKey: keyof Player}}
   */
  const config = {
    gold: {
      read: readCiv24BitValue,
      write: writeCiv24BitValue,
      prompt: 'gold treasury',
      posKey: 'goldPos',
    },
    influence: {
      read: readCiv24BitValue,
      write: writeCiv24BitValue,
      prompt: 'accumulated influence',
      posKey: 'influencePos',
    },
  }[type];

  const current = config.read(data.body, player[config.posKey]);
  const input = await questionAsync(
    rl,
    `Enter new amount for ${config.prompt} (${current}) between 0 and 8388608 (or 'b' to cancel): `,
  );
  if (input.toLowerCase() === 'b') {
    return;
  }
  const newValue = parseInt(input, 10);
  if (isNaN(newValue) || newValue < 0 || newValue > 8388608) {
    console.error('Error: value must be a number between 0 and 8388608.');
    return await editValue(rl, data, type, player);
  }
  config.write(data.body, player[config.posKey], newValue);
  console.log(`${config.prompt} updated to ${newValue} for ${player.leader}.`);
}

/**
 * Presents the player slot menu for editing a specific property.
 * @param {readline.Interface} rl Readline interface.
 * @param {SaveFileData} data Save file data.
 * @param {string} type Type of value to edit.
 * @returns {Promise<void>}
 */
async function playerMenu(rl, data, type) {
  const players = data.players;
  if (!players || players.length === 0) {
    console.error('No player data found.');
    return;
  }
  const options = players.map((player, index) => ({
    label: player.leader,
    value: index,
  }));
  const choice = await promptMenu(
    rl,
    `Select player slot to edit ${type}:`,
    options,
    true,
  );
  if (choice === 'back') {
    return;
  }
  await editValue(rl, data, type, players[choice]);
  // After editing, show the same player menu again.
  await playerMenu(rl, data, type);
}

/**
 * Displays the main menu for editing options or exiting the program.
 * @param {readline.Interface} rl Readline interface.
 * @param {SaveFileData} data Save file data.
 * @param {string} saveFile Path to the save file.
 * @returns {Promise<void>}
 */
async function mainMenu(rl, data, saveFile) {
  const options = [
    { label: 'Edit gold treasury', value: 'editGold' },
    { label: 'Edit accumulated influence', value: 'editInfluence' },
    { label: 'Save and exit', value: 'exit' },
    { label: 'Exit without saving', value: 'exitNoSave' },
  ];
  const choice = await promptMenu(
    rl,
    'Main Menu - Please select an option:',
    options,
    false,
  );
  if (choice === 'exit') {
    await writeFile(data, saveFile);
    rl.close();
  } else if (choice === 'exitNoSave') {
    const input = await questionAsync(
      rl,
      'Are you sure you want to exit without saving? (y/n): ',
    );
    if (input.toLowerCase() === 'y') {
      rl.close();
    } else {
      await mainMenu(rl, data, saveFile);
    }
  } else if (choice === 'editGold') {
    await playerMenu(rl, data, 'gold');
    await mainMenu(rl, data, saveFile);
  } else if (choice === 'editInfluence') {
    await playerMenu(rl, data, 'influence');
    await mainMenu(rl, data, saveFile);
  }
}

/**
 * Displays usage and help information for the save editor.
 * @returns {void}
 */
function printHelp() {
  console.log(`Usage: civ7-save-editor [options] savefile

Arguments:
  savefile  Path to the Civ7Save file.

Options:
 --extract  Extracts data from the save file. This will write three
            files: '${HEADER_TMP_FILE}', '${BODY_TMP_FILE}' and '${FOOTER_TMP_FILE}'
            in the same directory. These files contain uncompressed
            save file data.

 --stitch   Stitches the contents of '${HEADER_TMP_FILE}', '${BODY_TMP_FILE}'
            and '${FOOTER_TMP_FILE}' (generated by the --extract option) and
            rewrites given savefile with the combined content. This
            option requires the extracted files to exist in the same
            directory.`);
}

/**
 * Parses command line options and returns a CommandOptions object.
 * @returns {CommandOptions}
 */
function readOptions() {
  const args = process.argv.slice(2);

  const files = args.filter((arg) => !arg.startsWith('--'));
  if (files.length !== 1) {
    printHelp();
    process.exit(1);
  }

  return {
    saveFile: files[0],
    extract: args.includes('--extract'),
    stitch: args.includes('--stitch'),
  };
}

/**
 * Runs the save editor program with the provided options.
 * @param {CommandOptions} options - Options object from readOptions.
 * @returns {Promise<void>}
 */
async function run(options) {
  const { saveFile } = options;
  if (options.stitch) {
    // stitch mode, just combine files together
    const header = await fs.readFile(HEADER_TMP_FILE);
    const body = await fs.readFile(BODY_TMP_FILE);
    const footer = await fs.readFile(FOOTER_TMP_FILE);
    const data = { header, body, footer };
    await writeFile(data, saveFile);
    return;
  }

  const data = await readSaveFile(saveFile);
  if (options.extract) {
    // extract mode
    await fs.writeFile(HEADER_TMP_FILE, data.header);
    await fs.writeFile(BODY_TMP_FILE, data.body);
    await fs.writeFile(FOOTER_TMP_FILE, data.footer);
    console.log(
      `Files extracted: ${HEADER_TMP_FILE} ${BODY_TMP_FILE} ${FOOTER_TMP_FILE}`,
    );
    return;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  console.log('Create a backup of your save file before making any changes.');
  await mainMenu(rl, data, saveFile);
}

console.log(
  'Civ7 Save Editor v1.1.0 - https://github.com/iqqmut/civ7-save-editor',
);
run(readOptions()).catch((err) => {
  console.error(err);
});
