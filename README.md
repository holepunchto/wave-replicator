<p align="center">
  <img src="logo.svg" alt="" width="200">
</p>

<h1 align="center">wave-replicator</h1>

<p align="center">
  <b>Broadcasts and hypercores over sound</b>
  <br>
  Walk into a room, broadcast your invite with birdsong on top, and everyone in earshot has it
</p>

<p align="center">
  no pairing &middot; no radios &middot; one transmission reaches every listener &middot;
  every block verified &middot; inaudible or musical &middot; runs on Bare
</p>

<p align="center">
  <a href="#broadcast">Broadcast</a> &middot;
  <a href="#morse">Morse</a> &middot;
  <a href="#replication">Replication</a> &middot;
  <a href="#how-it-works">How it works</a> &middot;
  <a href="#api">API</a>
</p>

> 🤖 **Vibe coded experiment.** Built quickly with an AI assistant to explore an idea. Expect rough edges and breaking changes, it is not ready for production use.

Any device with a speaker and a mic can join. Three features share the device's speaker and microphone, each on its own band, so none gets in another's way:

- **Broadcast** a small message, such as a Keet invite, to everyone in earshot, on an inaudible band with a sound on top for people.
- **Morse** a text message people can hear and read, and phones decode.
- **Replicate** the few small cores a room needs to get going, verified block by block. Once everyone has the invite they know the topic, and bluetooth and the network take it from there.

```
                  ┌─ Broadcast        18.8 - 21.7 kHz, inaudible, with a sound on top
speaker + mic ─ Air ─ MorseBroadcast   700 Hz
                  └─ WaveReplicator   2.1 - 10.7 kHz
```

## Installation

```
npm i wave-replicator
```

## Usage

```js
const Air = require('wave-replicator/air')
const Broadcast = require('wave-replicator/broadcast')
const MorseBroadcast = require('wave-replicator/morse')
const WaveReplicator = require('wave-replicator')

const air = new Air(audio) // audio: a streamx Duplex of f32le mono PCM, such as bare-pcm

const invites = new Broadcast(air, { sound: 'keet' })
invites.on('message', (invite) => {})
await invites.send(invite)

const morse = new MorseBroadcast(air)
morse.on('message', (text) => {})
await morse.send('hello world')

const wave = new WaveReplicator(air)
wave.join()
wave.on('connection', (conn) => conn.replicate(store))
```

`examples/demo.js` runs a writer that broadcasts its core's key and a listener that takes the key from the broadcast and replicates the core. `examples/audio.js` is a macOS mic and speaker for it, built on `bare-ffmpeg`:

```
bare examples/demo.js write 4     # 4 blocks, broadcasts the key
bare examples/demo.js listen      # in another process or on another device
```

## Broadcast

A broadcast is sent as a few copies, every copy carrying the same random id, so a room full of phones all get it however many of them talk at once:

- **Listen before talking.** Each copy waits a random backoff that only runs down while the band is quiet. A phone knows the band is taken within a few milliseconds, from its energy.
- **Copies.** 3 by default, 5 once 3 or more other phones have broadcast lately. Between copies it listens for a while, and the backoff window grows with the number of phones heard.
- **Dedupe by id.** Listeners deliver the first copy that decodes and drop the rest. A phone never hears its own. The same text from two phones is two broadcasts, and both arrive.
- **The sound.** A sound plays with each copy, as long as the copy is on air. People hear it, listeners ignore it.

In a simulated room of 10 phones at random places in 6 by 6 m (`bare bench/room.js`, 5 seeded trials each):

| senders at once          | everyone has every invite | copies sent until then, in all |
| ------------------------ | ------------------------- | ------------------------------ |
| 1                        | 5/5, in 5 to 9 s          | 1                              |
| 1, with 1 s mic dropouts | 5/5, in 5 to 13 s         | 1 to 2                         |
| 3                        | 5/5, in 6 to 10 s         | 3 to 5                         |
| 10                       | 5/5, in 16 to 36 s        | 15 to 35                       |

A copy of a 40 byte invite is 0.43 s of OFDM on the inaudible band. `GgwaveModem` (`wave-replicator/ggwave`) is a slower alternative, a single ggwave frame of up to 140 bytes, 5.3 s for 100 bytes, that holds up to more motion.

The sounds (`sound`) are:

| sound      | sounds like                                                    |
| ---------- | -------------------------------------------------------------- |
| `keet`     | birdsong with Keet's notification whistle as one of its chirps |
| `calm`     | a slow, relaxed songbird                                       |
| `trill`    | one quick bird                                                 |
| `duet`     | two birds, low and high                                        |
| `musicbox` | bell melody over an accompaniment, pentatonic                  |
| `chime`    | a single bell melody, pentatonic                               |

Or pass your own mono f32 samples. `bare bench/song.js` renders each sound to `.demo/song-<sound>.wav`, and `bare bench/broadcast.js [sound] [message]` renders a broadcast as the room hears it and decodes it back.

## Morse

A 700 Hz tone at 20 words per minute by default, framed by the KA and AR prosigns, loud enough to carry across a room. It takes strings and delivers them upper case, with only what Morse can carry (letters, digits and common punctuation, but not `+`, which is the AR prosign). It waits for the band to be quiet before it starts, and drops what it decodes while its own is on air, so two phones sending the same text both get through. "hello world" takes 10 s at 20 wpm. `bare bench/morse.js "some text"` renders `.demo/morse-<wpm>wpm.wav`.

