const browserApi = typeof browser !== 'undefined' ? browser : chrome;

const STORAGE_DEFAULTS = {
  shaarliBaseUrl: '',
  shaarliApiToken: '',
  mistralApiKey: '',
  geminiApiKey: '',
  aiProvider: 'mistral',
  defaultVisibility: 'public'
};

const DEFAULT_AI_PROVIDER = 'mistral';
const SUMMARY_CONTEXT_LIMIT = 4000;
const SUMMARY_SYSTEM_PROMPT = 'Tu génères des résumés concis en français pour des partages Shaarli.';
const MISTRAL_ENDPOINT = 'https://api.mistral.ai/v1/chat/completions';
const MISTRAL_MODEL = 'mistral-small-latest';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent';
const TAG_SUGGESTION_COUNT = 15;
const TAG_SYSTEM_PROMPT =
  'Tu proposes des tags Shaarli concis (1 à 3 mots) en français ou en anglais selon ce qui est le plus pertinent, et tu renvoies uniquement une liste séparée par des virgules.';

const AI_PROVIDER_CONFIG = {
  mistral: { label: 'Mistral', keyField: 'mistralApiKey' },
  gemini: { label: 'Gemini', keyField: 'geminiApiKey' }
};

browserApi.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case 'generateSummary': {
          const response = await handleGenerateSummary(message.payload);
          sendResponse({ ok: true, data: response });
          break;
        }
        case 'fetchTags': {
          const tags = await fetchPreferredTags(message.payload);
          sendResponse({ ok: true, data: tags });
          break;
        }
        case 'shareLink': {
          const shareResponse = await shareLinkToShaarli(message.payload);
          sendResponse({ ok: true, data: shareResponse });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Message type inconnu' });
      }
    } catch (error) {
      console.error(error);
      sendResponse({ ok: false, error: error.message || 'Erreur inconnue' });
    }
  })();
  return true;
});

async function handleGenerateSummary(payload) {
  const { pageText = '', url = '', title = '' } = payload || {};
  const settings = await browserApi.storage.local.get(STORAGE_DEFAULTS);
  const provider = settings.aiProvider || DEFAULT_AI_PROVIDER;

  const prompt = buildSummaryPrompt({ pageText, url, title });
  const summary = await generateSummaryWithProvider(provider, prompt, settings);
  if (!summary) {
    throw new Error('Pas de résumé renvoyé par le fournisseur IA.');
  }
  return { summary };
}

function buildSummaryPrompt({ pageText, url, title }) {
  return [
    'Fais un court résumé de la page web courante, en un paragraphe pour un partage Shaarli.',
    `URL: ${url}`,
    `Titre: ${title}`,
    'Contenu de la page (tronqué):',
    truncateText(pageText, SUMMARY_CONTEXT_LIMIT)
  ].join('\n\n');
}

async function generateSummaryWithProvider(provider, prompt, settings) {
  switch (provider) {
    case 'gemini':
      return generateSummaryWithGemini(prompt, ensureProviderKey('gemini', settings));
    case 'mistral':
    default:
      return generateSummaryWithMistral(prompt, ensureProviderKey('mistral', settings));
  }
}

function ensureProviderKey(provider, settings) {
  const config = AI_PROVIDER_CONFIG[provider] || AI_PROVIDER_CONFIG[DEFAULT_AI_PROVIDER];
  const key = settings?.[config.keyField];
  if (!key) {
    throw new Error(`Configurez la clé API ${config.label} dans les options.`);
  }
  return key;
}

async function generateSummaryWithMistral(prompt, apiKey) {
  return callMistralChat({
    apiKey,
    prompt,
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    temperature: 0.2
  });
}

async function generateSummaryWithGemini(prompt, apiKey) {
  return callGeminiGenerativeModel({
    apiKey,
    prompt,
    systemPrompt: SUMMARY_SYSTEM_PROMPT
  });
}

async function callMistralChat({ apiKey, prompt, systemPrompt, temperature = 0.2 }) {
  const response = await fetch(MISTRAL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: MISTRAL_MODEL,
      temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ]
    })
  });
  if (!response.ok) {
    throw new Error(await buildProviderError('Mistral', response));
  }
  const data = await response.json();
  return sanitizeSummary(data?.choices?.[0]?.message?.content);
}

async function callGeminiGenerativeModel({ apiKey, prompt, systemPrompt }) {
  const url = new URL(GEMINI_ENDPOINT);
  url.searchParams.set('key', apiKey);
  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [{ text: `${systemPrompt}\n\n${prompt}` }]
        }
      ]
    })
  });
  if (!response.ok) {
    throw new Error(await buildProviderError('Gemini', response));
  }
  const data = await response.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((part) => part?.text || '').find((value) => value && value.trim())
    : '';
  return sanitizeSummary(text);
}

