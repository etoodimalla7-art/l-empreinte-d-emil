const { getDb, requireCronSecret, siteUrl, sendOneSignal } = require('../_lib/notifications');

module.exports = async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Méthode non autorisée.' });
  try {
    requireCronSecret(req);
    const snapshot = await getDb().collection('adminNotificationMessages').where('enabled', '==', true).get();
    const messages = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(item => String(item.text || item.message || '').trim());
    if (!messages.length) return res.status(200).json({ ok: true, sent: false, reason: 'Aucun message actif.' });
    const selected = messages[Math.floor(Math.random() * messages.length)];
    const result = await sendOneSignal({
      title: selected.title || 'L’Empreinte d’Emil',
      message: String(selected.text || selected.message).trim().slice(0, 240),
      image: selected.imageUrl || null,
      url: selected.url || siteUrl(),
      data: { type: 'scheduled-admin-message', messageId: selected.id }
    });
    return res.status(200).json({ ok: true, sent: true, messageId: selected.id, result });
  } catch (error) {
    console.error('[scheduled notification]', error);
    return res.status(error.statusCode || 500).json({ error: error.message || 'Erreur serveur.' });
  }
};
