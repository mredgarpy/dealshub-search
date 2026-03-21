/* ============================================================
   StyleHub Miami — Analytics Event Layer v1.0
   Fires standard ecommerce events for GA4 / Meta / TikTok pixels
   Uses Shopify Customer Events (web pixels) approach
   ============================================================ */
(function() {
  'use strict';

  var DH_ANALYTICS = {
    debug: false,

    /* Push event to dataLayer (GA4) and fire pixel events */
    track: function(eventName, data) {
      data = data || {};
      data.timestamp = new Date().toISOString();
      data.page_url = window.location.href;

      // GA4 via dataLayer
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ event: eventName, ecommerce: null }); // clear
      window.dataLayer.push({ event: eventName, ecommerce: data });

      // Meta Pixel (if loaded)
      if (typeof fbq === 'function') {
        var metaMap = {
          view_item: 'ViewContent',
          add_to_cart: 'AddToCart',
          begin_checkout: 'InitiateCheckout',
          purchase: 'Purchase',
          search: 'Search',
          view_item_list: 'ViewCategory'
        };
        var metaEvent = metaMap[eventName];
        if (metaEvent) {
          fbq('track', metaEvent, {
            content_name: data.item_name || data.search_term || '',
            content_ids: data.item_id ? [data.item_id] : [],
            content_type: 'product',
            value: data.price || data.value || 0,
            currency: data.currency || 'USD'
          });
        }
      }

      // TikTok Pixel (if loaded)
      if (typeof ttq !== 'undefined' && ttq.track) {
        var ttMap = {
          view_item: 'ViewContent',
          add_to_cart: 'AddToCart',
          begin_checkout: 'InitiateCheckout',
          purchase: 'CompletePayment',
          search: 'Search'
        };
        var ttEvent = ttMap[eventName];
        if (ttEvent) {
          ttq.track(ttEvent, {
            content_name: data.item_name || '',
            content_id: data.item_id || '',
            content_type: 'product',
            value: data.price || data.value || 0,
            currency: data.currency || 'USD'
          });
        }
      }

      if (DH_ANALYTICS.debug) {
        console.log('[Analytics]', eventName, data);
      }
    },

    /* Standard ecommerce events */

    viewItem: function(product) {
      if (!product) return;
      this.track('view_item', {
        item_id: product.id || product.sourceId,
        item_name: product.title,
        item_brand: product.brand || '',
        item_category: product.category || '',
        price: parseFloat(String(product.price).replace(/[^0-9.]/g, '')) || 0,
        currency: 'USD',
        source: product.source || product.sourceName || ''
      });
    },

    addToCart: function(product, variant, quantity) {
      if (!product) return;
      this.track('add_to_cart', {
        item_id: product.id || product.sourceId,
        item_name: product.title,
        item_brand: product.brand || '',
        item_variant: variant || '',
        price: parseFloat(String(product.price).replace(/[^0-9.]/g, '')) || 0,
        quantity: quantity || 1,
        currency: 'USD',
        source: product.source || ''
      });
    },

    search: function(query, resultsCount) {
      this.track('search', {
        search_term: query,
        results_count: resultsCount || 0
      });
    },

    viewItemList: function(listName, items) {
      this.track('view_item_list', {
        item_list_name: listName,
        items_count: items ? items.length : 0
      });
    },

    selectItem: function(product, listName) {
      if (!product) return;
      this.track('select_item', {
        item_id: product.id,
        item_name: product.title,
        item_list_name: listName || 'search_results',
        source: product.source || ''
      });
    },

    viewCart: function(items, total) {
      this.track('view_cart', {
        value: total || 0,
        currency: 'USD',
        items_count: items ? items.length : 0
      });
    },

    beginCheckout: function(total) {
      this.track('begin_checkout', {
        value: total || 0,
        currency: 'USD'
      });
    },

    /* Page-level auto-tracking */
    autoTrack: function() {
      var path = window.location.pathname;
      var params = new URLSearchParams(window.location.search);

      // Search results page
      if (path.indexOf('search-results') !== -1 && params.get('q')) {
        // Will be called by search results JS after results load
      }

      // Product page
      if (path.indexOf('/pages/product') !== -1 && params.get('id')) {
        // Will be called by PDP JS after product loads
      }

      // Cart page
      if (path === '/cart') {
        this.viewCart();
      }

      // Track page view
      this.track('page_view', {
        page_path: path,
        page_title: document.title
      });
    }
  };

  // Expose globally
  window.DH_ANALYTICS = DH_ANALYTICS;

  // Auto-track on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { DH_ANALYTICS.autoTrack(); });
  } else {
    DH_ANALYTICS.autoTrack();
  }
})();
