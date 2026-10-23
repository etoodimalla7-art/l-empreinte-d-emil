/**
 * EMIL PATCH — Favoris + Navbar
 * Ajoute le bouton ❤️ sur toutes les cartes produit,
 * le lien "Mon Compte" et "Concours" dans la navbar,
 * et synchronise les favoris avec Firebase.
 *
 * Installation : ajouter <script src="emil-patch.js"></script> avant </body> dans index.html
 */
(function () {
  'use strict';

  const FIREBASE_CONFIG = {
    apiKey: 'AIzaSyA65BPcrGTDxZb-kGzTGcLKnTbZ4jcf-8k',
    authDomain: 'lempreinte-d-emil.firebaseapp.com',
    databaseURL: 'https://lempreinte-d-emil-default-rtdb.europe-west1.firebasedatabase.app',
    projectId: 'lempreinte-d-emil',
    storageBucket: 'lempreinte-d-emil.firebasestorage.app',
    messagingSenderId: '979069264735',
    appId: '1:979069264735:web:7a0dc52ffd296ac7a5ccea'
  };

  let db = null;
  let favorites = [];

  // ── Init Firebase (reuse existing app) ──
  function initFB() {
    try {
      if (typeof firebase === 'undefined') return false;
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.database();
      return true;
    } catch (e) { console.warn('[emil-patch] Firebase init:', e); return false; }
  }

  // ── Load favorites from localStorage ──
  function loadFavorites() {
    try {
      const v = localStorage.getItem('lemil_favorites');
      favorites = v ? JSON.parse(v) : [];
      if (!Array.isArray(favorites)) favorites = [];
    } catch (e) { favorites = []; }
  }

  function saveFavorites() {
    try { localStorage.setItem('lemil_favorites', JSON.stringify(favorites)); } catch (e) {}
    // Sync to Firebase if user identified
    try {
      const user = JSON.parse(localStorage.getItem('emil_user') || 'null');
      if (db && user && user.id) {
        db.ref('clients/' + user.id + '/favorites').set(favorites).catch(() => {});
      }
    } catch (e) {}
  }

  // ── Toggle favorite ──
  function toggleFavorite(productId) {
    const id = String(productId);
    const idx = favorites.findIndex(f => String(f) === id);
    if (idx > -1) {
      favorites.splice(idx, 1);
      saveFavorites();
      return false;
    } else {
      favorites.push(id);
      saveFavorites();
      return true;
    }
  }

  function isFavorite(productId) {
    return favorites.some(f => String(f) === String(productId));
  }

  function toast(msg, icon = '✦') {
    if (typeof window.showToast === 'function') {
      window.showToast(msg, icon);
    } else {
      let t = document.getElementById('emil-patch-toast');
      if (!t) {
        t = document.createElement('div');
        t.id = 'emil-patch-toast';
        t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(100px);background:rgba(19,18,14,.97);border:1px solid rgba(201,168,76,.5);border-radius:10px;padding:14px 22px;font-size:13px;z-index:99999;transition:transform .4s;color:#F5F0E8;font-family:Jost,sans-serif;box-shadow:0 12px 34px rgba(0,0,0,.5)';
        document.body.appendChild(t);
      }
      t.textContent = (icon + ' ' + msg);
      setTimeout(() => t.style.transform = 'translateX(-50%) translateY(0)', 50);
      clearTimeout(window.__emilPatchToastT);
      window.__emilPatchToastT = setTimeout(() => t.style.transform = 'translateX(-50%) translateY(100px)', 3000);
    }
  }

  // ── Inject heart button on all product cards ──
  function injectHearts() {
    const cards = document.querySelectorAll('.product-card');
    cards.forEach(card => {
      if (card.dataset.emilHeartInjected) return;
      card.dataset.emilHeartInjected = '1';
      // Find product id from onclick attribute
      const onclickAttr = card.getAttribute('onclick') || '';
      const match = onclickAttr.match(/openProduct\(['"]([^'"]+)['"]\)/);
      if (!match) return;
      const productId = match[1];

      // Find the product-img container
      const imgContainer = card.querySelector('.product-img');
      if (!imgContainer) return;
      if (imgContainer.querySelector('.emil-fav-heart')) return;

      const heart = document.createElement('button');
      heart.className = 'emil-fav-heart';
      heart.setAttribute('aria-label', 'Ajouter aux favoris');
      heart.title = 'Ajouter aux favoris';
      const isFav = isFavorite(productId);
      heart.textContent = isFav ? '❤️' : '🤍';
      heart.style.cssText = `
        position:absolute;top:10px;right:10px;width:36px;height:36px;border-radius:50%;
        background:rgba(10,10,10,.75);backdrop-filter:blur(6px);
        display:flex;align-items:center;justify-content:center;font-size:16px;
        cursor:pointer;transition:all .25s ease;z-index:5;
        border:1px solid rgba(201,168,76,.3);
      `;
      heart.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        const nowFav = toggleFavorite(productId);
        heart.textContent = nowFav ? '❤️' : '🤍';
        heart.style.transform = 'scale(1.2)';
        setTimeout(() => heart.style.transform = '', 200);
        toast(nowFav ? 'Ajouté aux favoris' : 'Retiré des favoris', nowFav ? '❤️' : '🤍');
      });
      heart.addEventListener('mouseenter', () => { heart.style.background = 'rgba(231,76,60,.9)'; });
      heart.addEventListener('mouseleave', () => { heart.style.background = 'rgba(10,10,10,.75)'; });
      imgContainer.style.position = 'relative';
      imgContainer.appendChild(heart);
    });
  }

  // ── Inject nav links ──
  function injectNavLinks() {
    // Desktop nav main links
    const navLinks = document.getElementById('nav-main-links');
    if (navLinks && !navLinks.querySelector('[data-emil-patch-link]')) {
      const accountLink = document.createElement('button');
      accountLink.className = 'nav-main-link';
      accountLink.setAttribute('data-emil-patch-link', '1');
      accountLink.textContent = 'Mon Compte';
      accountLink.onclick = () => window.location.href = 'mon-compte.html';
      navLinks.appendChild(accountLink);

      const concoursLink = document.createElement('button');
      concoursLink.className = 'nav-main-link';
      concoursLink.setAttribute('data-emil-patch-link', '1');
      concoursLink.textContent = 'Concours';
      concoursLink.style.color = 'var(--gold)';
      concoursLink.onclick = () => window.location.href = 'concours.html';
      navLinks.appendChild(concoursLink);
    }

    // Nav drawer (mobile)
    const drawer = document.getElementById('nav-drawer');
    if (drawer && !drawer.querySelector('[data-emil-patch-drawer-link]')) {
      // Insert before the "Informations" section
      const infoSection = drawer.querySelector('.nav-drawer-section:not(#drawer-section-shop):not(#drawer-section-cats)');
      const insertBefore = infoSection && infoSection.textContent.trim().toLowerCase().includes('information')
        ? infoSection
        : drawer.querySelector('.nav-drawer-divider:last-of-type');

      const accountBtn = document.createElement('button');
      accountBtn.className = 'nav-drawer-item';
      accountBtn.setAttribute('data-emil-patch-drawer-link', '1');
      accountBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg><span>Mon Compte</span>';
      accountBtn.onclick = () => { if (typeof window.closeNavDrawer === 'function') window.closeNavDrawer(); window.location.href = 'mon-compte.html'; };

      const concoursBtn = document.createElement('button');
      concoursBtn.className = 'nav-drawer-item';
      concoursBtn.setAttribute('data-emil-patch-drawer-link', '1');
      concoursBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg><span>Jeu Concours</span>';
      concoursBtn.style.color = 'var(--gold)';
      concoursBtn.onclick = () => { if (typeof window.closeNavDrawer === 'function') window.closeNavDrawer(); window.location.href = 'concours.html'; };

      if (insertBefore && insertBefore.parentNode) {
        insertBefore.parentNode.insertBefore(concoursBtn, insertBefore);
        insertBefore.parentNode.insertBefore(accountBtn, insertBefore);
      } else {
        drawer.appendChild(accountBtn);
        drawer.appendChild(concoursBtn);
      }
    }
  }

  // ── Re-inject after renders ──
  function observe() {
    const observer = new MutationObserver(() => {
      injectHearts();
      injectNavLinks();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Handle URL param ?product=xxx (from mon-compte "Voir" button) ──
  function handleProductParam() {
    const params = new URLSearchParams(window.location.search);
    const productId = params.get('product');
    if (productId && typeof window.openProduct === 'function') {
      setTimeout(() => { try { window.openProduct(productId); } catch (e) {} }, 800);
    }
  }

  // ── Init ──
  function init() {
    initFB();
    loadFavorites();
    injectHearts();
    injectNavLinks();
    observe();
    handleProductParam();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 300));
  } else {
    setTimeout(init, 300);
  }

  // Expose for debugging
  window.emilFavorites = {
    list: () => favorites,
    add: (id) => toggleFavorite(id),
    remove: (id) => toggleFavorite(id),
    has: (id) => isFavorite(id)
  };
})();
