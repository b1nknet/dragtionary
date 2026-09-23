const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const context = {
  console,
  TextEncoder,
  URLSearchParams,
  fetch,
  chrome: {
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener() {} }
    },
    storage: {
      sync: {
        async get() { return {}; },
        async set() {}
      }
    }
  }
};

vm.createContext(context);
vm.runInContext(fs.readFileSync("background.js", "utf8"), context);

assert.equal(context.normalizeLanguageCode("en-US"), "en");
assert.equal(context.normalizeLanguageCode("zh-TW"), "zh-TW");
assert.equal(context.guessLanguageByScript("안녕하세요"), "ko");
assert.equal(context.guessLanguageByScript("こんにちは"), "ja");

const chunks = context.splitByUtf8Bytes("가".repeat(400), 450);
assert.ok(chunks.length > 1);
assert.ok(chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 450));
assert.equal(chunks.join(""), "가".repeat(400));

const noisyHelloResponse = {
  responseData: { translatedText: "제 이름은 Azlan입니다.", match: 1 },
  matches: [
    { translation: "제 이름은 Azlan입니다.", match: 1 },
    { translation: "안녕하세요", match: 1 },
    { translation: "anyo", match: 0.99 }
  ]
};
assert.equal(context.chooseTranslation(noisyHelloResponse, "hello", "ko"), "안녕하세요");

const sentenceResponse = {
  responseData: { translatedText: "어떻게 지내세요?", match: 1 },
  matches: [{ translation: "지냅", match: 1 }]
};
assert.equal(context.chooseTranslation(sentenceResponse, "How are you?", "ko"), "어떻게 지내세요?");

console.log("background tests passed");