function sanitizeSummary(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function buildProviderError(providerLabel, response) {
  const base = `${providerLabel} a renvoyé ${response.status}`;
  const body = await safeReadText(response);
  if (!body) {
    return `${base}: ${response.statusText || 'Erreur inconnue'}`;
  }
  try {
    const parsed = JSON.parse(body);
    const message =
      parsed?.error?.message ||
      parsed?.error_description ||
      parsed?.message ||
      parsed?.error ||
      '';
    if (message) {
      return `${base}: ${message}`;
    }
  } catch (_err) {
    // body is not JSON, fall back to raw text below
  }
  return `${base}: ${body || response.statusText || 'Erreur inconnue'}`;
}

async function fetchPreferredTags(options = {}) {
  const settings = await browserApi.storage.local.get(STORAGE_DEFAULTS);
  if (!settings.shaarliBaseUrl || !settings.shaarliApiToken) {
    throw new Error('Configurez Shaarli (URL + jeton API) dans les options pour charger les tags.');
  }

  const aiCandidates = await generateAiTagCandidates(options, settings);
  const apiTags = await fetchTagsFromApi(settings, options);
  if (!apiTags.length) {
    throw new Error('Aucun tag disponible via l’API Shaarli.');
  }
  const sharedTags = computeSharedTags(apiTags, aiCandidates);
  return {
    tags: apiTags,
    sharedTags
  };
}

async function generateAiTagCandidates(context = {}, settings = {}) {
  const prompt = buildTagSuggestionPrompt(context);
  if (!prompt) {
    throw new Error('Générez d’abord un résumé pour proposer des tags IA.');
  }
  const provider = settings.aiProvider || DEFAULT_AI_PROVIDER;
  const rawTags = await generateTagsWithProvider(provider, prompt, settings);
  const parsedTags = parseAiTagList(rawTags);
  if (!parsedTags.length) {
    throw new Error('Le fournisseur IA n’a pas renvoyé de tags exploitables.');
  }
  return parsedTags;
}

function buildTagSuggestionPrompt(context = {}) {
  const title = context.title?.trim() || '';
  const url = context.url?.trim() || '';
  const summary = context.summary?.trim() || '';
  const pageText = context.pageText?.trim() || '';
  const content = summary || pageText;
  if (!content) {
    return '';
  }
  const sections = [
    `Analyse les informations suivantes et retourne au maximum ${TAG_SUGGESTION_COUNT} tags pertinents pour Shaarli.`
  ];
  if (title) {
    sections.push(`Titre: ${title}`);
  }
  if (url) {
    sections.push(`URL: ${url}`);
  }
  sections.push(`Résumé ou extrait:\n${truncateText(content, SUMMARY_CONTEXT_LIMIT)}`);
  sections.push('Format attendu: une liste de tags séparés par des virgules, sans commentaire.');
  return sections.join('\n\n');
}

async function generateTagsWithProvider(provider, prompt, settings) {
  switch (provider) {
    case 'gemini':
      return generateTagsWithGemini(prompt, ensureProviderKey('gemini', settings));
    case 'mistral':
    default:
      return generateTagsWithMistral(prompt, ensureProviderKey('mistral', settings));
  }
}

async function generateTagsWithMistral(prompt, apiKey) {
  return callMistralChat({
    apiKey,
    prompt,
    systemPrompt: TAG_SYSTEM_PROMPT,
    temperature: 0.1
  });
}

async function generateTagsWithGemini(prompt, apiKey) {
  return callGeminiGenerativeModel({
    apiKey,
    prompt,
    systemPrompt: TAG_SYSTEM_PROMPT
  });
}

async function fetchTagsFromApi(settings, options = {}) {
  const endpoint = new URL(buildShaarliApiUrl(settings.shaarliBaseUrl, '/api/v1/tags'));
  if (options.visibility) {
    endpoint.searchParams.set('visibility', options.visibility);
  }

  const authHeaders = await buildShaarliAuthHeaders(settings.shaarliApiToken);
  const response = await fetch(endpoint, {
    headers: {
      'Accept': 'application/json',
      ...authHeaders
    }
  });
  if (!response.ok) {
    throw new Error('API Shaarli indisponible.');
  }
  const data = await response.json();
  return normalizeTagsFromApiPayload(data);
}

function normalizeTagsFromApiPayload(payload) {
  if (!payload) return [];
  const tagsSource = Array.isArray(payload)
    ? payload
    : payload.tags ?? payload;

  if (Array.isArray(tagsSource)) {
    return tagsSource
      .map((entry) => {
        if (typeof entry === 'string') {
          return { value: entry, occurrences: 0 };
        }
        if (typeof entry === 'object' && entry) {
          return {
            value: entry.tag || entry.name || entry.value || '',
            occurrences: Number(entry.occurrences ?? entry.count ?? 0)
          };
        }
        return { value: '', occurrences: 0 };
      })
      .filter((entry) => Boolean(entry.value))
      .sort((a, b) => b.occurrences - a.occurrences)
      .map((entry) => entry.value);
  }

  if (typeof tagsSource === 'object') {
    return Object.keys(tagsSource);
  }

  return [];
}

function parseAiTagList(text) {
  if (!text) {
    return [];
  }
  const candidates = text
    .split(/[\n,;]+/)
    .map((entry) => entry.replace(/^[\s#*\-\d\.]+/, '').trim())
    .filter(Boolean);
  const seen = new Set();
  const results = [];
  candidates.forEach((candidate) => {
    const normalized = normalizeTagValue(candidate);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      results.push(normalized);
    }
  });
  return results.slice(0, TAG_SUGGESTION_COUNT);
}

function computeSharedTags(existingTags = [], aiCandidates = []) {
  if (!Array.isArray(existingTags) || !existingTags.length || !Array.isArray(aiCandidates) || !aiCandidates.length) {
    return [];
  }
  const normalizedMap = new Map();
  existingTags.forEach((tag) => {
    const normalized = normalizeTagValue(tag);
    if (normalized && !normalizedMap.has(normalized)) {
      normalizedMap.set(normalized, tag);
    }
  });
  const shared = [];
  const used = new Set();
  aiCandidates.forEach((candidate) => {
    const normalized = normalizeTagValue(candidate);
    if (normalized && normalizedMap.has(normalized) && !used.has(normalized)) {
      shared.push(normalizedMap.get(normalized));
      used.add(normalized);
    }
  });
  return shared;
}

async function shareLinkToShaarli(payload) {
  const { title, url, description, tags, isPrivate } = payload || {};
  if (!title || !url) {
    throw new Error('Titre et URL sont requis.');
  }
  const settings = await browserApi.storage.local.get(STORAGE_DEFAULTS);
  if (!settings.shaarliBaseUrl || !settings.shaarliApiToken) {
    throw new Error('Configurez Shaarli (URL + jeton API) dans les options.');
  }

  const endpoint = buildShaarliApiUrl(settings.shaarliBaseUrl, '/api/v1/links');
  const authHeaders = await buildShaarliAuthHeaders(settings.shaarliApiToken);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      ...authHeaders
    },
    body: JSON.stringify({
      url,
      title,
      description: description || '',
      tags: Array.isArray(tags) ? tags : [],
      private: Boolean(isPrivate)
    })
  });

  if (!response.ok) {
    const errorText = await safeReadText(response);
    throw new Error(`Shaarli a renvoyé ${response.status}: ${errorText || response.statusText}`);
  }
  return { status: 'shared' };
}

