const browserApi = typeof browser !== 'undefined' ? browser : chrome;

const form = document.getElementById('shareForm');
const titleInput = document.getElementById('title');
const urlInput = document.getElementById('url');
const descriptionInput = document.getElementById('description');
const tagsInput = document.getElementById('tags');
const privateToggle = document.getElementById('privateToggle');
const statusEl = document.getElementById('status');
const generateSummaryBtn = document.getElementById('generateSummary');
const refreshTagsBtn = document.getElementById('refreshTags');
const tagSuggestionsEl = document.getElementById('tagSuggestions');
const submitBtn = document.getElementById('submitShare');
const openOptionsBtn = document.getElementById('openOptions');
const MAX_TAG_RESULTS = 20;

let activeTabId = null;

document.addEventListener('DOMContentLoaded', initPopup);
generateSummaryBtn.addEventListener('click', handleGenerateSummary);
refreshTagsBtn.addEventListener('click', loadTagSuggestions);
form.addEventListener('submit', handleShare);
openOptionsBtn.addEventListener('click', () => browserApi.runtime.openOptionsPage());

async function initPopup() {
  try {
    const [tab] = await browserApi.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      activeTabId = tab.id;
      titleInput.value = tab.title || '';
      urlInput.value = tab.url || '';
    }
    await applyDefaultSettings();
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function applyDefaultSettings() {
  const settings = await browserApi.storage.local.get({
    defaultVisibility: 'public',
    shaarliBaseUrl: '',
    shaarliApiToken: ''
  });
  privateToggle.checked = settings.defaultVisibility === 'private';
  if (!settings.shaarliBaseUrl || !settings.shaarliApiToken) {
    setStatus('Configurez Shaarli avant de partager (⚙️).', true);
  } else {
    setStatus('Prêt à partager.');
  }
}

async function handleGenerateSummary() {
  try {
    toggleBusy(generateSummaryBtn, true);
    setStatus('Génération du résumé en cours…');
    const pageText = await capturePageExcerpt();
    const response = await browserApi.runtime.sendMessage({
      type: 'generateSummary',
      payload: {
        pageText,
        url: urlInput.value,
        title: titleInput.value
      }
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'Échec du résumé IA.');
    }
    descriptionInput.value = response.data.summary;
    setStatus('Résumé IA inséré.');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    toggleBusy(generateSummaryBtn, false);
  }
}

async function loadTagSuggestions() {
  const summary = descriptionInput.value.trim();
  if (!summary) {
    setStatus('Cliquez sur Résumé IA avant de charger les tags.', true);
    return;
  }
  try {
    toggleBusy(refreshTagsBtn, true);
    setStatus('Analyse des tags à partir du résumé…');
    const response = await browserApi.runtime.sendMessage({ type: 'fetchTags' });
    if (!response?.ok) {
      throw new Error(response?.error || 'Impossible de charger les tags.');
    }
    const rankedTags = rankTagsByRelevance(summary, response.data || [], titleInput.value);
    renderTagSuggestions(rankedTags);
    setStatus(
      rankedTags.length
        ? 'Tags pertinents suggérés.'
        : 'Aucun tag existant ne correspond au résumé.',
      rankedTags.length === 0
    );
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    toggleBusy(refreshTagsBtn, false);
  }
}

function renderTagSuggestions(tags) {
  tagSuggestionsEl.innerHTML = '';
  if (!tags.length) {
    const emptyState = document.createElement('p');
    emptyState.className = 'tag-empty';
    emptyState.textContent = 'Aucun tag pertinent détecté.';
    tagSuggestionsEl.appendChild(emptyState);
    return;
  }
  tags.slice(0, MAX_TAG_RESULTS).forEach((tag) => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'tag-pill';
    pill.textContent = `#${tag}`;
    pill.addEventListener('click', () => insertTag(tag));
    tagSuggestionsEl.appendChild(pill);
  });
}

function insertTag(tag) {
  const existing = parseTags(tagsInput.value);
  if (!existing.includes(tag)) {
    existing.push(tag);
  }
  tagsInput.value = existing.join(' ');
}

async function handleShare(event) {
  event.preventDefault();
  try {
    toggleBusy(submitBtn, true);
    setStatus('Envoi vers Shaarli…');
    const payload = {
      title: titleInput.value.trim(),
      url: urlInput.value.trim(),
      description: descriptionInput.value.trim(),
      tags: parseTags(tagsInput.value),
      isPrivate: privateToggle.checked
    };
    const response = await browserApi.runtime.sendMessage({
      type: 'shareLink',
      payload
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'Impossible de partager.');
    }
    setStatus('Partage réussi ✅');
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    toggleBusy(submitBtn, false);
  }
}

function parseTags(rawValue) {
  if (!rawValue) return [];
  return rawValue
    .split(/[,\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function toggleBusy(button, isBusy) {
  if (!button) return;
  button.disabled = isBusy;
}

function setStatus(message, isError = false) {
  statusEl.textContent = message || '';
  statusEl.style.color = isError ? '#c0392b' : '#1b5e20';
}

async function capturePageExcerpt() {
  if (!activeTabId) {
    return '';
  }

  if (browserApi.scripting?.executeScript) {
    const [{ result } = {}] = await browserApi.scripting.executeScript({
      target: { tabId: activeTabId },
      func: () => {
        const text = document.body?.innerText || '';
        return text.length > 6000 ? text.slice(0, 6000) : text;
      }
    });
    return result || '';
  }

  if (browserApi.tabs?.executeScript) {
    const [result] = await browserApi.tabs.executeScript(activeTabId, {
      code: `
        (function () {
          const text = document.body ? document.body.innerText || '' : '';
          return text.length > 6000 ? text.slice(0, 6000) : text;
        })();
      `
    });
    return result || '';
  }

  return '';
}

function rankTagsByRelevance(summary, tags, title = '') {
  if (!Array.isArray(tags) || !tags.length) {
    return [];
  }
  const context = `${title || ''} ${summary}`.toLowerCase();
  const tokens = tokenize(context);
  const tokenSet = new Set(tokens);
  return tags
    .map((tag) => {
      const normalizedTag = String(tag || '').trim();
      if (!normalizedTag) return null;
      const lowerTag = normalizedTag.toLowerCase();
      const tagParts = tokenize(lowerTag);
      let score = 0;
      if (context.includes(lowerTag)) {
        score += 4;
      }
      tagParts.forEach((part) => {
        if (tokenSet.has(part)) {
          score += 2;
        } else if (part && context.includes(part)) {
          score += 1;
        }
      });
      return { tag: normalizedTag, score };
    })
    .filter((entry) => entry && entry.score > 0)
    .sort((a, b) => {
      if (b.score === a.score) {
        return a.tag.localeCompare(b.tag);
      }
      return b.score - a.score;
    })
    .map((entry) => entry.tag);
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9éèêàùûüïîôç]+/i)
    .map((token) => token.trim())
    .filter(Boolean);
}
