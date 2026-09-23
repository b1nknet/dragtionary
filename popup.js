const DEFAULT_SETTINGS = {
  enabled: true,
  autoLookup: true,
  targetLanguage: "ko"
};

const enabled = document.querySelector("#enabled");
const autoLookup = document.querySelector("#autoLookup");
const targetLanguage = document.querySelector("#targetLanguage");
const status = document.querySelector("#status");

initialize();

async function initialize() {
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  enabled.checked = settings.enabled;
  autoLookup.checked = settings.autoLookup;
  targetLanguage.value = settings.targetLanguage;

  enabled.addEventListener("change", save);
  autoLookup.addEventListener("change", save);
  targetLanguage.addEventListener("change", save);
}

async function save() {
  await chrome.storage.sync.set({
    enabled: enabled.checked,
    autoLookup: autoLookup.checked,
    targetLanguage: targetLanguage.value
  });
  status.textContent = "저장되었습니다";
  status.classList.add("saved");
  window.setTimeout(() => {
    status.textContent = "설정이 자동으로 저장됩니다";
    status.classList.remove("saved");
  }, 1300);
}
