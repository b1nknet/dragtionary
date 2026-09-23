const DEFAULT_SETTINGS = {
  enabled: true,
  autoLookup: true,
  targetLanguage: "ko"
};

const LANGUAGE_ALIASES = {
  "zh": "zh-CN",
  "zh-cn": "zh-CN",
  "zh-sg": "zh-CN",
  "zh-tw": "zh-TW",
  "zh-hk": "zh-TW",
  "pt-br": "pt",
  "pt-pt": "pt"
};

const cache = new Map();
const MAX_CACHE_SIZE = 150;

chrome.runtime.onInstalled.addListener(async () => {
  const saved = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  await chrome.storage.sync.set(saved);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "LOOKUP_SELECTION") return false;

  lookupSelection(message.text, message.targetLanguage)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "결과를 불러오지 못했습니다."
    }));

  return true;
});

async function lookupSelection(rawText, requestedTarget) {
  const text = String(rawText || "").replace(/\s+/g, " ").trim();
  const targetLanguage = normalizeLanguageCode(requestedTarget || "ko");

  if (!text) throw new Error("선택된 텍스트가 없습니다.");
  if (text.length > 2000) throw new Error("한 번에 2,000자까지 번역할 수 있습니다.");

  const cacheKey = `${targetLanguage}:${text}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const sourceLanguage = await detectLanguage(text);
  const isEnglishWord = /^[A-Za-z][A-Za-z'-]*$/.test(text);
  const [dictionary, translation] = await Promise.all([
    isEnglishWord ? fetchDictionary(text) : Promise.resolve(null),
    sourceLanguage === targetLanguage
      ? Promise.resolve(null)
      : translateText(text, sourceLanguage, targetLanguage)
  ]);

  if (!dictionary && !translation) {
    throw new Error("원문과 번역 언어가 같거나 사전 결과가 없습니다.");
  }

  const result = {
    query: text,
    sourceLanguage,
    targetLanguage,
    kind: isEnglishWord && dictionary ? "dictionary" : "translation",
    dictionary,
    translation
  };

  remember(cacheKey, result);
  return result;
}

async function detectLanguage(text) {
  const scriptGuess = guessLanguageByScript(text);
  if (scriptGuess) return scriptGuess;

  try {
    const result = await chrome.i18n.detectLanguage(text);
    const candidate = result?.languages?.find((item) => item.percentage >= 20)
      || result?.languages?.[0];
    if (candidate?.language && candidate.language !== "und") {
      return normalizeLanguageCode(candidate.language);
    }
  } catch (_error) {
    // Script-based fallback below keeps the feature usable offline from detection.
  }

  return "en";
}

function guessLanguageByScript(text) {
  if (/[가-힣]/u.test(text)) return "ko";
  if (/[ぁ-ゟ゠-ヿ]/u.test(text)) return "ja";
  if (/[\u4E00-\u9FFF]/u.test(text)) return "zh-CN";
  if (/[А-Яа-яЁё]/u.test(text)) return "ru";
  if (/[\u0600-\u06FF]/u.test(text)) return "ar";
  if (/[ก-๙]/u.test(text)) return "th";
  return null;
}

function normalizeLanguageCode(code) {
  const value = String(code || "en").trim();
  const lower = value.toLowerCase();
  if (LANGUAGE_ALIASES[lower]) return LANGUAGE_ALIASES[lower];
  return lower.split("-")[0];
}

async function fetchDictionary(word) {
  try {
    const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`;
    const response = await fetch(url);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Dictionary API 오류 (${response.status})`);

    const entries = await response.json();
    const entry = entries?.[0];
    if (!entry) return null;

    const phonetic = entry.phonetic
      || entry.phonetics?.find((item) => item.text)?.text
      || "";
    const audio = entry.phonetics?.find((item) => item.audio)?.audio || "";
    const meanings = (entry.meanings || []).slice(0, 3).map((meaning) => ({
      partOfSpeech: meaning.partOfSpeech || "",
      definitions: (meaning.definitions || []).slice(0, 2).map((item) => ({
        definition: item.definition || "",
        example: item.example || "",
        synonyms: (item.synonyms || []).slice(0, 4)
      }))
    })).filter((meaning) => meaning.definitions.length);

    return {
      word: entry.word || word,
      phonetic,
      audio: audio.startsWith("//") ? `https:${audio}` : audio,
      meanings
    };
  } catch (_error) {
    return null;
  }
}

async function translateText(text, sourceLanguage, targetLanguage) {
  const chunks = splitByUtf8Bytes(text, 450);
  const translatedChunks = [];
  let match = 1;

  for (const chunk of chunks) {
    const params = new URLSearchParams({
      q: chunk,
      langpair: `${sourceLanguage}|${targetLanguage}`
    });
    const response = await fetch(`https://api.mymemory.translated.net/get?${params}`);
    if (!response.ok) throw new Error(`번역 API 오류 (${response.status})`);

    const payload = await response.json();
    if (payload.quotaFinished) {
      throw new Error("오늘의 무료 번역 한도를 모두 사용했습니다.");
    }
    if (Number(payload.responseStatus) !== 200 || !payload.responseData?.translatedText) {
      throw new Error(payload.responseDetails || "번역 결과를 받지 못했습니다.");
    }

    translatedChunks.push(chooseTranslation(payload, chunk, targetLanguage));
    match = Math.min(match, Number(payload.responseData.match) || 0);
  }

  return {
    text: translatedChunks.join(" "),
    match
  };
}

