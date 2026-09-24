// Systematic Reed-Solomon erasure code over GF(256) with a Cauchy parity matrix.
// k data shards plus m parity shards, any k of them rebuild the data. k + m <= 256.

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)

for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x
  LOG[x] = i
  x <<= 1
  if (x & 0x100) x ^= 0x11d
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]

function mul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]
}

function inv(a) {
  return EXP[255 - LOG[a]]
}

// row r of the (k + m) x k encoding matrix: identity on top, Cauchy 1 / (x_i ^ y_j) below
function row(r, k) {
  const out = new Uint8Array(k)
  if (r < k) out[r] = 1
  else for (let j = 0; j < k; j++) out[j] = inv(r ^ j)
  return out
}

function combine(coefficients, shards, size) {
  const out = new Uint8Array(size)
  for (let j = 0; j < coefficients.length; j++) {
    const c = coefficients[j]
    if (c === 0) continue
    const shard = shards[j]
    for (let b = 0; b < size; b++) out[b] ^= mul(c, shard[b])
  }
  return out
}

// m parity shards, rows start..start+m-1, so more parity can be made later for the same data
exports.encode = function encode(data, m, start = data.length) {
  const k = data.length
  const size = data[0].byteLength
  const parity = []
  for (let i = 0; i < m; i++) parity.push(combine(row(start + i, k), data, size))
  return parity
}

// shards: Map of index -> shard, at least k entries, returns the k data shards
exports.decode = function decode(shards, k) {
  const indexes = [...shards.keys()].sort((a, b) => a - b).slice(0, k)
  if (indexes[k - 1] === k - 1) return indexes.map((i) => shards.get(i))

  const size = shards.get(indexes[0]).byteLength
  const matrix = indexes.map((i) => row(i, k))
  const inverse = invert(matrix, k)
  const received = indexes.map((i) => shards.get(i))

  const data = []
  for (let r = 0; r < k; r++) data.push(combine(inverse[r], received, size))
  return data
}

function invert(matrix, k) {
  const a = matrix.map((r) => Uint8Array.from(r))
  const out = []
  for (let i = 0; i < k; i++) out.push(row(i, k))

  for (let col = 0; col < k; col++) {
    let pivot = col
    while (a[pivot][col] === 0) pivot++
    ;[a[col], a[pivot]] = [a[pivot], a[col]]
    ;[out[col], out[pivot]] = [out[pivot], out[col]]

    const scale = inv(a[col][col])
    for (let j = 0; j < k; j++) {
      a[col][j] = mul(a[col][j], scale)
      out[col][j] = mul(out[col][j], scale)
    }

    for (let r = 0; r < k; r++) {
      if (r === col || a[r][col] === 0) continue
      const f = a[r][col]
      for (let j = 0; j < k; j++) {
        a[r][j] ^= mul(f, a[col][j])
        out[r][j] ^= mul(f, out[col][j])
      }
    }
  }

  return out
}