The decoder reads each burst of sound between silences whole: the tone threshold comes from the burst itself, and dots and dashes are told apart by comparing tone lengths with each other, as over the air dots come out weaker than dashes and echo stretches every tone.

## Replication

A writer turns hypercore blocks into verified proofs and plays them into the room. Every listener in earshot hears the same transmission, checks it against the core key and keeps it. Listeners that miss something ask with a small want, anyone who has the data can answer, and holders push new blocks ahead, so a room fills up together. `conn.replicate()` takes a corestore (every core it has open now or later) or a single core, and it runs alongside your network and bluetooth replication, into the same cores.

It is for the few small cores a room needs to get going. In the simulated room, 1 KB as 4 blocks reaches 9 readers in 12 s of air.

Messages that fit one 256 byte packet go as they are, bigger ones as packets with 25% Reed-Solomon parity, any k of them rebuild the message. A want is outstanding until a deadline sized to its answer's airtime, then asked again with a doubled one. Hearing someone else ask for the same block cancels ours, and hearing an answer cancels anyone else about to send it.

## How it works

**Air.** Every feature is passed the same `Air`: a mixer with a soft limiter for what they play, the microphone for everyone who listens, and a clock counted in microphone samples. Timers run on that clock, so timing follows the audio, and the tests' simulated room (`test/helpers/space.js`) runs the same code faster than real time.

**OFDM.** Broadcasts and replication use OFDM: dozens to hundreds of carriers at once, 2048 sample symbols with a 10.7 ms cyclic prefix, so a room's echoes do not run one symbol into the next. A packet is a Schmidl-Cox preamble, found by the repeat between its two halves on the complex band signal, a known reference symbol, a header and the payload. Each carrier is DBPSK against the same carrier in the symbol before, and the payload is the 802.11 convolutional code with soft Viterbi decoding, spread over every carrier and symbol.

**Clock offsets and motion.** Two devices' clocks never agree exactly, and a phone moving in a hand shifts every frequency. The preamble and reference are both known, so the receiver measures how far each carrier turned between them, works out the offset, and resamples the packet to its own clock. Real recordings decode up to 300 ppm on the inaudible band and 1000 ppm on the wide one (`bare bench/doppler.js`), 100 ppm being 3.4 cm/s of motion.

**Throughput.** On a MacBook's speaker to its own mic, DBPSK packets carry 266 B/s on the wide band and 114 B/s on the inaudible one, against ggwave's 62.5 and 22.7. `bare bench/ofdm.js` compares them over simulated rooms.

## API

#### `const air = new Air(audio, [options])`

`audio` is a streamx Duplex: its readable side yields microphone PCM and its writable side plays PCM, 32-bit float little-endian mono. Air closes it when it is closed. The microphone must never drop audio.

```js
{
  sampleRate: 48000,
  latency: 0.25 // how long our own sound takes to come back through the microphone
}
```

#### `const invites = new Broadcast(air, [options])`

```js
{
  sound: null, // what people hear with each copy, see Broadcast, or your own f32 samples
  soundVolume: 0.3,
  copies: 3, // 5 once the room is busy
  window: 3, // the shortest backoff window, in seconds
  modem // OFDM on the inaudible band by default, or new GgwaveModem()
}
```

#### `await invites.send(payload)`

Resolves once the last copy has played. At most about 1 KB with OFDM, 140 bytes with ggwave, less a few bytes of header.

#### `invites.on('message', (payload, { id }) => {})`

Once per broadcast, never our own.

#### `invites.on('send-start' | 'send-end', ({ id, copy, seconds }) => {})`

As each copy of ours starts and stops playing. `copy` counts from 0, `seconds` is its time on air.

#### `invites.on('receive-start' | 'receive-end', () => {})`

Someone else's copy is on air: from when its header is read until it ends, whether it decoded or not. A `message` follows the end if it is a broadcast we had not heard yet. Our own copies coming back through the microphone are not reported.

#### `const morse = new MorseBroadcast(air, [options])`

```js
{
  wpm: 20,
  frequency: 700,
  volume: 0.8
}
```

#### `await morse.send(text)`

#### `morse.on('message', (text) => {})`

#### `morse.on('send-start' | 'send-end', ({ text, seconds }) => {})`

#### `morse.on('receive-start' | 'receive-end', () => {})`

A burst of sound at the Morse frequency, from its first tone until a word gap of quiet, then `message` if it read as Morse. Any sound near the frequency starts one, so not every burst ends in a message.

#### `const wave = new WaveReplicator(air, [options])`

```js
{
  batch: 8, // blocks per want, and how far holders push ahead
  announceInterval: 60, // seconds until the first announce of our length, doubling while nothing changes
  maxAnnounceInterval: 600
}
```

#### `wave.join()`

#### `wave.on('connection', (conn) => {})`

#### `conn.replicate(store | core)`

#### `wave.stats`

Packets and messages sent and received, and echoes dropped.

## Todo

- Test the inaudible band on more phones, their speakers and mics often roll off around 19 - 20 kHz.
- Measure clock offsets between phones held in a hand, and take OFDM on the inaudible band past 300 ppm.

## License

Apache-2.0
