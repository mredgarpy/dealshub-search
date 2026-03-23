/**
 * DealsHub Miami — Cart JavaScript
 * Handles cart drawer open/close, item updates, quantity changes
 */

window.DealsHubCart = (function () {
  'use strict';

  const cfg      = window.DealsHub || {};
  const drawer   = document.getElementById('cart-drawer');
  const overlay  = document.getElementById('overlay');
  const cartBtn  = document.getElementById('cart-btn');
  const closeBtn = document.getElementById('cart-close-btn');
  const countEl  = document.getElementById('cart-count');
  const drawerCount = document.getElementById('cart-drawer-count');
  const subtotalEl  = document.getElementById('cart-subtotal');
  const bodyEl      = document.getElementById('cart-drawer-body');
  const shippingFill = document.getElementById('cart-shipping-fill');
  const shippingText = document.getElementById('cart-shipping-text');
  const threshold = (cfg.freeShippingThreshold || 35);

  /* ── Open / Close ─────────────────────────────────────────── */
  function open() {
    if (!drawer) return;
    drawer.classList.add('is-open');
    drawer.setAttribute('aria-hidden', 'false');
    overlay && overlay.classList.add('is-visible');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    if (!drawer) return;
    drawer.classList.remove('is-open');
    drawer.setAttribute('aria-hidden', 'true');
    const anyOpen = document.querySelector('.mobile-nav.is-open') ||
                    document.querySelector('.quick-view-modal.is-open');
    if (!anyOpen) {
      overlay && overlay.classList.remove('is-visible');
      document.body.style.overflow = '';
    }
  }

  cartBtn  && cartBtn.addEventListener('click', open);
  closeBtn && closeBtn.addEventListener('click', close);
  overlay  && overlay.addEventListener('click', close);

  /* ── Qty buttons & remove (event delegation) ──────────────── */
  bodyEl && bodyEl.addEventListener('click', async function (e) {
    const qtyBtn  = e.target.closest('[data-action]');
    const removeBtn = e.target.closest('[data-key].cart-item__remove');

    if (qtyBtn) {
      const key    = qtyBtn.dataset.key;
      const action = qtyBtn.dataset.action;
      const row    = qtyBtn.closest('.cart-item');
      const qtySpan = row && row.querySelector('.cart-item__qty span');
      const current = qtySpan ? parseInt(qtySpan.textContent) : 1;
      const newQty  = action === 'increase' ? current + 1 : Math.max(0, current - 1);
      await updateItem(key, newQty);
    }

    if (removeBtn) {
      const key = removeBtn.dataset.key;
      await updateItem(key, 0);
    }
  });

  /* ── Shopify Cart API ─────────────────────────────────────── */
  async function updateItem(key, qty) {
    try {
      const res = await fetch('/cart/change.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ id: key, quantity: qty })
      });
      if (!res.ok) throw new Error('Cart update failed');
      const cart = await res.json();
      syncUI(cart);
    } catch (err) {
      console.warn('Cart error:', err);
    }
  }

  async function addItem(variantId, qty = 1, properties = {}) {
    try {
      const res = await fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ id: variantId, quantity: qty, properties })
      });
      if (!res.ok) throw new Error('Add to cart failed');
      const data = await res.json();
      await refreshCart();
      open();
      window.DealsHubTheme && window.DealsHubTheme.showToast('🛒 Added to cart!', 'success');
      return data;
    } catch (err) {
      window.DealsHubTheme && window.DealsHubTheme.showToast('Could not add to cart', 'error');
      throw err;
    }
  }

  async function refreshCart() {
    try {
      const res  = await fetch('/cart.js', { headers: { 'Accept': 'application/json' } });
      const cart = await res.json();
      syncUI(cart);
    } catch { /* silent */ }
  }

  /* ── Sync UI after cart change ────────────────────────────── */
  function syncUI(cart) {
    const count = cart.item_count || 0;

    // Update count badges
    [countEl, drawerCount].forEach(el => {
      if (!el) return;
      el.textContent = count;
      if (el === countEl) el.style.display = count > 0 ? '' : 'none';
    });

    // Dispatch event for other components
    document.dispatchEvent(new CustomEvent('cart:updated', { detail: { count, cart } }));

    // Subtotal
    if (subtotalEl) {
      subtotalEl.textContent = '$' + (cart.total_price / 100).toFixed(2);
    }

    // Shipping bar
    const total = cart.total_price / 100;
    if (shippingFill) {
      const pct = Math.min(100, (total / threshold) * 100);
      shippingFill.style.width = pct + '%';
    }
    if (shippingText) {
      if (total >= threshold) {
        shippingText.innerHTML = '🎉 You qualify for <strong>Free Shipping!</strong>';
      } else {
        const remaining = (threshold - total).toFixed(2);
        shippingText.innerHTML = `Add <strong>$${remaining}</strong> more for free shipping`;
      }
    }

    // Re-render items
    renderItems(cart);
  }

  function renderItems(cart) {
    if (!bodyEl) return;

    if (!cart.item_count) {
      bodyEl.innerHTML = `
        <div class="cart-empty">
          <div class="cart-empty__icon">🛒</div>
          <h3 class="cart-empty__title">Your cart is empty</h3>
          <p class="cart-empty__text">Start adding deals to your cart!</p>
          <a href="/pages/dealshub" class="btn btn--primary">Shop Deals</a>
        </div>`;

      // Hide footer
      const footer = document.getElementById('cart-drawer-footer');
      if (footer) footer.style.display = 'none';
      return;
    }

    const footer = document.getElementById('cart-drawer-footer');
    if (footer) footer.style.display = '';

    bodyEl.innerHTML = cart.items.map(item => `
      <div class="cart-item" data-cart-item="${item.key}">
        ${item.image
          ? `<img class="cart-item__img" src="${item.image}" alt="${escHtml(item.title)}" loading="lazy">`
          : `<div class="cart-item__img" style="background:var(--color-bg)"></div>`}
        <div class="cart-item__details">
          <div class="cart-item__title">${escHtml(item.product_title || item.title).slice(0, 60)}</div>
          <div class="cart-item__footer">
            <span class="cart-item__price">$${(item.final_price / 100).toFixed(2)}</span>
            <div class="cart-item__qty">
              <button class="qty-btn" data-action="decrease" data-key="${item.key}" aria-label="Decrease">−</button>
              <span>${item.quantity}</span>
              <button class="qty-btn" data-action="increase" data-key="${item.key}" aria-label="Increase">+</button>
            </div>
          </div>
          <button class="cart-item__remove" data-key="${item.key}">Remove</button>
        </div>
      </div>`).join('');
  }

  function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // Init
  refreshCart();

  return { open, close, addItem, refreshCart };

})();
