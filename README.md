<p align="center">
  <img src="logo.svg" alt="" width="200">
</p>

<h1 align="center">wave-replicator</h1>

<p align="center">
  <b>Hypercore over sound</b>
  <br>
  Replicate to everyone in earshot, broadcast invites with birdsong on top
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

Broadcasts carry small messages such as room invites, on the inaudible band with birdsong or bells playing on top for people, or as plain Morse code. Built on [bare-ggwave](https://github.com/holepunchto/bare-ggwave).

## Installation

```
npm i wave-replicator
```

## Usage

```js
const WaveReplicator = require('wave-replicator')

const wave = new WaveReplicator(audio, { mode: 'fast' }) // audio: streamx Duplex of f32le mono PCM

wave.join()
wave.on('connection', (conn) => conn.replicate(store))

wave.broadcast(invite) // one message for everyone in earshot, sound: 'keet' plays birds with it
wave.on('broadcast', (message) => {})
```

The connection is the air shared with everyone listening, emitted once the audio is set up. `conn.replicate()` takes a corestore (every core it has open now or later) or a single core.

`examples/audio.js` is a macOS mic and speaker adapter built on `bare-ffmpeg`. `examples/demo.js` runs a writer and a reader:

```
bare examples/demo.js 4 256        # writer, 4 blocks of 256 bytes, prints the key
bare examples/demo.js <key>        # reader, in another process or on another device
MODE=silent SOUND=keet BROADCAST='hello' bare examples/demo.js 4 256   # broadcast with birds
```

## Modes

| mode          | replication bands                                          | broadcasts                     | 1 KB end to end |
| ------------- | ---------------------------------------------------------- | ------------------------------ | --------------- |
| `fast`        | data 2.1 - 10.7 kHz (custom), control 18.8 - 21.7 kHz      | control band, inaudible        | 44 s, 23 B/s    |
| `standard`    | data 2.1 - 6.2 kHz, control 15.2 - 19.3 kHz (stock ggwave) | control band, ultrasound       | 85 s, 12 B/s    |
| `silent`      | one band, 18.8 - 21.7 kHz, inaudible to most people        | the same band                  | 116 s, 8.8 B/s  |
| `morse`       | one band, 18.8 - 21.7 kHz, underneath the Morse            | Morse code, readable by people | as `silent`     |
| `ofdm`        | data 2.1 - 10.7 kHz as OFDM, control 18.8 - 21.7 kHz       | control band, inaudible        | not measured    |
| `ofdm-silent` | one band, 18.8 - 21.7 kHz, as OFDM                         | the same band                  | 36 s, 28 B/s    |

Measured on a MacBook, speaker to its own mic, writer and reader as separate processes, 1 KB as 4 blocks of 256 B, with no resends (`ofdm-silent` took 35 to 55 s over three runs). `fast`, `silent` and `morse` share the inaudible band, so they hear each other's broadcasts. The `ofdm` modes use the same bands with a different modulation, so they only talk to each other.

## Sounds

A broadcast is data on the inaudible band, but people can hear something pleasant while it goes out. Pick a `sound` and it plays for as long as the broadcast is on air, starting with it. Listeners ignore it, it is only for people:

| sound      | sounds like                                                    |
| ---------- | -------------------------------------------------------------- |
| `keet`     | birdsong with Keet's notification whistle as one of its chirps |
| `calm`     | a slow, relaxed songbird                                       |
| `trill`    | one quick bird                                                 |
| `duet`     | two birds, low and high                                        |
| `musicbox` | bell melody over an accompaniment, pentatonic                  |
| `chime`    | a single bell melody, pentatonic                               |

Or pass your own mono f32 samples. `bare bench/song.js [seconds]` renders each sound to `.demo/song-<sound>.wav` to listen to, and `bare bench/broadcast.js [sound] [message]` renders a whole broadcast as the room hears it, the sound plus the inaudible data, and decodes it back.

In `morse` mode broadcasts are plain Morse code instead, a 700 Hz tone at 20 words per minute by default, framed by the KA and AR prosigns, so anyone who knows Morse can read it by ear. It takes and delivers strings, upper case and with only what Morse can carry (letters, digits and common punctuation, but not `+`, which is the AR prosign). "hello world" takes 10 s at 20 wpm. `bare bench/morse.js "some text"` renders `.demo/morse-<wpm>wpm.wav`.

## How it works

**Bands.** A data band carries hypercore proofs: `core.proof()` encoded as hypercore's own `wire.data` message, applied with `core.applyProof()`. A control band carries small single frame messages, `ANNOUNCE` (I have length N), `WANT` (a missing range) and `REPAIR`. With two bands, wants never collide with long data transmissions. With one band, which is half duplex (nobody hears while they talk), senders listen before talking and leave a gap after each message for others to answer.

**Frames.** ggwave fixed-length frames of 16 bytes, no start or end markers: `[message id][index][k][crc8][12 byte shard]`. Each message is `k` frames plus Reed-Solomon parity frames, any `k` of them rebuild it. The crc drops frames ggwave's own correction repaired into the wrong bytes.

**Repair on demand.** A listener that stalls short of `k` frames sends a one frame `REPAIR`. The sender keeps its last 16 messages and answers with fresh parity frames, ahead of any queued data. One repair serves every listener that missed frames from that message, and listeners that hear an equal or bigger ask stay quiet.

**Adaptive parity.** A repair raises the sender's parity to what would have covered that listener, and it decays by 1% per message, down to 0.15.

**Push ahead.** A writer broadcasts the upgrade and new blocks as soon as it appends, and answering a want also sends the batch after it. Listeners only ask again once the data band has been quiet for a while.

**OFDM.** The `ofdm` modes send each frame as one OFDM packet: dozens to hundreds of carriers at once instead of ggwave's few tones. A packet is a Schmidl-Cox preamble, which a receiver finds by the repeat between its two halves, then a known reference symbol, a header and the payload. Each carrier is DBPSK (DQPSK with `ofdmBits: 2`) against the same carrier in the symbol before, so the room's effect on every carrier cancels without a channel estimate. The payload is the 802.11 convolutional code with soft Viterbi decoding, spread over every carrier and symbol so a notch in the room's response turns into errors thin enough to correct. Symbols are 2048 samples with a 512 sample (10.7 ms) cyclic prefix: across a room, echoes arrive after 5 ms and ruin shorter ones. Frames are 128 bytes on the wide band and 64 on the inaudible one. DBPSK packets carry about 270 B/s raw on the wide band against ggwave's 62.5, and 100 B/s on the inaudible band against 22.7. `bare bench/ofdm.js` compares them over simulated rooms.

**Morse.** The 700 Hz level is measured in 5 ms blocks, and each burst of sound between silences is read whole. The tone threshold is picked from the burst itself, so it adapts to how loud the sender is. Over the air dots come out weaker than dashes, and echo stretches every tone and shortens every gap by the same amount, so dots and dashes are told apart by comparing tone lengths with each other, and gaps are corrected by the measured stretch. A message that ends with AR is delivered even if its opening KA was garbled.

**Broadcasts.** One message with 50% parity on the control band, sent ahead of queued data, with the sound starting as it goes on air. The Keet sound is birdsong the way birds sing it, short fast syllables repeated in little phrases that speed up, with Keet's notification whistle squeezed into one of its chirps.

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
| wave-replicator `fast`, block data end to end   | ~23 B/s        |
| wave-replicator `silent`                        | ~9 B/s         |
| BLE 4.2 - 5 in practice (typical, not measured) | ~10 - 100 KB/s |

Sound is roughly 500 to 10,000 times slower than BLE: 1 KB takes under a minute in `fast` mode and 10 - 100 ms over BLE. What sound buys is reach without pairing or radios, any device with a mic and a speaker in the room, and one transmission reaches every listener.

## Audio

`audio` is a streamx Duplex. Its readable side yields microphone PCM and its writable side plays PCM: 32-bit float little-endian, mono, at `sampleRate`. Writes should call back while there is room in the output buffer, which paces transmissions. The wave closes `audio` when it is closed.

The microphone must never drop audio. `examples/audio.js` polls every 2 ms because avfoundation only keeps about 10 ms pending: polling every 10 ms silently lost 4% of samples, enough to break most frames on the inaudible band.

On a MacBook the speaker to mic path stays within about ±10 dB of the 1 kHz level up to 22 kHz, which is what makes the 18.8 - 21.7 kHz band work. Phones vary.

## API

#### `const wave = new WaveReplicator(audio, [options])`

```js
{
  mode: 'standard', // see Modes, picks the bands below
  protocol: 'AUDIBLE_FASTEST', // data band, overrides the mode
  controlProtocol: 'ULTRASOUND_FASTEST', // control band, null to share the data band
  volume: 50,
  sound: null, // what people hear during a broadcast, see Sounds, or your own f32 samples
  soundVolume: 0.3, // sound level, leaves headroom for the data underneath
  morseVolume: 0.8, // Morse level, loud enough to carry, clips only where it overlaps data
  broadcastParity: 0.5, // parity for broadcasts on the control band
  wpm: 20, // Morse speed in words per minute
  ofdmBits: 1, // bits per OFDM carrier: 1 DBPSK, 2 DQPSK, twice as fast but less tolerant of echo
  ofdmFrameSize: 128, // bytes per OFDM frame, 128 on the wide band and 64 on the inaudible one by default
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
  announceInterval: 60000, // first announce of our length, doubling while nothing changes
  maxAnnounceInterval: 600000, // up to this, back to announceInterval on news or a peer catching up
  batch: 8 // blocks per want, and how far holders push ahead
}
```

#### `wave.join()`

Start listening and transmitting. Everyone in earshot is one room for now, so no topic is needed.

#### `wave.on('connection', (conn, info) => {})`

Emitted once the audio is set up. `info.protocols` lists the bands in use and `info.sound` the sound, if any.

#### `conn.replicate(store | core)`

Replicate a single core, or every core a corestore has open now or opens later.

#### `wave.broadcast(message)`

Send one message to everyone in earshot. A buffer, on the control band with the sound playing along, or a string tapped out as Morse in `morse` mode.

#### `wave.on('broadcast', (message) => {})`

A broadcast from someone else, a buffer, or a string in `morse` mode. Every broadcast is delivered, the same message sent twice arrives twice, and our own echo is dropped.

#### `wave.stats`

Frame and message counters per band.

#### `await wave.close()`

## Todo

- Listen on every band at once, so a `standard` listener also hears broadcasts sent on the inaudible band and the other way around.
- Test the inaudible band on phones, their speakers and mics often roll off around 19 - 20 kHz.

## License

Apache-2.0
