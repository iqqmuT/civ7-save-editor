#!/usr/bin/env node

const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');

const HEADER_TMP_FILE = '1-header.dat';
const BODY_TMP_FILE = '2-body.dat';
const FOOTER_TMP_FILE = '3-footer.dat';

const COMPRESSED_DATA_START = Buffer.from([0, 0, 1, 0, 0x78, 0x9c]);
const GOLD_MARKER = Buffer.from([0x35, 0xcf, 0xc8, 0x6e]);
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

// Reads given Civ7Save file and returns object containing
// save data in 3 parts:
// - header: contains player data
// - body: uncompressed data
// - footer: end bytes
function readSaveFile(path) {
  const buffer = Buffer.from(fs.readFileSync(path));
  if (buffer.subarray(0, 4).toString() !== 'CIV7') {
    throw new Error('Not a Civilization 7 save file.');
  }

  const compressedStart = buffer.indexOf(COMPRESSED_DATA_START);
  if (compressedStart === undefined) {
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

// Returns array of players and their data.
function parsePlayers({ header, body }) {
  // detect gold positions in body data, ordered by player slots
  const goldPositions = findGold(body, PLAYER_SLOT_MARKERS.length);
  return PLAYER_SLOT_MARKERS.map((marker, playerIdx) => {
    const player = {
      goldPos: goldPositions[playerIdx],
    };
    // parse player data from header
    const pos = header.indexOf(marker);
    if (pos) {
      let leaderPos = header.indexOf(LEADER_MARKER, pos);
      if (leaderPos) {
        leaderPos += 20;
        // read string until null terminator and remove LEADER_ prefix
        player.leader = header
          .subarray(leaderPos, header.indexOf(0, leaderPos))
          .toString()
          .substring(7);
      }
    }
    return player;
  }).filter((player) => player.leader);
}

// (Over)writes Civ7Save file with given data parts.
// The second part will be compressed.
function writeFile(data, output) {
  const { header, body, footer } = data;
  const buffer = Buffer.concat([header, compressData(body), footer]);
  fs.writeFileSync(output, buffer);
  console.log(`${output} rewritten.`);
}

// Default chunk size used with compressed data
let defaultChunkSize = 64 * 1024;

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

// Returns gold positions where gold treasury is written for all players.
function findGold(body, max) {
  const positions = [];
  let pos = 0;
  while (pos < body.length && positions.length < max) {
    pos = body.indexOf(GOLD_MARKER, pos);
    if (!pos) {
      break;
    }
    pos += 24;
    positions.push(pos);
  }
  return positions;
}

// Reads gold treasury value from given position.
function readGold(body, pos) {
  return body.readUInt32LE(pos) / 256;
}

// Writes gold treasury value into given position.
function writeGold(body, gold, pos) {
  body.writeUInt32LE(gold * 256, pos);
}

function askGold(rl, data, saveFile, player) {
  const goldNow = parseInt(readGold(data.body, player.goldPos));
  rl.question(
    `Enter new amount for gold treasury (${goldNow}): `,
    (strAnswer) => {
      let answer = parseInt(strAnswer || goldNow);
      if (isNaN(answer)) {
        console.error('Error: value must be a number');
      } else {
        writeGold(data.body, answer, player.goldPos);
      }
      // go back to main menu
      printMainMenu(rl, data, saveFile);
    },
  );
}

function printMainMenu(rl, data, saveFile) {
  console.log('');
  console.log('Please select player slot or function:');
  console.log('   (0) Save and exit (default)');
  const { players } = data;
  players.forEach((player, idx) => {
    const leader = player.leader || 'unknown';
    console.log(`   (${idx + 1}) ${leader}`);
  });
  rl.question('Enter number: (0) ', (strAnswer) => {
    let answer = +strAnswer;
    if (answer === '' || isNaN(answer) || answer > players.length) {
      // invalid answer, retry
      printMainMenu(rl, data, saveFile);
    } else if (answer === 0) {
      // save & exit
      writeFile(data, saveFile);
      rl.close();
    } else {
      askGold(rl, data, saveFile, players[answer - 1]);
    }
  });
}

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

function run(options) {
  const { saveFile } = options;
  if (options.stitch) {
    // stitch mode, just combine files together
    const data = {
      header: Buffer.from(fs.readFileSync(HEADER_TMP_FILE)),
      body: Buffer.from(fs.readFileSync(BODY_TMP_FILE)),
      footer: Buffer.from(fs.readFileSync(FOOTER_TMP_FILE)),
    };
    writeFile(data, saveFile);
    return;
  }

  const data = readSaveFile(saveFile);
  if (options.extract) {
    // extract mode
    fs.writeFileSync(HEADER_TMP_FILE, data.header);
    fs.writeFileSync(BODY_TMP_FILE, data.body);
    fs.writeFileSync(FOOTER_TMP_FILE, data.footer);
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
  printMainMenu(rl, data, saveFile);
}

console.log(
  'Civ7 Save Editor v1.0.0 - https://github.com/iqqmut/civ7-save-editor',
);
run(readOptions());
