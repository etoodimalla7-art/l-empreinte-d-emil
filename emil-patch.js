/**
 * EMIL PATCH — Favoris + Parrainage + Zéro Refresh
 * Installation : ajouter <script src="emil-patch.js"></script> avant </body> dans index.html
 */
(function () {
  'use strict';

  const FIREBASE_CONFIG = { apiKey: 'AIzaSyA65BPcrGTDxZb-kGzTGcLKnTbZ4jcf-8k', authDomain: 'lempreinte-d-emil.firebaseapp.com', databaseURL: 'https://lempreinte-d-emil-default-rtdb.europe-west1.firebasedatabase.app', projectId: 'lempreinte-d-emil', storageBucket: 'lempreinte-d-emil.firebasestorage.app', messagingSenderId: '979069264735', appId: '1:979069264735:web:7a0dc52ffd296ac7a5ccea' };
  let db = null, favorites = [];

  const SVG_HEART = `<svg viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px;"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
  const SVG_HEART_OUTLINE = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
  const SVG_USER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`;
  const SVG_TROPHY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"></path><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"></path><path d="M4 22h16"></path><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"></path><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"></path><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"></path></svg>`;

  function initFB() { try { if (typeof firebase === 'undefined') return false; if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG); db = firebase.database(); return true; } catch (e) { return false; } }
  function getUser() { try { return JSON.parse(localStorage.getItem('emil_user') || 'null'); } catch (e) { return null; } }
  function saveLocal() { try { localStorage.setItem('lemil_favorites', JSON.stringify(favorites)); } catch (e) {} }
  function toast(msg, icon = '✦') { if (typeof window.showToast === 'function') window.showToast(msg, icon); }

  async function loadFavorites() {
    try { const v = localStorage.getItem('lemil_favorites'); favorites = v ? JSON.parse(v) : []; if (!Array.isArray(favorites)) favorites = []; } catch (e) { favorites = []; }
    const user = getUser(); if (!user || !user.id || !db) return;
    try { const snap = await db.ref('clients/' + user.id + '/favorites').once('value'); const val = snap.val(); const remote = Array.isArray(val) ? val.map(String) : (val ? Object.values(val).map(String) : []); if (remote.length) { favorites = [...new Set([...favorites, ...remote])]; saveLocal(); } } catch (e) {}
  }

  async function saveFavorites() {
    saveLocal(); const user = getUser(); if (!user || !user.id || !db) return;
    try { await db.ref('clients/' + user.id + '/favorites').set(favorites); } catch (e) {}
  }

  function toggleFavorite(productId) {
    const id = String(productId); const idx = favorites.findIndex(f => String(f) === id);
    if (idx > -1) { favorites.splice(idx, 1); saveFavorites(); return false; } else { favorites.push(id); saveFavorites(); return true; }
  }
  function isFavorite(productId) { return favorites.some(f => String(f) === String(productId)); }

  // ═══════════════════════════════════════════════════════════
  // LOGIQUE DE PARRAINAGE (AUTOMATIQUE À L'ARRIVÉE)
  // ═══════════════════════════════════════════════════════════
  async function checkReferral() {
    const urlParams = new URLSearchParams(window.location.search);
    const refCode = urlParams.get('ref');
    if (!refCode || !db) return;

    // Si on a déjà traité ce parrainage sur cet appareil, on ne fait rien
    if (localStorage.getItem('emil_ref_processed_' + refCode)) return;

    const user = getUser();
    // L'utilisateur doit être connecté sur le site pour valider le parrainage
    if (!user || !user.id) return;
    if (refCode === 'EMIL-' + user.id) return; // On ne peut pas se parrainer soi-même

    try {
      // 1. Récupérer les règles de points depuis Firebase
      const cfgSnap = await db.ref('referralsConfig').once('value');
      const cfg = cfgSnap.val() || { ptsParrain: 500, ptsFilleul: 200 };
      
      const parrainId = refCode.replace('EMIL-', '');

      // 2. Vérifier si ce filleul a déjà été parrainé
      const existing = await db.ref('referrals_history/' + parrainId).orderByChild('filleulId').equalTo(user.id).once('value');
      if (existing.val()) {
        localStorage.setItem('emil_ref_processed_' + refCode, '1');
        return; // Déjà parrainé
      }

      // 3. Attribuer les points au Parrain
      const pSnap = await db.ref('referrals/' + parrainId + '/points').once('value');
      const currentPtsParrain = pSnap.val() || 0;
      await db.ref('referrals/' + parrainId + '/points').set(currentPtsParrain + cfg.ptsParrain);

      // 4. Attribuer les points au Filleul
      const fSnap = await db.ref('referrals/' + user.id + '/points').once('value');
      const currentPtsFilleul = fSnap.val() || 0;
      await db.ref('referrals/' + user.id + '/points').set(currentPtsFilleul + cfg.ptsFilleul);

      // 5. Enregistrer l'historique (pour l'admin et le compte)
      const historyEntry = {
        parrainId: parrainId,
        parrainName: 'Utilisateur ' + parrainId.slice(-4), // Nom simplifié
        filleulId: user.id,
        filleulName: user.name,
        ptsParrain: cfg.ptsParrain,
        ptsFilleul: cfg.ptsFilleul,
        date: new Date().toISOString()
      };
      await db.ref('referrals_history/' + parrainId).push(historyEntry);
      await db.ref('referrals_history/' + user.id).push(historyEntry); // Pour que le filleul voit qu'il a été parrainé

      // 6. Marquer comme traité en local
      localStorage.setItem('emil_ref_processed_' + refCode, '1');
      
      if (typeof window.showToast === 'function') {
        window.showToast(`Bienvenue ! Vous avez reçu ${cfg.ptsFilleul} points de bienvenue.`, '🎁');
      }
    } catch (e) {
      console.warn('[Referral] Erreur:', e);
    }
  }

  function injectHearts() {
    document.querySelectorAll('.product-card').forEach(card => {
      if (card.dataset.emilHeartInjected) return; card.dataset.emilHeartInjected = '1';
      const match = (card.getAttribute('onclick') || '').match(/openProduct\(['"]([^'"]+)['"]\)/);
      if (!match) return; const productId = match[1];
      const imgContainer = card.querySelector('.product-img'); if (!imgContainer || imgContainer.querySelector('.emil-fav-heart')) return;
      const heart = document.createElement('button'); heart.className = 'emil-fav-heart'; const isFav = isFavorite(productId);
      heart.innerHTML = isFav ? `<span style="color:#e74c3c">${SVG_HEART}</span>` : `<span style="color:var(--light)">${SVG_HEART_OUTLINE}</span>`;
      heart.style.cssText = `position:absolute;top:10px;right:10px;width:36px;height:36px;border-radius:50%;background:rgba(10,10,10,.75);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .25s ease;z-index:5;border:1px solid rgba(201,168,76,.3);padding:0;`;
      heart.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); const nowFav = toggleFavorite(productId); heart.innerHTML = nowFav ? `<span style="color:#e74c3c">${SVG_HEART}</span>` : `<span style="color:var(--light)">${SVG_HEART_OUTLINE}</span>`; heart.style.transform = 'scale(1.2)'; setTimeout(() => heart.style.transform = '', 200); toast(nowFav ? 'Ajouté aux favoris' : 'Retiré des favoris', nowFav ? '❤️' : '🤍'); });
      imgContainer.style.position = 'relative'; imgContainer.appendChild(heart);
    });
  }

  function injectNavLinks() {
    const navLinks = document.getElementById('nav-main-links');
    if (navLinks && !navLinks.querySelector('[data-emil-patch-link]')) {
      const accountLink = document.createElement('button'); accountLink.className = 'nav-main-link'; accountLink.setAttribute('data-emil-patch-link', '1'); accountLink.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;">${SVG_USER} Mon Compte</span>`; accountLink.onclick = () => window.location.href = 'mon-compte.html'; navLinks.appendChild(accountLink);
      const concoursLink = document.createElement('button'); concoursLink.className = 'nav-main-link'; concoursLink.setAttribute('data-emil-patch-link', '1'); concoursLink.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;">${SVG_TROPHY} Concours</span>`; concoursLink.style.color = 'var(--gold)'; concoursLink.onclick = () => window.location.href = 'concours.html'; navLinks.appendChild(concoursLink);
    }
    const drawer = document.getElementById('nav-drawer');
    if (drawer && !drawer.querySelector('[data-emil-patch-drawer-link]')) {
      const insertBefore = drawer.querySelector('.nav-drawer-divider:last-of-type') || drawer.lastElementChild;
      const concoursBtn = document.createElement('button'); concoursBtn.className = 'nav-drawer-item'; concoursBtn.setAttribute('data-emil-patch-drawer-link', '1'); concoursBtn.innerHTML = `${SVG_TROPHY} <span style="margin-left:10px">Jeu Concours</span>`; concoursBtn.style.color = 'var(--gold)'; concoursBtn.onclick = () => { if (typeof window.closeNavDrawer === 'function') window.closeNavDrawer(); window.location.href = 'concours.html'; };
      const accountBtn = document.createElement('button'); accountBtn.className = 'nav-drawer-item'; accountBtn.setAttribute('data-emil-patch-drawer-link', '1'); accountBtn.innerHTML = `${SVG_USER} <span style="margin-left:10px">Mon Compte</span>`; accountBtn.onclick = () => { if (typeof window.closeNavDrawer === 'function') window.closeNavDrawer(); window.location.href = 'mon-compte.html'; };
      if (insertBefore && insertBefore.parentNode) { insertBefore.parentNode.insertBefore(concoursBtn, insertBefore); insertBefore.parentNode.insertBefore(accountBtn, insertBefore); } else { drawer.appendChild(concoursBtn); drawer.appendChild(accountBtn); }
    }
  }

  function observe() { let timeout = null; const observer = new MutationObserver(() => { clearTimeout(timeout); timeout = setTimeout(() => { injectHearts(); injectNavLinks(); }, 120); }); observer.observe(document.body, { childList: true, subtree: true }); }
  function handleProductParam() { const productId = new URLSearchParams(window.location.search).get('product'); if (productId && typeof window.openProduct === 'function') { setTimeout(() => { try { window.openProduct(productId); } catch (e) {} }, 800); } }

  async function init() {
    initFB(); await loadFavorites(); injectHearts(); injectNavLinks(); observe(); handleProductParam();
    // Vérification du parrainage à chaque chargement de page
    await checkReferral();
    window.addEventListener('storage', (e) => { if (e.key === 'emil_user' || e.key === 'lemil_favorites') { loadFavorites().then(() => { injectHearts(); }); } });
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', () => setTimeout(init, 300)); } else { setTimeout(init, 300); }
})();
