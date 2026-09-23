(() => {
  const HOST_ID = "drag-dictionary-extension-root";
  const DEFAULT_SETTINGS = {
    enabled: true,
    autoLookup: true,
    targetLanguage: "ko"
  };

  let settings = { ...DEFAULT_SETTINGS };
  let host;
  let shadow;
  let card;
  let activeRequest = 0;
  let lastText = "";
  let lastRect = null;

  chrome.storage.sync.get(DEFAULT_SETTINGS).then((saved) => {
    settings = { ...DEFAULT_SETTINGS, ...saved };
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "sync") return;
    for (const [key, change] of Object.entries(changes)) {
      settings[key] = change.newValue;
    }
    if (!settings.enabled || !settings.autoLookup) hideCard();
  });

  document.addEventListener("mouseup", (event) => {
    if (event.button !== 0 || isInsideWidget(event)) return;
    window.setTimeout(() => handleSelection(), 10);
  }, true);

  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape") {
      hideCard();
      return;
    }
    if (event.shiftKey || ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      window.setTimeout(() => handleSelection(), 10);
    }
  }, true);

  document.addEventListener("mousedown", (event) => {
    if (host && !isInsideWidget(event)) hideCard();
  }, true);

  window.addEventListener("scroll", (event) => {
    if (!isInsideWidget(event)) hideCard();
  }, { passive: true, capture: true });
  window.addEventListener("resize", hideCard, { passive: true });

  function handleSelection() {
    if (!settings.enabled || !settings.autoLookup) return;

    const active = document.activeElement;
    if (active && ["INPUT", "TEXTAREA"].includes(active.tagName)) return;

    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, " ").trim() || "";
    if (!text || selection.rangeCount === 0 || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    if (host && host.contains(range.commonAncestorContainer)) return;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return;

    if (text.length > 2000) {
      ensureWidget();
      lastRect = rect;
      renderError("한 번에 2,000자까지 번역할 수 있습니다.");
      placeCard(rect);
      return;
    }

    if (text === lastText && card?.classList.contains("is-visible")) return;
    lastText = text;
    lastRect = rect;
    lookup(text, rect);
  }

  async function lookup(text, rect) {
    ensureWidget();
    const requestId = ++activeRequest;
    renderLoading(text);
    placeCard(rect);

    try {
      const response = await chrome.runtime.sendMessage({
        type: "LOOKUP_SELECTION",
        text,
        targetLanguage: settings.targetLanguage
      });
      if (requestId !== activeRequest) return;
      if (!response?.ok) throw new Error(response?.error || "결과를 불러오지 못했습니다.");
      renderResult(response.data);
      window.requestAnimationFrame(() => placeCard(rect));
    } catch (error) {
      if (requestId !== activeRequest) return;
      renderError(error?.message || "결과를 불러오지 못했습니다.");
      window.requestAnimationFrame(() => placeCard(rect));
    }
  }

  function ensureWidget() {
    if (host?.isConnected) return;

    host = document.createElement("div");
    host.id = HOST_ID;
    shadow = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = WIDGET_STYLES;
    card = document.createElement("section");
    card.className = "card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "선택한 텍스트의 사전 및 번역 결과");
    card.addEventListener("mousedown", (event) => event.stopPropagation());
    card.addEventListener("mouseup", (event) => event.stopPropagation());
    shadow.append(style, card);
    document.documentElement.appendChild(host);
  }

  function renderLoading(text) {
    card.replaceChildren();
    card.className = "card is-visible";

    const header = element("div", "header");
    header.append(
      element("span", "eyebrow", "찾는 중"),
      closeButton()
    );
    const query = element("div", "query", text);
    const loading = element("div", "loading");
    loading.append(element("span", "spinner"), element("span", "loading-text", "뜻과 번역을 불러오고 있어요"));
    card.append(header, query, loading);
  }

  function renderResult(data) {
    card.replaceChildren();
    card.className = "card is-visible";

    const header = element("div", "header");
    const badgeText = data.kind === "dictionary" ? "DICTIONARY" : "TRANSLATION";
    header.append(element("span", "eyebrow", badgeText), closeButton());
    card.append(header);

    if (data.dictionary) {
      const wordLine = element("div", "word-line");
      wordLine.append(element("h2", "word", data.dictionary.word));
      if (data.dictionary.phonetic) {
        wordLine.append(element("span", "phonetic", data.dictionary.phonetic));
      }
      if (data.dictionary.audio) {
        const audioButton = element("button", "audio-button", "듣기");
        audioButton.type = "button";
        audioButton.setAttribute("aria-label", "영어 발음 듣기");
        audioButton.addEventListener("click", () => {
          const audio = new Audio(data.dictionary.audio);
          audio.play().catch(() => {});
        });
        wordLine.append(audioButton);
      }
      card.append(wordLine);
    } else {
      card.append(element("div", "query", data.query));
    }

    if (data.translation?.text) {
      const translation = element("div", "translation");
      translation.append(
        element("div", "section-label", `번역 · ${languageName(data.targetLanguage)}`),
        element("div", "translation-text", decodeEntities(data.translation.text))
      );
      card.append(translation);
    }

    if (data.dictionary?.meanings?.length) {
      const meanings = element("div", "meanings");
      for (const meaning of data.dictionary.meanings) {
        const group = element("div", "meaning-group");
        group.append(element("div", "part-of-speech", meaning.partOfSpeech));
        const list = document.createElement("ol");
        for (const item of meaning.definitions) {
          const row = document.createElement("li");
          row.append(element("div", "definition", item.definition));
          if (item.example) row.append(element("div", "example", `“${item.example}”`));
          list.append(row);
        }
        group.append(list);
        meanings.append(group);
      }
      card.append(meanings);
    }

    const footer = element("div", "footer");
    footer.append(
      element("span", "source", data.dictionary ? "Dictionary API + MyMemory" : "MyMemory"),
      copyButton(data.translation?.text || data.query)
    );
    card.append(footer);
  }

  function renderError(message) {
    card.replaceChildren();
    card.className = "card is-visible";
    const header = element("div", "header");
    header.append(element("span", "eyebrow error-label", "확인 필요"), closeButton());
    card.append(
      header,
      element("div", "error-message", message),
      element("div", "error-help", "인터넷 연결 또는 무료 API 사용량을 확인해 주세요.")
    );
  }

  function placeCard(rect) {
    if (!card || !rect) return;
    const gap = 10;
    const margin = 12;
    const width = Math.min(380, window.innerWidth - margin * 2);
    card.style.width = `${width}px`;
    const height = card.getBoundingClientRect().height || 180;

    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));

    let top = rect.bottom + gap;
    if (top + height > window.innerHeight - margin) top = rect.top - height - gap;
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));

    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  function closeButton() {
    const button = element("button", "close", "×");
    button.type = "button";
    button.setAttribute("aria-label", "닫기");
    button.addEventListener("click", hideCard);
    return button;
  }

  function copyButton(value) {
    const button = element("button", "copy", "복사");
    button.type = "button";
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(decodeEntities(value));
        button.textContent = "복사됨";
        window.setTimeout(() => { button.textContent = "복사"; }, 1200);
      } catch (_error) {
        button.textContent = "실패";
      }
    });
    return button;
  }

  function hideCard() {
    activeRequest += 1;
    lastText = "";
    if (card) card.classList.remove("is-visible");
  }

  function isInsideWidget(event) {
    return event.composedPath().some((node) => node === host);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function decodeEntities(value) {
    const textarea = document.createElement("textarea");
    textarea.innerHTML = String(value || "");
    return textarea.value;
  }

  function languageName(code) {
    const names = {
      ko: "한국어", en: "English", ja: "日本語", "zh-CN": "简体中文",
      "zh-TW": "繁體中文", es: "Español", fr: "Français", de: "Deutsch",
      pt: "Português", it: "Italiano", vi: "Tiếng Việt", th: "ไทย",
      id: "Bahasa Indonesia", ru: "Русский", ar: "العربية"
    };
    return names[code] || code;
  }

  const WIDGET_STYLES = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    .card {
      position: fixed;
      display: none;
      z-index: 2147483647;
      max-height: min(560px, calc(100vh - 24px));
      overflow: auto;
      padding: 18px;
      color: #172126;
      background: rgba(255, 255, 252, 0.98);
      border: 1px solid rgba(29, 73, 76, 0.14);
      border-radius: 18px;
      box-shadow: 0 22px 60px rgba(17, 45, 48, 0.22), 0 3px 12px rgba(17, 45, 48, 0.12);
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans KR", sans-serif;
      letter-spacing: -0.01em;
      overscroll-behavior: contain;
    }
    .card.is-visible { display: block; animation: enter 150ms ease-out; }
    @keyframes enter { from { opacity: 0; transform: translateY(5px) scale(.985); } }
    .header, .word-line, .footer { display: flex; align-items: center; }
    .header { justify-content: space-between; margin-bottom: 8px; }
    .eyebrow, .section-label {
      color: #21706f; font-size: 10px; font-weight: 800; letter-spacing: .12em;
    }
    .close {
      width: 28px; height: 28px; padding: 0; border: 0; border-radius: 50%;
      color: #657377; background: transparent; cursor: pointer; font: 22px/1 sans-serif;
    }
    .close:hover { color: #172126; background: #eef3f1; }
    .query { max-height: 70px; overflow: hidden; color: #3b474a; font-size: 15px; font-weight: 650; }
    .word-line { flex-wrap: wrap; gap: 9px; margin: 0 0 11px; }
    .word { margin: 0; color: #132f30; font: 760 24px/1.2 Georgia, "Times New Roman", serif; }
    .phonetic { color: #6f7c7e; font-size: 13px; }
    .audio-button, .copy {
      border: 1px solid #cddbd7; border-radius: 999px; color: #1c6664;
      background: #f4f8f6; cursor: pointer; font: 700 11px/1 sans-serif;
    }
    .audio-button { padding: 6px 9px; }
    .translation {
      margin: 2px 0 14px; padding: 13px 14px; border-radius: 12px;
      background: linear-gradient(135deg, #eaf5ef, #edf6f5);
    }
    .translation-text { margin-top: 5px; color: #173d3d; font-size: 17px; font-weight: 750; line-height: 1.45; }
    .meanings { padding-top: 2px; }
    .meaning-group + .meaning-group { margin-top: 12px; padding-top: 12px; border-top: 1px solid #e9eeec; }
    .part-of-speech { margin-bottom: 5px; color: #b15b3d; font: italic 700 12px/1.3 Georgia, serif; }
    ol { margin: 0; padding-left: 22px; }
    li { padding-left: 2px; }
    li + li { margin-top: 7px; }
    .definition { color: #2b3538; }
    .example { margin-top: 2px; color: #7a8587; font-size: 12px; }
    .footer { justify-content: space-between; margin-top: 15px; padding-top: 11px; border-top: 1px solid #e9eeec; }
    .source { color: #98a2a3; font-size: 10px; }
    .copy { padding: 7px 11px; }
    .copy:hover, .audio-button:hover { background: #e7f1ed; border-color: #a9c6bd; }
    .loading { display: flex; align-items: center; gap: 10px; padding: 18px 0 6px; color: #657377; }
    .spinner { width: 17px; height: 17px; border: 2px solid #dce7e3; border-top-color: #21706f; border-radius: 50%; animation: spin .75s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error-label { color: #a44b38; }
    .error-message { color: #713526; font-size: 15px; font-weight: 700; }
    .error-help { margin-top: 5px; color: #7a8587; font-size: 12px; }
    button:focus-visible { outline: 2px solid #21706f; outline-offset: 2px; }
    @media (prefers-color-scheme: dark) {
      .card { color: #e9f0ed; background: rgba(24, 31, 32, .98); border-color: #344648; box-shadow: 0 22px 60px rgba(0,0,0,.45); }
      .close { color: #aab6b6; } .close:hover { color: #fff; background: #303c3d; }
      .query, .definition { color: #d7e0dd; } .word { color: #eff8f5; }
      .translation { background: linear-gradient(135deg, #173c38, #183738); }
      .translation-text { color: #e0f2eb; } .meaning-group + .meaning-group, .footer { border-color: #334143; }
      .audio-button, .copy { color: #9ed0c5; background: #233536; border-color: #425554; }
    }
  `;
})();
