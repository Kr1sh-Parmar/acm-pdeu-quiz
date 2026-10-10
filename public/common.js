// Shared by host and player pages.
const SHAPES = [
  '<svg class="shape" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3 30 28H2z"/></svg>',
  '<svg class="shape" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2 30 16 16 30 2 16z"/></svg>',
  '<svg class="shape" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="14"/></svg>',
  '<svg class="shape" viewBox="0 0 32 32" aria-hidden="true"><rect x="3" y="3" width="26" height="26" rx="2"/></svg>',
];
const COLOR_NAMES = ['Red', 'Blue', 'Yellow', 'Green'];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const $ = (sel) => document.querySelector(sel);
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

const socket = io({ transports: ['websocket', 'polling'] });
const emit = (event, data) => new Promise((resolve) => socket.emit(event, data, resolve));
