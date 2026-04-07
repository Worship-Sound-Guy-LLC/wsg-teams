import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password is required' });

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    console.error('ADMIN_PASSWORD env var not set');
    return res.status(500).json({ error: 'Admin auth not configured' });
  }

  if (password !== adminPassword) {
    return res.status(401).json({ error: 'Incorrect password' });
  }

  // Generate a signed token: base64(timestamp + HMAC signature)
  // Valid for 12 hours
  const expires = Date.now() + 12 * 60 * 60 * 1000;
  const payload = expires.toString();
  const sig = crypto.createHmac('sha256', adminPassword).update(payload).digest('hex');
  const token = Buffer.from(payload + '.' + sig).toString('base64');

  return res.status(200).json({ token });
}
