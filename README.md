<p align="center">
  <img src="logo.svg" alt="" width="200">
</p>

<h1 align="center">hyperwave</h1>

<p align="center">
  <b>Hypercore over sound</b>
  <br>
  Replicate to everyone in earshot, broadcast invites as birdsong, music or Morse
</p>

<p align="center">
  no pairing &middot; no radios &middot; one transmission reaches every listener &middot;
  every block verified &middot; inaudible or musical &middot; runs on Bare
</p>

<p align="center">
  <a href="#modes">Modes</a> &middot;
  <a href="#how-it-works">How it works</a> &middot;
  <a href="#throughput">Throughput</a> &middot;
  <a href="#audio">Audio</a> &middot;
  <a href="#api">API</a>
</p>

> 🤖 **Vibe coded experiment.** Built quickly with an AI assistant to explore an idea. Expect rough edges and breaking changes, it is not ready for production use.

Any device with a speaker and a mic can join. A writer turns hypercore blocks into verified proofs and plays them into the room, every listener in earshot hears the same transmission, checks it against the core key and keeps it. Listeners that miss something ask with a tiny want or repair, and anyone who has the data can answer, so a room fills up together. It runs alongside your network and bluetooth replication, into the same cores.

```
  writer                                                   everyone in earshot
  core.proof() ─► frames + parity ─► speaker ))) ((( mic ─► core.applyProof()
               ◄───────── wants and repairs, control band ◄────────┘
```

