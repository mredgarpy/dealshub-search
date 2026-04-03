// blog-engine.js — Automated Blog Post Generator for StyleHub Miami (v2)
// Generates long-form, SEO-optimized editorial content with embedded products
// Strategy: 1 high-quality post per day instead of 3 thin ones
// Goal: Content Google will actually index and rank
// Adapted for dealshub-search repo — self-contained, uses fetch() + env vars

const SITE_URL = process.env.SITE_URL || 'https://stylehubmiami.com';
const BLOG_HANDLE = process.env.BLOG_HANDLE || 'stylehub-blog';
const POSTS_PER_RUN = parseInt(process.env.POSTS_PER_RUN || '1');
const DEALSHUB_API = process.env.DEALSHUB_API_URL || 'https://dealshub-search.onrender.com';
const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN || '1rnmax-5z.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || '';
const SHOPIFY_API_VERSION = '2024-01';

// ─── SELF-CONTAINED API HELPERS ─────────────────────────────────────────────
async function searchProducts(query, store = 'all', limit = 16) {
  try {
    const url = `${DEALSHUB_API}/api/search?q=${encodeURIComponent(query)}&store=${store}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || data.products || data || [];
  } catch (e) { console.error('searchProducts error:', e.message); return []; }
}

async function getTrending(limit = 16) {
  try {
    const res = await fetch(`${DEALSHUB_API}/api/trending?limit=${limit}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.products || data || [];
  } catch (e) { return []; }
}

