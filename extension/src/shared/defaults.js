// Shared default settings. Loaded as a classic script by content scripts and
// the popup, and imported for side effects by the background module.
globalThis.CS_DEFAULTS = Object.freeze({
  enabled: true,
  autoSolve: true,
  autoSubmit: false,

  // LLM provider: 'ollama' | 'huggingface' | 'openai' (any OpenAI-compatible server)
  provider: 'ollama',

  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'qwen2.5vl:7b',

  hfToken: '',
  hfModel: 'Qwen/Qwen2.5-VL-7B-Instruct',
  hfBaseUrl: 'https://router.huggingface.co/v1',

  openaiUrl: 'http://localhost:1234/v1',
  openaiKey: '',
  openaiModel: '',

  // Speech-to-text for reCAPTCHA audio challenges: 'none' | 'huggingface' | 'openai'
  sttProvider: 'none',
  hfSttModel: 'openai/whisper-large-v3',
  openaiSttModel: 'whisper-1',

  // Which solvers run
  solveText: true,
  solveMath: true,
  solveRecaptcha: true,
  solveHcaptcha: true,
  solveTurnstile: true,

  // reCAPTCHA: 'image' (vision LLM on tiles) or 'audio' (speech-to-text)
  recaptchaMode: 'image',
  // Grid strategy: 'tile' asks per tile (robust), 'grid' asks once with a numbered overlay (fast)
  gridStrategy: 'tile',

  maxRounds: 6,
  concurrency: 1, // Ollama processes one request at a time by default; raise for Hugging Face or GPU servers
  requestTimeoutMs: 300000, // CPU-only machines need ~1-2 min per image
  debug: false,
});
