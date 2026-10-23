/**
 * EMIL PATCH — Favoris & Navigation (Supabase + Firebase Hybride)
 * Ajoute le bouton ❤️ sur les cartes produit, les liens Mon Compte / Concours
 * et synchronise les favoris sur Supabase (principal) et Firebase (fallback).
 *
 * Installation : ajouter <script src="emil-patch.js"></script> avant </body> dans index.html
 */
(function () {
  'use strict';

  // ── CONFIG HYBRIDE ──
  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyA65BPcrGTDxZb-kGzTGcLKnTbZ4jcf-8k',
    authDomain: 'lempreinte-d-emil.firebaseapp.com',
    databaseURL: 'https://lempreinte-d-emil-default-rtdb.europe-west1.firebasedatabase.app',
    projectId: 'lempreinte-d-emil',
    storageBucket: 'lempreinte-d-emil.firebasestorage.app',
    messagingSenderId: '979069264735',
    appId: '1:979069264735:web:7a0dc52ffd296ac7a5ccea'
  };
  const SUPABASE_URL = 'https://qlddwmimgmrqnsfqrftd.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFsZGR3bWltZ21ycW5zZnFyZnRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk1NjExNDEsImV4cCI6MjEwNTEzNzE0MX0.wpE5jA-ssMkenHoQDp_eFB3tKFiV8WIv3jqn_USQfZo';

  let db = null;
  let supabase = null;
  let favorites = [];

  // ── SVG ICONS ──
  const SVG_HEART = `<svg viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px;"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
  const SVG_HEART_OUTLINE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
  const SVG_USER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;
  const SVG_TROPHY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"></path><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"></path><path d="M4 22h16"></path><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"></path><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"></path><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"></path></svg>`;

  // ── INITIALISATION ──
  function initFirebase() {
    try {
      if (typeof firebase === 'undefined') return false;
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.database();
      return true;
    } catch (e) {
      console.warn('[emil-patch] Firebase init:', e);
      return false;
    }
  }

  function initSupabase() {
    try {
      // Utilise le client déjà initialisé par index.html si disponible
      if (window.supabaseClient) { supabase = window.supabaseClient; return true; }
      if (typeof window.supabase === 'undefined') return false;
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      window.supabaseClient = supabase;
      return true;
    } catch (e) {
      console.warn('[emil-patch] Supabase init:', e);
      return false;
    }
  }

  // ── FAVORIS : LECTURE ──
  async function loadFavorites() {
    // 1. Local (immédiat)
    try {
      const v = localStorage.getItem('lemil_favorites');
      favorites = v ? JSON.parse(v) : [];
      if (!Array.isArray(favorites)) favorites = [];
    } catch (e) { favorites = []; }

    // 2. Remote (synchro multi-appareil)
    const user = getUser();
    if (!user || !user.id) return;

    // Supabase en priorité
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('clients_favorites')
          .select('product_id')
          .eq('client_phone', user.id);
        if (!error && data && data.length) {
          const remote = data.map(d => String(d.product_id));
          favorites = [...new Set([...favorites, ...remote])];
          saveLocal();
          return;
        }
      } catch (e) { console.warn('[emil-patch] Supabase load favorites:', e); }
    }

    // Firebase en fallback
    if (db) {
      try {
        const snap = await db.ref('clients/' + user.id + '/favorites').once('value');
        const val = snap.val();
        const remote = Array.isArray(val) ? val.map(String) : (val ? Object.values(val).map(String) : []);
        if (remote.length) {
          favorites = [...new Set([...favorites, ...remote])];
          saveLocal();
        }
      } catch (e) { console.warn('[emil-patch] Firebase load favorites:', e); }
    }
  }

  // ── FAVORIS : ÉCRITURE ──
  async function saveFavorites() {
    // 1. Local toujours
    saveLocal();
    // 2. Remote
    const user = getUser();
    if (!user || !user.id) return;

    // Supabase en priorité
    if (supabase) {
      try {
        // Supprime les anciens, réinsère tous
        await supabase.from('clients_favorites').delete().eq('client_phone', user.id);
        if (favorites.length) {
          const rows = favorites.map(pid => ({ client_phone: user.id, product_id: String(pid) }));
          await supabase.from('clients_favorites').insert(rows);
        }
      } catch (e) { console.warn('[emil-patch] Supabase save favorites:', e); }
    }

    // Firebase en fallback / miroir
    if (db) {
      try { await db.ref('clients/' + user.id + '/favorites').set(favorites); }
      catch (e) { console.warn('[emil-patch] Firebase save favorites:', e); }
    }
  }

  function saveLocal() {
    try { localStorage.setItem('lemil_favorites', JSON.stringify(favorites)); } catch (e) {}
  }

  // ── HELPERS ──
  function getUser() {
    try { return JSON.parse(localStorage.getItem('emil_user') || 'null'); }
    catch (e) { return null; }
  }

  function toggleFavorite(productId) {
    const id = String(productId);
    const idx = favorites.findIndex(f => String(f) === id);
    if (idx > -1) { favorites.splice(idx, 1); saveFavorites(); return false; }
    else { favorites.push(id); saveFavorites(); return true; }
  }

  function isFavorite(productId) {
    return favorites.some(f => String(f) === String(productId));
  }

  function toast(msg, icon = '✦') {
    if (typeof window.showToast === 'function') window.showToast(msg, icon);
  }

  // ── INJECTION : CŒURS SUR LES CARTES PRODUIT ──
  function injectHearts() {
    document.querySelectorAll('.product-card').forEach(card => {
      if (card.dataset.emilHeartInjected) return;
      card.dataset.emilHeartInjected = '1';
      const onclickAttr = card.getAttribute('onclick') || '';
      const match = onclickAttr.match(/openProduct\(['"]([^'"]+)['"]\)/);
      if (!match) return;
      const productId = match[1];
      const imgContainer = card.querySelector('.product-img');
      if (!imgContainer) return;
      if (imgContainer.querySelector('.emil-fav-heart')) return;

      const heart = document.createElement('button');
      heart.className = 'emil-fav-heart';
      heart.setAttribute('aria-label', 'Ajouter aux favoris');
      heart.title = 'Ajouter aux favoris';
      const isFav = isFavorite(productId);
      heart.innerHTML = isFav
        ? `<span style="color:#e74c3c">${SVG_HEART}</span>`
        : `<span style="color:var(--light)">${SVG_HEART_OUTLINE}</span>`;
      heart.style.cssText = `
        position:absolute;top:10px;right:10px;width:36px;height:36px;border-radius:50%;
        background:rgba(10,10,10,.75);backdrop-filter:blur(6px);
        display:flex;align-items:center;justify-content:center;
        cursor:pointer;transition:all .25s ease;z-index:5;
        border:1px solid rgba(201,168,76,.3);padding:0;
      `;
      heart.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const nowFav = toggleFavorite(productId);
        heart.innerHTML = nowFav
          ? `<span style="color:#e74c3c">${SVG_HEART}</span>`
          : `<span style="color:var(--light)">${SVG_HEART_OUTLINE}</span>`;
        heart.style.transform = 'scale(1.2)';
        setTimeout(() => heart.style.transform = '', 200);
        toast(nowFav ? 'Ajouté aux favoris' : 'Retiré des favoris', nowFav ? '❤️' : '🤍');
      });
      imgContainer.style.position = 'relative';
      imgContainer.appendChild(heart);
    });
  }

  // ── INJECTION : LIENS NAVBAR ──
  function injectNavLinks() {
    // Desktop
    const navLinks = document.getElementById('nav-main-links');
    if (navLinks && !navLinks.querySelector('[data-emil-patch-link]')) {
      const accountLink = document.createElement('button');
      accountLink.className = 'nav-main-link';
      accountLink.setAttribute('data-emil-patch-link', '1');
      accountLink.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;">${SVG_USER} Mon Compte</span>`;
      accountLink.onclick = () => window.location.href = 'mon-compte.html';
      navLinks.appendChild(accountLink);

      const concoursLink = document.createElement('button');
      concoursLink.className = 'nav-main-link';
      concoursLink.setAttribute('data-emil-patch-link', '1');
      concoursLink.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;">${SVG_TROPHY} Concours</span>`;
      concoursLink.style.color = 'var(--gold)';
      concoursLink.onclick = () => window.location.href = 'concours.html';
      navLinks.appendChild(concoursLink);
    }

    // Drawer mobile
    const drawer = document.getElementById('nav-drawer');
    if (drawer && !drawer.querySelector('[data-emil-patch-drawer-link]')) {
      const insertBefore = drawer.querySelector('.nav-drawer-divider:last-of-type') || drawer.lastElementChild;
      const concoursBtn = document.createElement('button');
      concoursBtn.className = 'nav-drawer-item';
      concoursBtn.setAttribute('data-emil-patch-drawer-link', '1');
      concoursBtn.innerHTML = `${SVG_TROPHY} <span style="margin-left:10px">Jeu Concours</span>`;
      concoursBtn.style.color = 'var(--gold)';
      concoursBtn.onclick = () => { if (typeof window.closeNavDrawer === 'function') window.closeNavDrawer(); window.location.href = 'concours.html'; };

      const accountBtn = document.createElement('button');
      accountBtn.className = 'nav-drawer-item';
      accountBtn.setAttribute('data-emil-patch-drawer-link', '1');
      accountBtn.innerHTML = `${SVG_USER} <span style="margin-left:10px">Mon Compte</span>`;
      accountBtn.onclick = () => { if (typeof window.closeNavDrawer === 'function') window.closeNavDrawer(); window.location.href = 'mon-compte.html'; };

      if (insertBefore && insertBefore.parentNode) {
        insertBefore.parentNode.insertBefore(concoursBtn, insertBefore);
        insertBefore.parentNode.insertBefore(accountBtn, insertBefore);
      } else {
        drawer.appendChild(concoursBtn);
        drawer.appendChild(accountBtn);
      }
    }
  }

  // ── OBSERVER (re-injection à chaque rendu) ──
  function observe() {
    let timeout = null;
    const observer = new MutationObserver(() => {
      clearTimeout(timeout);
      timeout = setTimeout(() => { injectHearts(); injectNavLinks(); }, 120);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── HANDLE ?product=xxx ──
  function handleProductParam() {
    const params = new URLSearchParams(window.location.search);
    const productId = params.get('product');
    if (productId && typeof window.openProduct === 'function') {
      setTimeout(() => { try { window.openProduct(productId); } catch (e) {} }, 800);
    }
  }

  // ── INIT ──
  async function init() {
    initFirebase();
    initSupabase();
    await loadFavorites();
    injectHearts();
    injectNavLinks();
    observe();
    handleProductParam();

    // Re-sync si l'utilisateur change (login sur une autre page)
    window.addEventListener('storage', (e) => {
      if (e.key === 'emil_user' || e.key === 'lemil_favorites') {
        loadFavorites().then(() => { injectHearts(); });
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 300));
  } else {
    setTimeout(init, 300);
  }

  // Expose API
  window.emilFavorites = {
    list: () => favorites,
    add: (id) => toggleFavorite(id),
    remove: (id) => toggleFavorite(id),
    has: (id) => isFavorite(id),
    sync: loadFavorites
  };
})();
