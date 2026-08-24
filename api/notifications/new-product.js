const { requireCronSecret, productName, productDescription, productImage, siteUrl, sendOneSignal } = require('../_lib/notifications');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée.' });
  try {
    requireCronSecret(req);
    const { product, productId } = req.body || {};
    if (!product || typeof product !== 'object') return res.status(400).json({ error: 'Le champ product est requis.' });
    const name = productName(product);
    const message = `${name} — ${productDescription(product)}`.slice(0, 240);
    const result = await sendOneSignal({
      title: '✨ Nouvelle Arrivée chez L\'Empreinte d\'Emil !',
      message,
      image: productImage(product),
      url: `${siteUrl()}/#product/${encodeURIComponent(product.slug || productId || '')}`,
      data: { type: 'new-product', productId: productId || null }
    });
    return res.status(200).json({ ok: true, result });
  } catch (error) {
    console.error('[new-product notification]', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Erreur serveur.' });
  }
};
