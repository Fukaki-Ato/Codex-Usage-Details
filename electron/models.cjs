const OPENAI_MODEL_PATTERNS = [
  /^gpt-/i,
  /^o\d+(?:-|$)/i,
  /^codex-/i,
  /^chatgpt-/i,
  /^ft:(?:gpt-|o\d+(?:-|$)|codex-)/i,
]

function isOpenAiModel(value) {
  if (typeof value !== 'string') return false
  const model = value.trim()
  return model.length > 0 && OPENAI_MODEL_PATTERNS.some((pattern) => pattern.test(model))
}

module.exports = { isOpenAiModel }
