/**
 * StyleHub Miami Account Dashboard
 * Handles customer account navigation, order management, and interactions
 *
 * Features:
 * - Tab navigation in sidebar
 * - Order filtering by status
 * - Mobile sidebar toggle
 * - Recently viewed products
 * - Coupon code copy to clipboard
 * - Buy again functionality
 * - URL hash navigation
 * - Alert dismissal
 */

class StyleHubAccount {
  constructor() {
    this.accountSection = document.querySelector('[data-account-section]');
    this.sidebarNav = document.querySelector('[data-account-sidebar-nav]');
    this.mobileToggle = document.querySelector('[data-account-mobile-toggle]');
    this.sidebar = document.querySelector('[data-account-sidebar]');
    this.orderFilterTabs = document.querySelectorAll('[data-order-filter-tab]');
    this.orderCards = document.querySelectorAll('[data-order-card]');
    this.recentlyViewedContainer = document.querySelector('[data-recently-viewed-products]');
    this.copyButtons = document.querySelectorAll('[data-copy-coupon]');
    this.buyAgainButtons = document.querySelectorAll('[data-buy-again]');
    this.alertBanners = document.querySelectorAll('[data-alert-banner]');
    this.closeBannerButtons = document.querySelectorAll('[data-close-alert]');

    if (!this.accountSection) return;

    this.init();
  }

  /**
   * Initialize all event listeners and handlers
   */
  init() {
    this.setupTabNavigation();
    this.setupOrderFiltering();
    this.setupMobileSidebar();
    this.setupRecentlyViewed();
    this.setupCouponCopy();
    this.setupBuyAgain();
    this.setupHashNavigation();
    this.setupAlertBanners();
  }

  /**
   * Handle sidebar tab navigation with event delegation
   */
  setupTabNavigation() {
    if (!this.sidebarNav) return;

    this.sidebarNav.addEventListener('click', (e) => {
      const navItem = e.target.closest('[data-account-nav-item]');
      if (!navItem) return;

      const tabName = navItem.getAttribute('data-account-nav-item');
      if (!tabName) return;

      e.preventDefault();

      // Update active nav state
      this.sidebarNav.querySelectorAll('[data-account-nav-item]').forEach(item => {
        item.classList.remove('active');
      });
      navItem.classList.add('active');

      // Show corresponding section
      this.showSection(tabName);

      // Update URL hash
      window.location.hash = `#${tabName}`;

      // Close mobile sidebar
      this.closeMobileSidebar();
    });
  }

  /**
   * Show a specific account section and hide others
   */
  showSection(sectionName) {
    const sections = this.accountSection.querySelectorAll('[data-account-content-section]');
    sections.forEach(section => {
      const name = section.getAttribute('data-account-content-section');
      if (name === sectionName) {
        section.classList.add('active');
        section.style.display = 'block';
      } else {
        section.classList.remove('active');
        section.style.display = 'none';
      }
    });
  }