Broadcasts carry small messages such as room invites. In a voice mode they are sung as birdsong or a music box, or tapped out in Morse, while replication carries on inaudibly underneath. Built on [bare-ggwave](https://github.com/holepunchto/bare-ggwave).

## Installation

```
npm i hyperwave
```

## Usage

```js
const Hyperwave = require('hyperwave')

const wave = new Hyperwave(audio, { mode: 'fast' }) // audio: streamx Duplex of f32le mono PCM

wave.join()
wave.on('connection', (conn) => conn.replicate(store))

wave.broadcast(invite) // one message for everyone in earshot
wave.on('broadcast', (message) => {})
```

The connection is the air shared with everyone listening, emitted once the audio is set up. `conn.replicate()` takes a corestore (every core it has open now or later) or a single core.

`examples/audio.js` is a macOS mic and speaker adapter built on `bare-ffmpeg`. `examples/demo.js` runs a writer and a reader:

```
bare examples/demo.js 4 256        # writer, 4 blocks of 256 bytes, prints the key
bare examples/demo.js <key>        # reader, in another process or on another device
MODE=duet BROADCAST='hello' bare examples/demo.js 4 256   # also sing a broadcast
```

## Modes

| mode                                         | replication bands                                          | broadcasts        | 1 KB end to end |
| -------------------------------------------- | ---------------------------------------------------------- | ----------------- | --------------- |
| `fast`                                       | data 2.1 - 10.7 kHz (custom), control 18.8 - 21.7 kHz      | on the data band  | 44 s, 23 B/s    |
| `standard`                                   | data 2.1 - 6.2 kHz, control 15.2 - 19.3 kHz (stock ggwave) | on the data band  | 85 s, 12 B/s    |
| `silent`                                     | one band, 18.8 - 21.7 kHz, inaudible to most people        | on the data band  | 116 s, 8.8 B/s  |
| `calm`, `trill`, `duet`, `chime`, `musicbox` | one band, 18.8 - 21.7 kHz, underneath the song             | sung              | 117 s, 8.7 B/s  |
| `morse`                                      | one band, 18.8 - 21.7 kHz, underneath the Morse            | Morse code, ASCII | as `silent`     |

Measured on a MacBook, speaker to its own mic, writer and reader as separate processes, 1 KB as 4 blocks of 256 B, with no resends.

In a song mode broadcasts are sung, so people hear something pleasant, while replication carries on inaudibly underneath:

| song       | sounds like                                   | 47 byte invite |
| ---------- | --------------------------------------------- | -------------- |
| `duet`     | two birds, low and high                       | 5.2 s          |
| `trill`    | one quick bird                                | 6.7 s          |
| `musicbox` | bell melody over an accompaniment, pentatonic | 12.8 s         |
| `calm`     | a slow, relaxed songbird                      | 17.4 s         |
| `chime`    | a single bell melody, pentatonic              | 21.4 s         |

`bare bench/song.js` renders each preset to `.demo/song-<preset>.wav` to listen to.

In `morse` mode broadcasts are plain Morse code, a 700 Hz tone at 20 words per minute by default, framed by the KA and AR prosigns. Anyone who knows Morse can read it by ear. Listeners receive the text upper case, with only what Morse can carry (letters, digits and common punctuation, but not `+`, which is the AR prosign). "Hello from hyperwave" takes 15 s at 20 wpm. `bare bench/morse.js "some text"` renders `.demo/morse-<wpm>wpm.wav`.

## How it works

**Bands.** A data band carries hypercore proofs: `core.proof()` encoded as hypercore's own `wire.data` message, applied with `core.applyProof()`. A control band carries small single frame messages, `ANNOUNCE` (I have length N), `WANT` (a missing range) and `REPAIR`. With two bands, wants never collide with long data transmissions. With one band, which is half duplex (nobody hears while they talk), senders listen before talking and leave a gap after each message for others to answer.

**Frames.** ggwave fixed-length frames of 16 bytes, no start or end markers: `[message id][index][k][crc8][12 byte shard]`. Each message is `k` frames plus Reed-Solomon parity frames, any `k` of them rebuild it. The crc drops frames ggwave's own correction repaired into the wrong bytes.

**Repair on demand.** A listener that stalls short of `k` frames sends a one frame `REPAIR`. The sender keeps its last 16 messages and answers with fresh parity frames, ahead of any queued data. One repair serves every listener that missed frames from that message, and listeners that hear an equal or bigger ask stay quiet.

**Adaptive parity.** A repair raises the sender's parity to what would have covered that listener, and it decays by 1% per message, down to 0.15.

**Push ahead.** A writer broadcasts the upgrade and new blocks as soon as it appends, and answering a want also sends the batch after it. Listeners only ask again once the data band has been quiet for a while.

**Morse.** Tone on and off times are measured in 5 ms blocks against an adaptive threshold, the noise floor averaged over quiet blocks only, and read as dots, dashes and gaps against the known speed. Blips much shorter than a dot are folded back into the silence.

**Songs.** Every symbol is a note: bird tweets (a glide into a held pitch, 2 - 8 kHz) or pentatonic bells with inharmonic partials so octaves never alias. A song opens with a signature call, then a header, then the message with a crc16 and Reed-Solomon parity. Listeners track each note's onset, so timing slips on real devices do not derail a song, and rebuild the least confident bytes.

## Throughput

Real speaker to mic, fixed-length frames, 12 of each:

| frame | airtime | audible decoded | ultrasound decoded | goodput  |
| ----- | ------- | --------------- | ------------------ | -------- |
| 16 B  | 0.51 s  | 12/12           | 12/12              | 31.3 B/s |
| 32 B  | 0.96 s  | 11/12           | 9/12               | ~28 B/s  |
| 64 B  | 1.92 s  | 6/12            | 6/12               | 16.7 B/s |

Simulated air (`bench/air.js`, noise bursts that wipe out whole frames), 8 blocks, B/s of block data:

| block | frame loss | fixed parity 0.25 | adaptive + repair (default) | repair only |
| ----- | ---------- | ----------------- | --------------------------- | ----------- |
| 256 B | 0 - 2%     | 12.0              | 11.9                        | 14.7        |
| 256 B | ~10-13%    | 11.6              | 11.7                        | 12.0        |
| 256 B | ~20%       | 3.5               | 10.5                        | 10.8        |
| 1 KB  | 0 - 2%     | 16.7              | 16.7                        | 20.4        |
| 1 KB  | ~10-12%    | 16.4              | 16.5                        | 15.7        |
| 1 KB  | ~20%       | 8.7               | 8.4                         | 12.9        |

Without any error correction, 10% frame loss slows 256 B blocks to a crawl (0.5 B/s) and stalls 1 KB blocks, since a message needs every one of its frames. Bigger blocks amortise the proof: a 32 B block is 176 B on air, a 1 KB block 1176 B.

Compared to BLE:

|                                                 | rate           |
| ----------------------------------------------- | -------------- |
| hyperwave `fast`, block data end to end         | ~23 B/s        |
| hyperwave `silent`                              | ~9 B/s         |
| BLE 4.2 - 5 in practice (typical, not measured) | ~10 - 100 KB/s |

Sound is roughly 500 to 10,000 times slower than BLE: 1 KB takes under a minute in `fast` mode and 10 - 100 ms over BLE. What sound buys is reach without pairing or radios, any device with a mic and a speaker in the room, and one transmission reaches every listener.

## Audio

`audio` is a streamx Duplex. Its readable side yields microphone PCM and its writable side plays PCM: 32-bit float little-endian, mono, at `sampleRate`. Writes should call back while there is room in the output buffer, which paces transmissions. The wave closes `audio` when it is closed.

The microphone must never drop audio. `examples/audio.js` polls every 2 ms because avfoundation only keeps about 10 ms pending: polling every 10 ms silently lost 4% of samples, enough to break most frames on the inaudible band.

On a MacBook the speaker to mic path stays within about ±10 dB of the 1 kHz level up to 22 kHz, which is what makes the 18.8 - 21.7 kHz band work. Phones vary.

## API

#### `const wave = new Hyperwave(audio, [options])`

```js
{
  mode: 'standard', // see Modes, picks the bands below
  protocol: 'AUDIBLE_FASTEST', // data band, overrides the mode
  controlProtocol: 'ULTRASOUND_FASTEST', // control band, null to share the data band
  volume: 50,
  voiceVolume: 0.3, // song or Morse level in a voice mode, leaves headroom for the data underneath
  wpm: 20, // Morse speed in words per minute
  sampleRate: 48000,
  frameSize: 16, // bytes per ggwave frame, up to 64
  fixed: true, // ggwave fixed-length frames, no start and end markers
  parity: 0.25, // parity frames per data frame, the starting point when adaptive
  adaptive: true, // raise parity when listeners ask for repairs, decay it otherwise
  backoff: 2000, // max random delay before a transmission, lets others suppress duplicates
  retry: 10000, // ask again after the data band has been quiet this long
  stall: 1500, // ask for repair frames after a partly received message is quiet this long
  holdoff: 1000, // do not talk while someone else was heard this recently
  gap: 0, // listening gap after each message, 2500 when sharing one band
  announceInterval: 60000,
  batch: 8, // blocks per want, and how far holders push ahead
  broadcastWindow: 30000 // a repeated broadcast within this window is not emitted again
}
```

#### `wave.join()`

Start listening and transmitting. Everyone in earshot is one room for now, so no topic is needed.

#### `wave.on('connection', (conn, info) => {})`

Emitted once the audio is set up. `info.protocols` lists the bands in use and `info.voice` the song preset or `morse`, if any.

#### `conn.replicate(store | core)`

Replicate a single core, or every core a corestore has open now or opens later.

#### `wave.broadcast(message)`

Send one message to everyone in earshot: sung in a song mode (up to 255 bytes), tapped out as Morse in `morse` mode (ASCII text), or as one message on the data band otherwise.

#### `wave.on('broadcast', (message) => {})`

A broadcast from someone else. Repeats and our own echo within `broadcastWindow` are dropped.

#### `wave.stats`

Frame and message counters per band.

#### `await wave.close()`

## Todo

- Detect the broadcast type. Today a listener only hears broadcasts in its own mode, for example a `duet` listener does not decode `calm` or `morse`. Listen for every voice and data band at once, and give each song preset its own signature call so the call says which preset follows. The mode would then only pick how we broadcast and replicate.

## License

Apache-2.0
