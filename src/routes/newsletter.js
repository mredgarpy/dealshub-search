/**
 * Newsletter Subscribe Route
 * POST /api/newsletter-subscribe
 * Creates or updates a Shopify customer with accepts_marketing = true
 */
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');

const SHOPIFY_STORE = process.env.SHOPIFY_STORE || '1rnmax-5z.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN;

router.post('/api/newsletter-subscribe', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.json({ success: false, message: 'Valid email required' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // First, check if customer already exists
    const searchUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/customers/search.json?query=email:${encodeURIComponent(normalizedEmail)}`;
    const searchResp = await fetch(searchUrl, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    const searchData = await searchResp.json();

    if (searchData.customers && searchData.customers.length > 0) {
      // Customer exists — update marketing acceptance
      const customerId = searchData.customers[0].id;
      const alreadySubscribed = searchData.customers[0].email_marketing_consent &&
        searchData.customers[0].email_marketing_consent.state === 'subscribed';

      if (alreadySubscribed) {
        return res.json({ success: true, message: "You're already subscribed!" });
      }

      const updateUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/customers/${customerId}.json`;
      await fetch(updateUrl, {
        method: 'PUT',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          customer: {
            id: customerId,
            email_marketing_consent: {
              state: 'subscribed',
              opt_in_level: 'single_opt_in',
              consent_updated_at: new Date().toISOString()
            }
          }
        })
      });
      return res.json({ success: true, message: 'Subscribed!' });
    }

    // Customer does not exist — create new with marketing consent
    const createUrl = `https://${SHOPIFY_STORE}/admin/api/2024-01/customers.json`;
    const createResp = await fetch(createUrl, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        customer: {
          email: normalizedEmail,
          email_marketing_consent: {
            state: 'subscribed',
            opt_in_level: 'single_opt_in',
            consent_updated_at: new Date().toISOString()
          },
          tags: 'newsletter,footer-signup'
        }
      })
    });
    const createData = await createResp.json();

    if (createData.errors) {
      console.error('[newsletter-subscribe] Shopify create error:', createData.errors);
      // Even if there's an error (like email taken), show success to user
      return res.json({ success: true, message: 'Subscribed!' });
    }

    return res.json({ success: true, message: 'Subscribed!' });
  } catch (err) {
    console.error('[newsletter-subscribe] Error:', err.message);
    return res.json({ success: false, message: 'Something went wrong. Try again.' });
  }
});

module.exports = router;
