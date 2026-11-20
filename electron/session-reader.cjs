const { createReadStream } = require('node:fs')

const READ_CHUNK_BYTES = 64 * 1024
const SMALL_LINE_CHARS = 256 * 1024
const MAX_METADATA_CHARS = 1024 * 1024
const METADATA_PATH = /^(?:type|timestamp|payload\.(?:type|id|thread_id|turn_id|model|thread_settings(?:\.(?:model|service_tier))?|(?:state\.)?collaboration_mode\.(?:model|settings\.model)|info\.(?:last_token_usage|total_token_usage)\.(?:input_tokens|cached_input_tokens|cache_write_input_tokens|cache_write_tokens|output_tokens|reasoning_output_tokens|total_tokens)))$/

let streamingModules
async function createLargeLineParser() {
  streamingModules ||= Promise.all([
    import('stream-json/core/parser.js'),
    import('stream-json/core/filters/filter.js'),
    import('stream-json/core/stringer.js'),
    import('stream-chain/core'),
  ])
  const [{ jsonParser }, { filter }, { stringer }, { fun, none }] = await streamingModules
  const parts = []
  let length = 0
  const project = fun(
    jsonParser({ packStrings: false, streamKeys: false, streamNumbers: false, maxPackedLength: MAX_METADATA_CHARS }),
    filter({ filter: METADATA_PATH }),
    stringer({ useKeyValues: true, useNumberValues: true }),
    (text) => {
      length += text.length
      if (length > MAX_METADATA_CHARS) throw new Error('Session usage metadata is too large.')
      parts.push(text)
      return none
    },
  )
  return {
    write: project,
    finish() {
      project(none)
      return parts.join('') || '{}'
    },
  }
}

async function readSessionFile(file, consume, size) {
  if (size === 0) return
  // Bound both reads and individual records; image/tool strings are never assembled.
  const input = createReadStream(file, { encoding: 'utf8', highWaterMark: READ_CHUNK_BYTES, end: size - 1 })
  let line = ''
  let largeLine = null
  let malformed = false

  async function append(fragment) {
    if (malformed) return
    if (!largeLine && line.length + fragment.length <= SMALL_LINE_CHARS) {
      line += fragment
      return
    }
    // Load the streaming parser only when a line actually needs it. Import/read
    // failures remain file errors; invalid JSON only discards the current line.
    if (!largeLine) largeLine = await createLargeLineParser()
    try {
      if (line) { largeLine.write(line); line = '' }
      largeLine.write(fragment)
    } catch {
      malformed = true
      line = ''
      largeLine = null
    }
  }

  function finishLine() {
    let text = line
    if (largeLine) {
      try { text = largeLine.finish() } catch { malformed = true }
    }
    // Keep the existing parser's per-line error reporting and recovery.
    consume(malformed ? '{' : text)
    line = ''
    largeLine = null
    malformed = false
  }

  try {
    for await (const chunk of input) {
      let offset = 0
      let newline
      while ((newline = chunk.indexOf('\n', offset)) !== -1) {
        await append(chunk.slice(offset, newline))
        finishLine()
        offset = newline + 1
      }
      if (offset < chunk.length) await append(chunk.slice(offset))
    }
    if (line || largeLine || malformed) finishLine()
  } finally { input.destroy() }
}

module.exports = { readSessionFile }