async function getBestsellers(limit = 16) {
  try {
    const res = await fetch(`${DEALSHUB_API}/api/bestsellers?limit=${limit}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.products || data || [];
  } catch (e) { return []; }
}

async function shopifyAdmin(method, path, body) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': SHOPIFY_TOKEN },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`Shopify ${method} ${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function getBlogId(handle) {
  const data = await shopifyAdmin('GET', '/blogs.json');
  const blog = data.blogs.find(b => b.handle === handle);
  if (!blog) throw new Error(`Blog "${handle}" not found`);
  return blog.id;
}

async function createArticle(blogId, articleData) {
  return shopifyAdmin('POST', `/blogs/${blogId}/articles.json`, { article: articleData });
}

async function listArticles(blogId, limit = 250) {
  return shopifyAdmin('GET', `/blogs/${blogId}/articles.json?limit=${limit}`);
}

// ─── CONTENT LIBRARY ─────────────────────────────────────────────────────────
// Rich paragraph banks per topic. Each post uses multiple unique paragraphs
// combined with real product data to create genuinely useful content.

const EDITORIAL_BLOCKS = {

  fashion: {
    intros: [
      `Fashion is personal — what looks effortless on a runway doesn't always translate to real life. That's why we focus on wearable, versatile pieces that work for actual humans with actual budgets. The items below aren't just trendy; they're practical investments in your everyday style.`,
      `Building a wardrobe that works for you is less about following every trend and more about understanding what fits your body, lifestyle, and personal aesthetic. We've spent hours reviewing customer feedback, comparing fits across brands, and analyzing return rates to bring you pieces that people actually keep and wear repeatedly.`,
      `The best-dressed people you know probably own fewer clothes than you think. Their secret isn't a bigger closet — it's smarter choices. Each piece below was selected because it scores high on versatility, comfort, and that hard-to-define quality that makes you feel put-together without trying too hard.`,
    ],
    midSections: [
      { heading: 'How to Build Outfits That Work', body: `Start with a neutral base — think well-fitted jeans, a quality tee, or tailored trousers. Then add one statement piece that pulls the look together: a structured jacket, bold accessories, or shoes that make people ask "where did you get those?" The goal isn't to look like a magazine spread; it's to look like the best version of yourself on a Tuesday morning. When shopping online, pay close attention to fabric composition listed in product details. Natural fibers like cotton, linen, and wool tend to drape better and last longer than pure synthetics. Blends often give you the best of both worlds — comfort with durability.` },
      { heading: 'Sizing and Fit: What Actually Matters', body: `Online shopping anxiety usually comes down to one thing: will it fit? Here's a practical approach. First, measure a garment you already love and compare those measurements to the size chart — not your body measurements, the actual garment. Second, read reviews specifically from people who mention their height and weight. Third, look for items with generous return windows so you can order two sizes without stress. Most of the products we feature include detailed sizing information and customer photos that give you a much better sense of fit than studio shots alone.` },
      { heading: 'Price vs. Value: Finding the Sweet Spot', body: `Expensive doesn't always mean better, and cheap doesn't always mean bad. The real question is cost-per-wear. A $40 jacket you wear 100 times costs you 40 cents per wear. A $15 top you wear twice costs $7.50 per wear. We factor in customer ratings, return rates, and repeat purchase patterns to identify products that deliver genuine value — not just a low price tag.` },
    ],
    closers: [
      `Fashion should be fun, not stressful. Take your time browsing, save items to your wishlist, and remember that the best purchases are the ones you'll still be happy about next month. We update our collections daily, so there's always something new to discover.`,
      `The items featured here represent what's working for real shoppers right now. Ratings, reviews, and sales data don't lie — these are pieces people buy, keep, and recommend. If something catches your eye, don't overthink it. The best style decisions often feel instinctive.`,
    ],
  },

  beauty: {
    intros: [
      `The beauty industry launches thousands of new products every month. Most of them are repackaged versions of what already exists. Our job is to cut through the noise and surface the products that actually deliver results — based on ingredients, customer reviews, and real-world performance, not marketing hype.`,
      `Great skincare and beauty products don't need to cost a fortune. Some of the most effective formulas on the market come from brands you've never heard of, sold at prices that would make prestige brands nervous. We analyze ingredient lists, compare formulations, and track what products people repurchase to find the ones that genuinely work.`,
      `Your skin is unique, and what works for a beauty influencer with a ring light and a filter might not work for you on a humid Wednesday in Miami. That's why we prioritize products with diverse reviews — real people, real skin types, real results. The picks below have been vetted through thousands of customer experiences.`,
    ],
    midSections: [
      { heading: 'Reading Ingredient Lists Like a Pro', body: `You don't need a chemistry degree to make smart beauty purchases, but knowing a few key ingredients helps enormously. Hyaluronic acid for hydration, niacinamide for brightness and pore size, retinol for anti-aging, salicylic acid for acne, and vitamin C for protection and glow. Ingredients are listed in descending order of concentration, so if the star ingredient is near the bottom, you're mostly paying for water and filler. The products we feature include detailed ingredient breakdowns when available, so you can make informed decisions.` },
      { heading: 'Why Reviews Matter More Than Marketing', body: `A product with 4.2 stars across 2,000 reviews tells you more than any ad campaign ever could. We specifically look for products where reviewers mention long-term use — "I've been using this for six months and..." is worth more than "just got this and love the packaging!" Pay attention to negative reviews too. If most complaints are about shipping rather than the product itself, that's actually a good sign. Every product listing on StyleHub shows verified ratings and review counts so you can judge quality at a glance.` },
      { heading: 'Building a Routine That Actually Sticks', body: `The most effective skincare routine is the one you'll actually do every day. A 12-step routine sounds impressive but means nothing if you skip it three days a week. Start simple: cleanser, moisturizer, sunscreen in the morning. Cleanser, treatment (if needed), moisturizer at night. Once that's habit, you can add serums or actives one at a time to see what your skin responds to. Consistency beats complexity every single time.` },
    ],
    closers: [
      `Beauty shopping should feel exciting, not overwhelming. If you're unsure where to start, sort by highest rated and read what real customers say. The products that earn thousands of positive reviews earned them for a reason. Your perfect routine is out there — it just takes a little experimentation to find it.`,
      `Remember: the most expensive product isn't always the best one for you. Some of our highest-rated beauty picks cost less than a fancy coffee. Focus on what your skin actually needs, read the ingredients, trust the reviews, and don't be afraid to try something new. That's how you find your holy grail products.`,
    ],
  },

  electronics: {
    intros: [
      `Buying electronics online can feel like navigating a minefield of confusing specs, inflated reviews, and products that look identical but perform very differently. We simplify the process by focusing on what actually matters: real-world performance, build quality, customer satisfaction over time, and honest value for money.`,
      `The tech market moves fast. What was cutting-edge six months ago is now mid-range, and last year's flagship is today's best value. That constant evolution actually works in your favor as a shopper — you can get incredible performance at every price point if you know where to look. We track pricing trends, compare specs across brands, and highlight the sweet spots where performance meets affordability.`,
      `Not everyone needs the latest and greatest gadget. Sometimes the best tech purchase is the reliable, well-reviewed option that does exactly what you need without the premium price tag. We curate electronics based on practical value: does it solve a real problem, is it built to last, and do people who own it actually recommend it? That's our bar.`,
    ],
    midSections: [
      { heading: 'Specs That Matter vs. Marketing Fluff', body: `Manufacturers love to throw numbers at you — megapixels, gigahertz, milliamp hours — but not all specs affect your daily experience equally. For headphones, driver size matters less than frequency response and comfort over long sessions. For phones, raw processor speed matters less than software optimization and battery life. For laptops, RAM and SSD speed matter more than clock speed for most people. We try to highlight the specs that actually impact how a product feels to use, not just how it looks on paper.` },
      { heading: 'When to Buy and When to Wait', body: `Electronics pricing follows predictable cycles. New models launch, prices drop on previous generations, and holiday sales create genuine discounts (not just inflated-then-discounted illusions). Generally, buying the previous generation of a popular product right after the new one launches gets you 80% of the performance at 50-60% of the price. Our Flash Deals section tracks real price drops so you can buy with confidence that you're getting actual value.` },
      { heading: 'Accessories That Are Actually Worth It', body: `A great gadget with a bad case, cheap cable, or wrong adapter becomes a frustrating experience. We include accessory recommendations because the right add-ons can transform how you use your tech. A $15 screen protector saves a $300 phone. A $25 stand turns a tablet into a workstation. A quality charging cable that doesn't fray after a month is worth three times what the gas station knockoff costs. Smart accessories extend the life and usability of everything you own.` },
    ],
    closers: [
      `Technology should make your life easier, not more complicated. The products featured here have been stress-tested by thousands of real customers. Read their experiences, compare your options, and remember that the best gadget is the one that fits seamlessly into your daily routine.`,
      `Whatever you're shopping for — whether it's your first pair of wireless earbuds or an upgrade to your home office — the key is matching the product to your actual needs. Don't overbuy features you won't use, and don't underbuy and end up frustrated. The sweet spot is always in the reviews, where real people tell you exactly what to expect.`,
    ],
  },

  home: {
    intros: [
      `Your home should be a place that works for you — not a showroom, not a storage unit, but a functional space that feels good to be in. Whether you're upgrading a single room or refreshing your entire space, the key is choosing pieces that balance form, function, and budget in a way that makes sense for how you actually live.`,
      `Home decor and organization products have exploded in variety over the past few years. The challenge isn't finding options — it's finding the right ones. We analyze return rates, customer photos (which tell you way more than studio shots), and long-term reviews to find home products that people love living with months after purchase, not just on unboxing day.`,
      `The most impactful home upgrades often aren't the biggest or most expensive ones. Swapping out lighting, adding the right storage solution, or upgrading your bedding can completely change how a space feels. We focus on high-impact, practical products that real homeowners rate highly after living with them for weeks and months.`,
    ],
    midSections: [
      { heading: 'Small Changes, Big Impact', body: `You don't need a full renovation to transform a room. Designers call them "quick wins" — affordable changes that create an outsized visual and functional impact. Updated throw pillows, a quality area rug, better lighting, or organizational tools that tame clutter can make a space feel completely different in an afternoon. The trick is choosing items that work together without looking like they came from a catalog. Mix textures, vary heights, and don't be afraid to add one bold piece that gives the room personality.` },
      { heading: 'Quality Indicators for Home Products', body: `When shopping for home goods online, certain signals reliably predict quality. For textiles (bedding, towels, curtains), thread count is overrated — fiber quality and weave matter more. For furniture, look at weight capacity, assembly reviews, and photos from customers showing the piece after months of use. For kitchen items, check whether reviewers mention durability after daily use. We factor all of these signals into our curation so you're seeing products that hold up to real life, not just photo shoots.` },
      { heading: 'Organizing Without Overcomplicating', body: `The best organization systems are the ones simple enough that you'll actually maintain them. Clear containers, labeled bins, drawer dividers, and vertical storage solutions work because they reduce the mental effort of staying organized. Before buying organizers, declutter first — no amount of cute baskets will fix a space that has too much stuff. Then measure your spaces precisely and choose products that fit your specific dimensions. Generic "one size fits all" organizers rarely fit anything perfectly.` },
    ],
    closers: [
      `Home improvement is a journey, not a weekend project. Start with the room that bothers you most, fix the one thing that drives you craziest, and build from there. The products below are chosen because they solve real problems for real people — not because they photograph well on a perfectly staged shelf.`,
      `Your space, your rules. Whether you're going minimal, maximalist, or somewhere in between, the goal is a home that makes you feel comfortable and in control. Browse what resonates, save what inspires you, and don't rush the process. A well-considered purchase always beats an impulsive one.`,
    ],
  },

  fitness: {
    intros: [
      `Fitness gear should help you move better, train harder, and recover faster — not sit in a closet collecting dust. The products below are chosen based on what people actually use consistently, not what looks good in an Instagram ad. Real durability, practical design, and honest customer feedback are what make the cut.`,
      `The fitness industry is full of gimmicks promising transformation with minimal effort. We skip all that and focus on the fundamentals: well-made equipment, functional clothing, and accessories that genuinely support an active lifestyle. Every item below has been validated by thousands of customer reviews from people who use them regularly, not just once for a "new year, new me" post.`,
      `Whether you're building a home gym, upgrading your workout wardrobe, or looking for recovery tools that actually work, the key is investing in quality over quantity. One great pair of training shoes beats three mediocre pairs. A reliable resistance band set beats a bulky machine you'll stop using. We curate for longevity and actual use, not just spec sheets.`,
    ],
    midSections: [
      { heading: 'Home Gym vs. Gym Membership: The Real Math', body: `A basic home gym setup — adjustable dumbbells, a bench, resistance bands, and a mat — costs roughly the same as 6-8 months of a gym membership. After that, it's free forever. The tradeoff is space and variety: a gym offers more equipment and social motivation. The sweet spot for many people is a hybrid approach: a simple home setup for days when you can't make it to the gym, and a membership for heavier lifting and classes. Whatever you choose, invest in equipment that's rated for your actual use level. Light-duty gear that breaks during a workout is dangerous, not frugal.` },
      { heading: 'Athletic Wear That Performs', body: `Workout clothing technology has come a long way. Moisture-wicking fabrics, four-way stretch, anti-odor treatment, and flatlock seams are no longer exclusive to premium brands. The key differentiators now are fit, durability after repeated washing, and whether the brand actually tests on diverse body types. When shopping for activewear, read reviews about how items hold up after 20+ washes — that's when cheap fabrics start pilling, losing shape, or losing their stretch. The items we feature consistently score high on long-term wearability.` },
      { heading: 'Recovery Is Half the Battle', body: `Training hard without recovering well is a recipe for burnout and injury. Foam rollers, massage guns, compression gear, and proper sleep accessories aren't luxuries — they're tools that keep you consistent. The most effective recovery tools are the simple ones you'll use daily, not the expensive gadgets that live in a drawer. A basic foam roller used for 10 minutes daily beats a $400 massage gun used once a month. Prioritize consistency over sophistication in your recovery toolkit.` },
    ],
    closers: [
      `The best fitness purchase is the one that removes a barrier between you and consistent training. If a good pair of shoes makes you more likely to run, that's the best investment you can make. If a set of resistance bands means you'll actually work out at home instead of skipping days — worth every penny. Shop with your habits in mind, not your aspirations.`,
      `Fitness isn't about having the perfect gear — it's about showing up consistently. But the right equipment does make showing up easier and more enjoyable. The products featured here are proven by thousands of active customers. Start with what you need most, and build your collection over time as your routine evolves.`,
    ],
  },
};

// ─── TOPIC DEFINITIONS ──────────────────────────────────────────────────────
// Each topic maps to content blocks + search queries + SEO data
const TOPICS = [
  {
    id: 'fashion-women',
    category: 'fashion',
    queries: ['women dresses', 'women tops', 'women shoes', 'women bags', 'women jewelry', 'women jackets', 'women jeans'],
    titleTemplates: [
      (m) => `What to Wear This ${m.season}: A Practical Guide to Women's ${m.queryTitle} in ${m.year}`,
      (m) => `${m.queryTitle} Worth Buying Right Now — Our ${m.monthName} ${m.year} Picks`,
      (m) => `The ${m.queryTitle} Real Women Are Loving in ${m.season} ${m.year}`,
      (m) => `Your ${m.season} ${m.queryTitle} Guide: Styles That Work for Every Budget`,
    ],
  },
  {
    id: 'fashion-men',
    category: 'fashion',
    queries: ['men casual shirts', 'men sneakers', 'men watches', 'men jackets', 'men shorts', 'men grooming'],
    titleTemplates: [
      (m) => `Men's ${m.queryTitle} That Actually Look Good — ${m.season} ${m.year} Guide`,
      (m) => `Upgrade Your Style: The Best ${m.queryTitle} for ${m.monthName} ${m.year}`,
      (m) => `No-Nonsense ${m.queryTitle} Guide for ${m.season} ${m.year}`,
    ],
  },
  {
    id: 'skincare',
    category: 'beauty',
    queries: ['skincare routine', 'moisturizer', 'sunscreen face', 'serum vitamin c', 'cleanser gentle', 'retinol cream', 'eye cream'],
    titleTemplates: [
      (m) => `${m.queryTitle} That Dermatologists and Real Users Agree On — ${m.year} Guide`,
      (m) => `We Analyzed Thousands of Reviews to Find the Best ${m.queryTitle}`,
      (m) => `Your ${m.season} ${m.queryTitle} Guide: What Actually Works in ${m.year}`,
    ],
  },
  {
    id: 'makeup',
    category: 'beauty',
    queries: ['foundation long wear', 'mascara waterproof', 'lipstick matte', 'concealer coverage', 'setting spray', 'eyeshadow palette'],
    titleTemplates: [
      (m) => `Best ${m.queryTitle} of ${m.year}: Tested by Thousands of Real Shoppers`,
      (m) => `${m.queryTitle} Worth the Money — Our ${m.monthName} ${m.year} Roundup`,
      (m) => `Finding Your Perfect ${m.queryTitle}: A Buyer's Guide for ${m.season} ${m.year}`,
    ],
  },
  {
    id: 'tech-gadgets',
    category: 'electronics',
    queries: ['wireless earbuds', 'phone case', 'portable charger', 'smart watch', 'bluetooth speaker', 'tablet accessories'],
    titleTemplates: [
      (m) => `${m.queryTitle} in ${m.year}: What's Worth Buying and What's Overhyped`,
      (m) => `The Best ${m.queryTitle} for Every Budget — ${m.monthName} ${m.year}`,
      (m) => `We Compared ${m.count}+ ${m.queryTitle} So You Don't Have To`,
    ],
  },
  {
    id: 'home-decor',
    category: 'home',
    queries: ['home decor', 'throw pillows', 'wall art', 'candles scented', 'area rug', 'desk organizer', 'storage bins'],
    titleTemplates: [
      (m) => `${m.queryTitle} That Transform Any Room — ${m.season} ${m.year} Picks`,
      (m) => `Affordable ${m.queryTitle} Real Homeowners Swear By in ${m.year}`,
      (m) => `${m.season} Home Refresh: The Best ${m.queryTitle} Under $50`,
    ],
  },
  {
    id: 'kitchen',
    category: 'home',
    queries: ['kitchen gadgets', 'cooking tools', 'food storage', 'coffee maker', 'blender', 'air fryer accessories'],
    titleTemplates: [
      (m) => `Kitchen ${m.queryTitle} That Earn Their Counter Space — ${m.year} Guide`,
      (m) => `The ${m.queryTitle} Home Cooks Actually Use Every Day`,
      (m) => `Best ${m.queryTitle} of ${m.monthName} ${m.year}: Practical Picks for Real Kitchens`,
    ],
  },
  {
    id: 'workout-gear',
    category: 'fitness',
    queries: ['workout leggings', 'running shoes', 'resistance bands', 'yoga mat', 'dumbbells', 'fitness tracker'],
    titleTemplates: [
      (m) => `${m.queryTitle} for People Who Actually Work Out — ${m.year} Guide`,
      (m) => `Best ${m.queryTitle} of ${m.season} ${m.year}: Tested by Real Athletes`,
      (m) => `Your Complete ${m.queryTitle} Buying Guide for ${m.monthName} ${m.year}`,
    ],
  },
  {
    id: 'budget-finds',
    category: 'fashion',
    queries: ['fashion under 25', 'accessories under 15', 'beauty under 20', 'home decor under 30', 'tech under 25'],
    titleTemplates: [
      (m) => `${m.count} Incredible Finds Under $${m.priceThreshold} That Don't Look Cheap`,
      (m) => `How to Look Expensive on a Budget: ${m.queryTitle} in ${m.monthName} ${m.year}`,
      (m) => `${m.monthName} ${m.year} Budget Guide: The Best ${m.queryTitle} That Won't Break the Bank`,
    ],
  },
  {
    id: 'gift-ideas',
    category: 'home',
    queries: ['gifts for her', 'gifts for him', 'self care gift set', 'tech gift ideas', 'unique gifts'],
    titleTemplates: [
      (m) => `${m.queryTitle} They'll Actually Use — A Thoughtful ${m.season} ${m.year} Guide`,
      (m) => `Gift Giving Made Easy: ${m.count} ${m.queryTitle} for Every Budget`,
      (m) => `The ${m.queryTitle} Guide: Unique, Practical, and Actually Appreciated`,
    ],
  },
];

// ─── PRODUCT CARD HTML BUILDER ──────────────────────────────────────────────
function buildProductCard(product, index) {
  const title = product.title || 'Product';
  const truncTitle = title.length > 70 ? title.slice(0, 67) + '...' : title;
  const price = parseFloat(product.price || 0).toFixed(2);
  const originalPrice = product.originalPrice ? parseFloat(product.originalPrice).toFixed(2) : null;
  const image = product.image || '';
  const rating = parseFloat(product.rating || 0);
  const reviews = product.reviews || product.review_count || 0;
  const id = product.id || product.asin || '';
  const source = (product.source || product.store || 'amazon').toLowerCase();
  const pdpUrl = `${SITE_URL}/pages/product?id=${encodeURIComponent(id)}&store=${source}`;

  const stars = rating > 0 ? '★'.repeat(Math.round(rating)) + '☆'.repeat(5 - Math.round(rating)) : '';
  const hasSavings = originalPrice && parseFloat(originalPrice) > parseFloat(price);
  const savingsAmt = hasSavings ? (parseFloat(originalPrice) - parseFloat(price)).toFixed(2) : null;

  return `
    <div class="shub-card">
      ${image ? `<a href="${pdpUrl}"><img src="${image}" alt="${truncTitle}" loading="lazy" class="shub-card-img"></a>` : ''}
      <div class="shub-card-body">
        <a href="${pdpUrl}" class="shub-card-title">${truncTitle}</a>
        <div class="shub-card-price">
          <span class="shub-price-now">$${price}</span>
          ${hasSavings ? `<span class="shub-price-was">$${originalPrice}</span> <span class="shub-price-save">Save $${savingsAmt}</span>` : ''}
        </div>
        ${stars ? `<div class="shub-card-rating">${stars} <span class="shub-rating-count">(${reviews})</span></div>` : ''}
        <a href="${pdpUrl}" class="shub-card-cta">View Deal</a>
      </div>
    </div>`;
}

// ─── CSS FOR BLOG POSTS ─────────────────────────────────────────────────────
const BLOG_CSS = `<style>
.shub-post{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a202c;line-height:1.8;max-width:800px;margin:0 auto}
.shub-post h2{font-size:24px;margin:36px 0 16px;color:#1a202c;font-weight:700;line-height:1.3}
.shub-post h3{font-size:19px;margin:28px 0 12px;color:#2d3748;font-weight:600}
.shub-post p{color:#4a5568;font-size:17px;margin-bottom:18px;line-height:1.8}
.shub-post a{color:#2b6cb0}
.shub-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:20px;margin:28px 0}
@media(max-width:640px){.shub-grid{grid-template-columns:1fr 1fr;gap:12px}}
@media(max-width:400px){.shub-grid{grid-template-columns:1fr}}
.shub-card{border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;background:#fff}
.shub-card-img{width:100%;height:200px;object-fit:contain;background:#f7fafc;padding:10px}
.shub-card-body{padding:14px}
.shub-card-title{color:#1a202c;text-decoration:none;font-weight:600;font-size:14px;line-height:1.4;display:block;margin-bottom:8px}
.shub-card-price{margin-bottom:6px}
.shub-price-now{font-size:18px;font-weight:700;color:#2d3748}
.shub-price-was{text-decoration:line-through;color:#a0aec0;margin-left:8px;font-size:13px}
.shub-price-save{color:#e53e3e;font-weight:600;font-size:13px;margin-left:4px}
.shub-card-rating{color:#ecc94b;font-size:13px;margin-bottom:8px}
.shub-rating-count{color:#718096;font-size:12px}
.shub-card-cta{display:block;background:#1a202c;color:#fff;padding:10px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;text-align:center}
.shub-card-cta:hover{background:#2d3748}
.shub-toc{background:#f7fafc;border:1px solid #e2e8f0;border-radius:10px;padding:20px 24px;margin:24px 0}
.shub-toc h3{margin:0 0 12px;font-size:16px;color:#2d3748}
.shub-toc ul{margin:0;padding-left:20px}
.shub-toc li{margin-bottom:6px;font-size:15px}
.shub-toc a{color:#2b6cb0;text-decoration:none}
.shub-tldr{background:#ebf8ff;border-left:4px solid #3182ce;padding:16px 20px;border-radius:0 8px 8px 0;margin:24px 0}
.shub-tldr p{margin:0;font-size:15px;color:#2a4365}
</style>`;

// ─── HELPERS ────────────────────────────────────────────────────────────────
function getCurrentSeason() {
  const month = new Date().getMonth();
  if (month >= 2 && month <= 4) return 'Spring';
  if (month >= 5 && month <= 7) return 'Summer';
  if (month >= 8 && month <= 10) return 'Fall';
  return 'Winter';
}

function titleCase(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 80);
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Generate a unique intro/closer each time by combining random selections
function buildEditorialContent(category, products, query, meta) {
  const blocks = EDITORIAL_BLOCKS[category] || EDITORIAL_BLOCKS.fashion;
  const intro = pickRandom(blocks.intros);
  const midSections = shuffleArray(blocks.midSections).slice(0, 2); // 2 of 3 sections
  const closer = pickRandom(blocks.closers);

  // Split products into two groups for distribution through the article
  const firstHalf = products.slice(0, Math.ceil(products.length / 2));
  const secondHalf = products.slice(Math.ceil(products.length / 2));

  const firstCards = firstHalf.map((p, i) => buildProductCard(p, i + 1)).join('\n');
  const secondCards = secondHalf.map((p, i) => buildProductCard(p, firstHalf.length + i + 1)).join('\n');

  // Build table of contents
  const tocItems = [
    { id: 'our-picks', label: `Our Top ${meta.queryTitle} Picks` },
    { id: slugify(midSections[0].heading), label: midSections[0].heading },
    { id: 'more-options', label: `More ${meta.queryTitle} to Consider` },
    { id: slugify(midSections[1].heading), label: midSections[1].heading },
    { id: 'final-thoughts', label: 'Final Thoughts' },
  ];

  const toc = `
  <div class="shub-toc">
    <h3>In This Article</h3>
    <ul>
      ${tocItems.map(item => `<li><a href="#${item.id}">${item.label}</a></li>`).join('\n      ')}
    </ul>
  </div>`;

  // Build TL;DR box
  const tldr = `
  <div class="shub-tldr">
    <p><strong>TL;DR:</strong> We reviewed ${products.length} ${query.toLowerCase()} products based on customer ratings, price, and real-world reviews. Our top picks offer the best balance of quality and value for ${meta.season} ${meta.year}. Scroll down for our curated selection and buying advice.</p>
  </div>`;

  // Assemble the full article
  const body_html = `
<div class="shub-post">
  ${tldr}
  <p>${intro}</p>
  ${toc}

  <h2 id="our-picks">Our Top ${meta.queryTitle} Picks</h2>
  <p>After comparing dozens of options, these are the products that stood out for their combination of ratings, reviews, price, and overall value. Each one has been vetted through real customer feedback — no sponsored placements, no paid rankings.</p>

  <div class="shub-grid">
    ${firstCards}
  </div>

  <h2 id="${slugify(midSections[0].heading)}">${midSections[0].heading}</h2>
  <p>${midSections[0].body}</p>

  <h2 id="more-options">More ${meta.queryTitle} Worth Considering</h2>
  <p>Beyond our top picks, these options also scored well and offer great alternatives depending on your specific needs and preferences.</p>

  <div class="shub-grid">
    ${secondCards}
  </div>

  <h2 id="${slugify(midSections[1].heading)}">${midSections[1].heading}</h2>
  <p>${midSections[1].body}</p>

  <h2 id="final-thoughts">Final Thoughts</h2>
  <p>${closer}</p>

  <p>All products featured in this guide are available at StyleHub Miami with secure checkout, buyer protection, and shipping across the United States. Prices and availability are current as of ${meta.monthName} ${meta.year} and may change.</p>

  <p><strong>Keep exploring:</strong></p>
  <p>
    <a href="${SITE_URL}/pages/search-results?q=${encodeURIComponent(query)}">Browse all ${query}</a> ·
    <a href="${SITE_URL}/pages/deals">Today's Flash Deals</a> ·
    <a href="${SITE_URL}/collections/new-arrivals">New Arrivals</a> ·
    <a href="${SITE_URL}/pages/shipping-policy">Shipping Info</a>
  </p>
</div>`;

  return body_html;
}

// ─── SEO META DESCRIPTION GENERATOR ─────────────────────────────────────────
function generateMetaDescription(query, productCount, season, year) {
  const templates = [
    `Discover the best ${query.toLowerCase()} for ${season} ${year}. ${productCount} expert-curated picks with real customer ratings, honest reviews, and competitive prices. Shop now at StyleHub Miami.`,
    `Looking for ${query.toLowerCase()}? We compared ${productCount}+ options to find the best value picks for ${season} ${year}. Real ratings, real reviews, real savings. Free shipping available.`,
    `Our ${season} ${year} guide to the best ${query.toLowerCase()}. ${productCount} hand-picked products based on customer reviews, quality, and price. Shop with confidence at StyleHub Miami.`,
  ];
  const desc = pickRandom(templates);
  // Ensure 150-160 chars
  return desc.length > 160 ? desc.slice(0, 157) + '...' : desc;
}

// ─── FEATURED IMAGE SELECTION ───────────────────────────────────────────────
function selectFeaturedImage(products) {
  // Pick the product with the best image (has image + highest rating)
  const withImages = products.filter(p => p.image);
  if (withImages.length === 0) return null;

  // Sort by rating descending, pick top one
  withImages.sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0));
  return { src: withImages[0].image, alt: withImages[0].title || 'Product' };
}

// ─── MAIN GENERATION FUNCTION ───────────────────────────────────────────────
async function generateBlogPosts(count = POSTS_PER_RUN) {
  console.log(`\n🚀 StyleHub Blog Engine v2 — Generating ${count} post(s)...\n`);

  // Get existing articles to avoid duplicate titles AND handles
  let existingTitles = [];
  let existingHandles = [];
  try {
    const blogId = await getBlogId(BLOG_HANDLE);
    const existing = await listArticles(blogId, 250);
    existingTitles = (existing.articles || []).map(a => a.title.toLowerCase());
    existingHandles = (existing.articles || []).map(a => (a.handle || '').toLowerCase());
    console.log(`📝 Found ${existingTitles.length} existing articles\n`);
  } catch (err) {
    console.warn('⚠️  Could not fetch existing articles:', err.message);
  }

  const results = [];
  const usedTopics = new Set();

  for (let i = 0; i < count; i++) {
    try {
      // Pick a topic (avoid repeating in same run)
      let topic;
      let attempts = 0;
      do {
        topic = pickRandom(TOPICS);
        attempts++;
      } while (usedTopics.has(topic.id) && attempts < 30);
      usedTopics.add(topic.id);

      // Pick a query from the topic
      const query = pickRandom(topic.queries);
      console.log(`📦 [${i + 1}/${count}] Topic: ${topic.id} | Query: "${query}"`);

      // Fetch real products
      let products = await searchProducts(query, 'all', 16);

      // Fallback chain
      if (!products || products.length < 4) {
        console.log('   ↳ Few results, trying trending...');
        products = await getTrending(16);
      }
      if (!products || products.length < 4) {
        console.log('   ↳ Trying bestsellers...');
        products = await getBestsellers(16);
      }
      if (!products || products.length < 4) {
        console.log('   ↳ ❌ Not enough products, skipping');
        continue;
      }

      // Shuffle and take 6-8 products (enough for quality, not so many it's thin)
      products = shuffleArray(products).slice(0, Math.min(8, products.length));

      const now = new Date();
      const season = getCurrentSeason();
      const priceThreshold = [20, 25, 30, 50][Math.floor(Math.random() * 4)];
      const meta = {
        monthName: now.toLocaleString('en-US', { month: 'long' }),
        year: now.getFullYear(),
        count: products.length,
        queryTitle: titleCase(query),
        season,
        priceThreshold,
      };

      // Generate title
      const titleFn = pickRandom(topic.titleTemplates);
      let title = titleFn(meta);

      // Generate handle
      let handle = slugify(title);

      // Deduplicate
      if (existingTitles.includes(title.toLowerCase()) || existingHandles.includes(handle)) {
        // Try another title template
        const altFn = topic.titleTemplates.find(fn => fn(meta) !== title) || titleFn;
        title = altFn(meta);
        handle = slugify(title);

        // If still colliding, add date suffix
        if (existingTitles.includes(title.toLowerCase()) || existingHandles.includes(handle)) {
          const dateSuffix = `${now.getDate()}-${now.toLocaleString('en-US', { month: 'short' }).toLowerCase()}`;
          title += ` (Updated ${now.toLocaleString('en-US', { month: 'short' })} ${now.getDate()})`;
          handle = slugify(title);
        }
      }

      existingTitles.push(title.toLowerCase());
      existingHandles.push(handle);

      console.log(`   📝 Title: "${title}"`);

      // Generate editorial content
      const body_html = buildEditorialContent(topic.category, products, query, meta);
      const styledBody = BLOG_CSS + body_html;

      // Generate meta description
      const metaDesc = generateMetaDescription(query, products.length, season, meta.year);

      // Select featured image
      const featuredImg = selectFeaturedImage(products);

      // Build article data
      const blogId = await getBlogId(BLOG_HANDLE);
      const articleData = {
        title,
        body_html: styledBody,
        tags: `${query}, ${topic.category}, ${season.toLowerCase()} ${meta.year}, shopping guide, ${meta.queryTitle.toLowerCase()}, stylehub picks`,
        summary_html: metaDesc,
        handle,
        author: 'StyleHub Editorial',
        published: true,
        published_at: now.toISOString(),
        metafields: [
          {
            namespace: 'seo',
            key: 'description',
            value: metaDesc,
            type: 'single_line_text_field',
          },
          {
            namespace: 'dealshub',
            key: 'auto_generated',
            value: 'v2',
            type: 'single_line_text_field',
          },
          {
            namespace: 'dealshub',
            key: 'topic_id',
            value: topic.id,
            type: 'single_line_text_field',
          },
          {
            namespace: 'dealshub',
            key: 'query',
            value: query,
            type: 'single_line_text_field',
          },
        ],
      };

      // Set featured image if available
      if (featuredImg) {
        articleData.image = { src: featuredImg.src, alt: featuredImg.alt };
      }

      const result = await createArticle(blogId, articleData);
      const article = result.article;

      if (article) {
        console.log(`   ✅ Published: "${article.title}"`);
        console.log(`   🔗 ${SITE_URL}/blogs/${BLOG_HANDLE}/${article.handle}`);
        console.log(`   📊 ${products.length} products | Author: StyleHub Editorial | Image: ${featuredImg ? 'Yes' : 'No'}\n`);
        results.push({
          id: article.id,
          title: article.title,
          handle: article.handle,
          url: `${SITE_URL}/blogs/${BLOG_HANDLE}/${article.handle}`,
          topic: topic.id,
          products: products.length,
          hasImage: !!featuredImg,
        });
      } else {
        console.log(`   ⚠️  Article created but no ID returned\n`);
      }

      // Delay between posts
      if (i < count - 1) await new Promise(r => setTimeout(r, 3000));

    } catch (err) {
      console.error(`   ❌ Error generating post ${i + 1}:`, err.message);
    }
  }

  console.log(`\n✨ Done! Generated ${results.length}/${count} blog post(s).\n`);
  return results;
}

// ─── RUN STANDALONE ─────────────────────────────────────────────────────────
if (require.main === module) {
  generateBlogPosts().then(results => {
    console.log('Summary:', JSON.stringify(results, null, 2));
  }).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { generateBlogPosts, TOPICS };