function chooseTranslation(payload, sourceText, targetLanguage) {
  const primary = String(payload.responseData?.translatedText || "");
  if (/\s/u.test(sourceText.trim())) return primary;

  const scriptAwareLanguages = new Set(["ko", "ja", "zh-CN", "zh-TW", "ru", "ar", "th"]);
  if (!scriptAwareLanguages.has(targetLanguage)) return primary;

  const primaryMatch = Number(payload.responseData?.match) || 0;
  const candidates = (payload.matches || [])
    .filter((item) => String(item.translation || "").length > 0)
    .filter((item) => !/<[^>]+>/u.test(item.translation))
    .filter((item) => (Number(item.match) || 0) >= primaryMatch - 0.01)
    .map((item) => String(item.translation).trim());

  if (!candidates.length) return primary;
  const matchingScript = candidates.filter((value) => targetScriptRatio(value, targetLanguage) >= 0.45);
  const pool = matchingScript.length ? matchingScript : candidates;
  return pool.sort((a, b) => [...a].length - [...b].length)[0] || primary;
}

function targetScriptRatio(text, language) {
  const letters = [...text].filter((character) => /\p{L}/u.test(character));
  if (!letters.length) return 0;

  const patterns = {
    ko: /[가-힣]/u,
    ja: /[ぁ-ゟ゠-ヿ一-龯]/u,
    "zh-CN": /[\u3400-\u9FFF]/u,
    "zh-TW": /[\u3400-\u9FFF]/u,
    ru: /[А-Яа-яЁё]/u,
    ar: /[\u0600-\u06FF]/u,
    th: /[ก-๙]/u
  };
  const pattern = patterns[language];
  if (!pattern) return 1;
  return letters.filter((character) => pattern.test(character)).length / letters.length;
}

function splitByUtf8Bytes(text, maxBytes) {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return [text];

  const sentences = text.match(/[^.!?。！？\n]+[.!?。！？\n]*\s*/gu) || [text];
  const chunks = [];
  let current = "";

  const pushCurrent = () => {
    const value = current.trim();
    if (value) chunks.push(value);
    current = "";
  };

  for (const sentence of sentences) {
    if (encoder.encode(current + sentence).length <= maxBytes) {
      current += sentence;
      continue;
    }

    pushCurrent();
    if (encoder.encode(sentence).length <= maxBytes) {
      current = sentence;
      continue;
    }

    for (const character of sentence) {
      if (encoder.encode(current + character).length > maxBytes) pushCurrent();
      current += character;
    }
  }

  pushCurrent();
  return chunks;
}

function remember(key, value) {
  if (cache.size >= MAX_CACHE_SIZE) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
}