function buildShaarliApiUrl(baseUrl, path) {
  try {
    const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    const url = new URL(path.replace(/^\//, ''), normalized);
    return url.toString();
  } catch (_err) {
    throw new Error('URL Shaarli invalide.');
  }
}

function truncateText(text, maxLength) {
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch (_err) {
    return '';
  }
}

async function buildShaarliAuthHeaders(secret) {
  const token = await createShaarliJwt(secret);
  return {
    'Authorization': `Bearer ${token}`
  };
}

async function createShaarliJwt(secret) {
  if (!secret) {
    throw new Error('Jeton API Shaarli non configuré.');
  }
  const cryptoObj = getCrypto();
  if (!cryptoObj?.subtle) {
    throw new Error('crypto.subtle indisponible : impossible de signer le JWT Shaarli.');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ typ: 'JWT', alg: 'HS512' }));
  const payload = base64UrlEncode(JSON.stringify({ iat: now - 60, exp: now + 120 }));
  const key = await cryptoObj.subtle.importKey(
    'raw',
    getTextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign']
  );
  const signatureBuffer = await cryptoObj.subtle.sign('HMAC', key, getTextEncoder().encode(`${header}.${payload}`));
  const signature = base64UrlEncode(signatureBuffer);
  return `${header}.${payload}.${signature}`;
}

function base64UrlEncode(value) {
  const bytes = ensureUint8Array(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function ensureUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return getTextEncoder().encode(typeof value === 'string' ? value : String(value));
}

function normalizeTagValue(tag) {
  if (!tag) {
    return '';
  }
  let value = String(tag).trim().replace(/^#+/, '');
  if (typeof value.normalize === 'function') {
    value = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  return value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function getTextEncoder() {
  if (typeof TextEncoder === 'undefined') {
    throw new Error('TextEncoder indisponible dans ce navigateur.');
  }
  if (!getTextEncoder._instance) {
    getTextEncoder._instance = new TextEncoder();
  }
  return getTextEncoder._instance;
}

function getCrypto() {
  if (typeof globalThis !== 'undefined' && globalThis.crypto) {
    return globalThis.crypto;
  }
  if (typeof self !== 'undefined' && self.crypto) {
    return self.crypto;
  }
  if (typeof window !== 'undefined' && window.crypto) {
    return window.crypto;
  }
  return undefined;
}
