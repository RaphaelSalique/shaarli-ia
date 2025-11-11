const browserApi = typeof browser !== 'undefined' ? browser : chrome;

const form = document.getElementById('optionsForm');
const baseUrlInput = document.getElementById('shaarliBaseUrl');
const tokenInput = document.getElementById('shaarliApiToken');
const providerSelect = document.getElementById('aiProvider');
const mistralInput = document.getElementById('mistralApiKey');
const geminiInput = document.getElementById('geminiApiKey');
const providerFields = document.querySelectorAll('[data-provider-field]');
const statusEl = document.getElementById('optionsStatus');

const PROVIDER_META = {
  mistral: { field: 'mistralApiKey', label: 'Mistral' },
  gemini: { field: 'geminiApiKey', label: 'Gemini' }
};
const STORAGE_DEFAULTS = {
  shaarliBaseUrl: '',
  shaarliApiToken: '',
  mistralApiKey: '',
  geminiApiKey: '',
  aiProvider: 'mistral',
  defaultVisibility: 'public'
};

document.addEventListener('DOMContentLoaded', () => {
  restoreOptions();
  providerSelect.addEventListener('change', updateProviderFields);
});
form.addEventListener('submit', saveOptions);

async function restoreOptions() {
  const values = await browserApi.storage.local.get(STORAGE_DEFAULTS);
  baseUrlInput.value = values.shaarliBaseUrl || '';
  tokenInput.value = values.shaarliApiToken || '';
  mistralInput.value = values.mistralApiKey || '';
  geminiInput.value = values.geminiApiKey || '';
  providerSelect.value = values.aiProvider || STORAGE_DEFAULTS.aiProvider;
  const radio = form.querySelector(`input[name="visibility"][value="${values.defaultVisibility}"]`);
  if (radio) {
    radio.checked = true;
  }
  updateProviderFields();
}

async function saveOptions(event) {
  event.preventDefault();
  const payload = {
    shaarliBaseUrl: baseUrlInput.value.trim(),
    shaarliApiToken: tokenInput.value.trim(),
    mistralApiKey: mistralInput.value.trim(),
    geminiApiKey: geminiInput.value.trim(),
    aiProvider: providerSelect.value,
    defaultVisibility: form.elements['visibility'].value
  };
  if (!payload.shaarliBaseUrl || !payload.shaarliApiToken) {
    setStatus('URL Shaarli et secret API sont obligatoires.', true);
    return;
  }
  const providerMeta = PROVIDER_META[payload.aiProvider];
  if (providerMeta?.field && !payload[providerMeta.field]) {
    setStatus(`La clé API pour ${providerMeta.label} est requise.`, true);
    updateProviderFields();
    return;
  }
  await browserApi.storage.local.set(payload);
  setStatus('Options enregistrées ✅');
}

function updateProviderFields() {
  const activeProvider = providerSelect.value;
  let visibleCount = 0;
  providerFields.forEach((field) => {
    const shouldShow = field.dataset.providerField === activeProvider;
    field.hidden = !shouldShow;
    if (shouldShow) {
      visibleCount += 1;
    }
  });
  if (!visibleCount) {
    providerFields.forEach((field) => {
      field.hidden = false;
    });
  }
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? '#c0392b' : '#1b5e20';
}