  /**
   * Setup order filtering by status tabs
   */
  setupOrderFiltering() {
    if (this.orderFilterTabs.length === 0) return;

    this.orderFilterTabs.forEach(tab => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();

        const filterValue = tab.getAttribute('data-order-filter-tab');

        // Update active tab
        this.orderFilterTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        // Filter orders
        this.filterOrders(filterValue);
      });
    });
  }

  /**
   * Filter order cards based on status
   */
  filterOrders(filterValue) {
    let visibleCount = 0;

    this.orderCards.forEach(card => {
      const orderStatus = card.getAttribute('data-order-status');

      if (filterValue === 'all' || orderStatus === filterValue) {
        card.style.display = 'block';
        card.classList.add('visible');
        visibleCount++;
      } else {
        card.style.display = 'none';
        card.classList.remove('visible');
      }
    });

    // Show no results message if needed
    const ordersContainer = document.querySelector('[data-orders-list]');
    if (ordersContainer) {
      const noResultsMsg = ordersContainer.querySelector('[data-no-orders-message]');
      if (visibleCount === 0 && noResultsMsg) {
        noResultsMsg.style.display = 'block';
      } else if (noResultsMsg) {
        noResultsMsg.style.display = 'none';
      }
    }
  }

  /**
   * Setup mobile sidebar toggle with hamburger menu
   */
  setupMobileSidebar() {
    if (!this.mobileToggle || !this.sidebar) return;

    this.mobileToggle.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      this.sidebar.classList.toggle('open');
      this.mobileToggle.classList.toggle('active');
      this.toggleBodyScroll();
    });

    // Close sidebar when clicking outside
    document.addEventListener('click', (e) => {
      if (
        this.sidebar.classList.contains('open') &&
        !this.sidebar.contains(e.target) &&
        !this.mobileToggle.contains(e.target)
      ) {
        this.closeMobileSidebar();
      }
    });

    // Close sidebar on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.sidebar.classList.contains('open')) {
        this.closeMobileSidebar();
      }
    });
  }

  /**
   * Close mobile sidebar and restore body scroll
   */
  closeMobileSidebar() {
    if (!this.sidebar || !this.mobileToggle) return;

    this.sidebar.classList.remove('open');
    this.mobileToggle.classList.remove('active');
    this.toggleBodyScroll(false);
  }

  /**
   * Toggle body scroll lock (prevent scrolling when sidebar is open)
   */
  toggleBodyScroll(lock = true) {
    if (lock) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
  }

  /**
   * Load and render recently viewed products from localStorage
   */
  setupRecentlyViewed() {
    if (!this.recentlyViewedContainer) return;

    try {
      const recentlyViewed = JSON.parse(localStorage.getItem('stylehub_recently_viewed') || '[]');

      if (recentlyViewed.length === 0) {
        this.recentlyViewedContainer.innerHTML = '<p class="empty-state">No recently viewed products</p>';
        return;
      }

      // Render recently viewed products (limit to last 6)
      const products = recentlyViewed.slice(-6).reverse();
      let html = '<div class="recently-viewed-grid">';

      products.forEach(product => {
        html += this.renderRecentlyViewedCard(product);
      });

      html += '</div>';
      this.recentlyViewedContainer.innerHTML = html;
    } catch (error) {
      console.error('Error loading recently viewed products:', error);
      this.recentlyViewedContainer.innerHTML = '<p class="empty-state">Could not load recently viewed products</p>';
    }
  }

  /**
   * Render a single recently viewed product card
   */
  renderRecentlyViewedCard(product) {
    const price = parseFloat(product.price).toFixed(2);
    const originalPrice = product.originalPrice ? parseFloat(product.originalPrice).toFixed(2) : null;
    const imageUrl = product.image || '/cdn/shop/products/placeholder.jpg';
    const discount = originalPrice ? Math.round(((originalPrice - price) / originalPrice) * 100) : 0;

    let html = `
      <div class="product-card recently-viewed-card">
        <div class="product-image-wrapper">
          <img
            src="${this.escapeHtml(imageUrl)}"
            alt="${this.escapeHtml(product.title)}"
            loading="lazy"
          >
    `;

    if (discount > 0) {
      html += `<span class="discount-badge">-${discount}%</span>`;
    }

    html += `
        </div>
        <div class="product-info">
          <h3 class="product-title">${this.escapeHtml(product.title)}</h3>
          <div class="product-price">
            <span class="price">$${price}</span>
    `;

    if (originalPrice) {
      html += `<span class="original-price">$${originalPrice}</span>`;
    }

    html += `
          </div>
          <a href="/pages/product?id=${this.escapeHtml(product.sourceId)}&store=${this.escapeHtml(product.source)}" class="btn btn-primary btn-sm">
            View Product
          </a>
        </div>
      </div>
    `;

    return html;
  }

  /**
   * Setup copy coupon code to clipboard
   */
  setupCouponCopy() {
    this.copyButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        e.preventDefault();

        const code = button.getAttribute('data-copy-coupon');
        if (!code) return;

        // Copy to clipboard
        navigator.clipboard.writeText(code).then(() => {
          // Show success feedback
          const originalText = button.textContent;
          const originalClass = button.className;

          button.textContent = 'Copied!';
          button.classList.add('copied');

          setTimeout(() => {
            button.textContent = originalText;
            button.className = originalClass;
          }, 2000);
        }).catch(err => {
          console.error('Failed to copy code:', err);
          // Fallback: select text manually
          this.fallbackCopyToClipboard(code);
        });
      });
    });
  }

  /**
   * Fallback method to copy to clipboard using execCommand
   */
  fallbackCopyToClipboard(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();

    try {
      document.execCommand('copy');
      console.log('Copied via fallback method');
    } catch (err) {
      console.error('Fallback copy failed:', err);
    }

    document.body.removeChild(textarea);
  }

  /**
   * Setup buy again functionality
   * Adds product to cart via Shopify Cart API
   */
  setupBuyAgain() {
    this.buyAgainButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        e.preventDefault();

        const variantId = button.getAttribute('data-buy-again');
        if (!variantId) return;

        const quantity = parseInt(button.getAttribute('data-quantity') || '1', 10);

        this.addToCart(variantId, quantity, button);
      });
    });
  }

  /**
   * Add item to cart via Shopify Cart API
   */
  addToCart(variantId, quantity, button) {
    if (!variantId) return;

    // Show loading state
    const originalText = button.textContent;
    const originalDisabled = button.disabled;

    button.disabled = true;
    button.textContent = 'Adding...';

    // Prepare line item
    const lineItem = {
      quantity: quantity,
      variantId: variantId
    };

    fetch('/cart/add.js', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: JSON.stringify(lineItem)
    })
    .then(response => {
      if (!response.ok) {
        throw new Error(`Cart API error: ${response.status}`);
      }
      return response.json();
    })
    .then(cart => {
      // Success
      button.textContent = 'Added!';
      button.classList.add('success');

      // Fire custom event for cart updates
      document.dispatchEvent(new CustomEvent('stylehub:cart-updated', {
        detail: { cart: cart, variantId: variantId }
      }));

      // Show cart drawer or notification
      this.showCartNotification('Product added to cart!');

      setTimeout(() => {
        button.textContent = originalText;
        button.disabled = originalDisabled;
        button.classList.remove('success');
      }, 2000);
    })
    .catch(error => {
      console.error('Add to cart error:', error);
      button.textContent = 'Error adding';
      button.classList.add('error');

      setTimeout(() => {
        button.textContent = originalText;
        button.disabled = originalDisabled;
        button.classList.remove('error');
      }, 3000);
    });
  }

  /**
   * Show cart notification
   */
  showCartNotification(message) {
    // Check if notification already exists
    let notification = document.querySelector('[data-cart-notification]');

    if (!notification) {
      notification = document.createElement('div');
      notification.setAttribute('data-cart-notification', '');
      notification.className = 'cart-notification';
      document.body.appendChild(notification);
    }

    notification.textContent = message;
    notification.classList.add('show');

    setTimeout(() => {
      notification.classList.remove('show');
    }, 3000);
  }

  /**
   * Setup URL hash navigation
   * Allows direct linking to account sections via #orders, #wishlist, etc.
   */
  setupHashNavigation() {
    const handleHashChange = () => {
      const hash = window.location.hash.replace('#', '');
      if (!hash) return;

      const navItem = this.sidebarNav?.querySelector(`[data-account-nav-item="${hash}"]`);
      if (navItem) {
        navItem.click();
      }
    };

    // Handle initial hash on page load
    window.addEventListener('load', handleHashChange);

    // Handle hash changes
    window.addEventListener('hashchange', handleHashChange);
  }

  /**
   * Setup alert banner dismissal
   */
  setupAlertBanners() {
    this.closeBannerButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        e.preventDefault();

        const banner = button.closest('[data-alert-banner]');
        if (banner) {
          banner.style.display = 'none';
          banner.classList.add('dismissed');

          // Optionally store dismissal state in localStorage
          const bannerId = banner.getAttribute('data-alert-banner');
          if (bannerId) {
            const dismissedBanners = JSON.parse(localStorage.getItem('stylehub_dismissed_banners') || '{}');
            dismissedBanners[bannerId] = true;
            localStorage.setItem('stylehub_dismissed_banners', JSON.stringify(dismissedBanners));
          }
        }
      });
    });

    // Check for previously dismissed banners
    const dismissedBanners = JSON.parse(localStorage.getItem('stylehub_dismissed_banners') || '{}');
    this.alertBanners.forEach(banner => {
      const bannerId = banner.getAttribute('data-alert-banner');
      if (bannerId && dismissedBanners[bannerId]) {
        banner.style.display = 'none';
        banner.classList.add('dismissed');
      }
    });
  }

  /**
   * Utility: Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    if (typeof text !== 'string') return '';

    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Utility: Debounce function for performance
   */
  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }
}

// Initialize on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new StyleHubAccount();
  });
} else {
  new StyleHubAccount();
}
